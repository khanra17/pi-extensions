import { randomBytes } from "node:crypto";
import {
	closeSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

export const LIVE_QUEUE_TICK_MS = 1_000;
export const LIVE_QUEUE_STALE_MS = 8_000;

export type LiveFloorPolicy = "focus" | "fifo";
export type LiveActivationCause = "focus" | "background" | "fifo";

export interface LiveQueueMember {
	id: string;
	pid: number;
	sessionId: string;
	label: string;
	joinedAt: number;
	heartbeatAt: number;
}

interface LiveFloorClaim {
	holderId: string;
	pid: number;
	token: string;
	claimedAt: number;
}

export interface LiveFloorArbiterCallbacks {
	onActivated(cause: LiveActivationCause): void;
	onDeactivated(): void;
}

export interface LiveFloorArbiterOptions {
	pid: number;
	sessionId: string;
	cwd: string;
	policy: LiveFloorPolicy;
	directory?: string;
	now?: () => number;
	isProcessAlive?: (pid: number) => boolean;
}

export interface LiveFloorArbiterLike {
	readonly id: string;
	readonly label: string;
	readonly policy: LiveFloorPolicy;
	readonly hasFloor: boolean;
	join(): void;
	leave(): void;
	tick(): void;
	setFocused(focused: boolean): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveAgentDir(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	return configured.startsWith("~") ? join(homedir(), configured.slice(2)) : configured;
}

export function liveQueueDirectory(agentDir = resolveAgentDir()): string {
	return join(agentDir, "live-queue");
}

export function liveQueueLabel(cwd: string, sessionId: string): string {
	const folder = basename(cwd) || cwd;
	return `${folder} · ${sessionId.slice(0, 8)}`;
}

export function defaultIsProcessAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (cause) {
		return (
			typeof cause === "object" &&
			cause !== null &&
			(cause as NodeJS.ErrnoException).code === "EPERM"
		);
	}
}

function sanitizeId(id: string): string {
	return id.replace(/[^a-zA-Z0-9._-]/gu, "_");
}

function parseMember(value: unknown): LiveQueueMember | undefined {
	if (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.pid === "number" &&
		typeof value.sessionId === "string" &&
		typeof value.joinedAt === "number" &&
		typeof value.heartbeatAt === "number"
	) {
		return {
			id: value.id,
			pid: value.pid,
			sessionId: value.sessionId,
			label: typeof value.label === "string" ? value.label : value.id,
			joinedAt: value.joinedAt,
			heartbeatAt: value.heartbeatAt,
		};
	}
	return undefined;
}

function parseClaim(value: unknown): LiveFloorClaim | undefined {
	if (
		isRecord(value) &&
		typeof value.holderId === "string" &&
		typeof value.pid === "number" &&
		typeof value.token === "string" &&
		typeof value.claimedAt === "number"
	) {
		return {
			holderId: value.holderId,
			pid: value.pid,
			token: value.token,
			claimedAt: value.claimedAt,
		};
	}
	return undefined;
}

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJsonAtomic(file: string, value: unknown): void {
	const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temporary, JSON.stringify(value));
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

/** File-backed cross-process microphone ownership for multiple Pi windows. */
export class LiveFloorArbiter implements LiveFloorArbiterLike {
	private readonly directory: string;
	private readonly memberFile: string;
	private readonly floorFile: string;
	private readonly pid: number;
	private readonly sessionId: string;
	private readonly now: () => number;
	private readonly isProcessAlive: (pid: number) => boolean;
	private readonly callbacks: LiveFloorArbiterCallbacks;
	private readonly memberId: string;
	private readonly memberLabel: string;
	private readonly floorPolicy: LiveFloorPolicy;
	private readonly token: string;
	private joinedValue = false;
	private joinedAt = 0;
	private focusedValue: boolean | undefined;
	private floor = false;

	constructor(options: LiveFloorArbiterOptions, callbacks: LiveFloorArbiterCallbacks) {
		this.directory = options.directory ?? liveQueueDirectory();
		this.pid = options.pid;
		this.sessionId = options.sessionId;
		this.memberLabel = liveQueueLabel(options.cwd, options.sessionId);
		this.floorPolicy = options.policy;
		this.now = options.now ?? Date.now;
		this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
		this.callbacks = callbacks;
		this.memberId = `${options.pid}-${options.sessionId}`;
		this.token = `${options.pid}-${randomBytes(6).toString("hex")}`;
		this.memberFile = join(this.directory, "members", `${sanitizeId(this.memberId)}.json`);
		this.floorFile = join(this.directory, "floor.json");
	}

	get id(): string {
		return this.memberId;
	}

	get label(): string {
		return this.memberLabel;
	}

	get policy(): LiveFloorPolicy {
		return this.floorPolicy;
	}

	get hasFloor(): boolean {
		return this.floor;
	}

	get joined(): boolean {
		return this.joinedValue;
	}

	get focused(): boolean | undefined {
		return this.focusedValue;
	}

	join(): void {
		if (this.joinedValue) return;
		try {
			mkdirSync(join(this.directory, "members"), { recursive: true });
		} catch {
			// The next tick retries; this keeps the overlay usable if the directory is transiently locked.
		}
		this.joinedValue = true;
		this.joinedAt = this.now();
		this.writeMember();
		this.tick();
	}

	leave(): void {
		if (!this.joinedValue) return;
		this.joinedValue = false;
		this.releaseFloor();
		rmSync(this.memberFile, { force: true });
	}

	setFocused(focused: boolean): void {
		this.focusedValue = focused;
		this.evaluate();
	}

	tick(): void {
		if (!this.joinedValue) return;
		this.writeMember();
		this.sweep();
		this.evaluate();
	}

	private writeMember(): void {
		const member: LiveQueueMember = {
			id: this.memberId,
			pid: this.pid,
			sessionId: this.sessionId,
			label: this.memberLabel,
			joinedAt: this.joinedAt,
			heartbeatAt: this.now(),
		};
		try {
			mkdirSync(join(this.directory, "members"), { recursive: true });
			writeJsonAtomic(this.memberFile, member);
		} catch {
			// A wiped or locked directory is recovered on the next heartbeat.
		}
	}

	private readMembers(): LiveQueueMember[] {
		let files: string[];
		try {
			files = readdirSync(join(this.directory, "members"));
		} catch {
			return [];
		}
		const members: LiveQueueMember[] = [];
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const member = parseMember(readJson(join(this.directory, "members", file)));
			if (member) members.push(member);
		}
		members.sort((a, b) => a.joinedAt - b.joinedAt || a.id.localeCompare(b.id));
		return members;
	}

	private readClaim(): LiveFloorClaim | undefined {
		return parseClaim(readJson(this.floorFile));
	}

	private memberAlive(member: LiveQueueMember): boolean {
		if (member.pid === this.pid) return true;
		if (!this.isProcessAlive(member.pid)) return false;
		return this.now() - member.heartbeatAt <= LIVE_QUEUE_STALE_MS;
	}

	private sweep(): void {
		let files: string[];
		try {
			files = readdirSync(join(this.directory, "members"));
		} catch {
			return;
		}
		for (const file of files) {
			if (!file.endsWith(".json")) continue;
			const path = join(this.directory, "members", file);
			const member = parseMember(readJson(path));
			if (!member || (member.pid !== this.pid && !this.memberAlive(member))) rmSync(path, { force: true });
		}
	}

	private evaluate(): void {
		const now = this.now();
		const aliveMembers = this.readMembers().filter((member) => this.memberAlive(member));
		const claim = this.readClaim();
		const holderAlive =
			claim !== undefined &&
			(claim.pid === this.pid || this.isProcessAlive(claim.pid)) &&
			aliveMembers.some(
				(member) => member.id === claim.holderId && now - member.heartbeatAt <= LIVE_QUEUE_STALE_MS,
			);

		if (this.floor) {
			if (!this.joinedValue || claim?.token !== this.token || claim.holderId !== this.memberId) {
				this.floor = false;
				this.callbacks.onDeactivated();
			}
			return;
		}

		if (claim && holderAlive) {
			if (this.floorPolicy === "focus" && this.focusedValue === true && claim.holderId !== this.memberId) {
				this.claim("focus", true);
			}
			return;
		}
		if (claim && !holderAlive) rmSync(this.floorFile, { force: true });
		if (this.floorPolicy === "fifo") {
			if (aliveMembers[0]?.id === this.memberId) this.claim("fifo", false);
			return;
		}
		if (this.focusedValue !== false) this.claim(this.focusedValue === true ? "focus" : "background", false);
	}

	private claim(cause: LiveActivationCause, preempt: boolean): void {
		const claim: LiveFloorClaim = {
			holderId: this.memberId,
			pid: this.pid,
			token: this.token,
			claimedAt: this.now(),
		};
		try {
			if (preempt) {
				writeJsonAtomic(this.floorFile, claim);
			} else {
				const fd = openSync(this.floorFile, "wx");
				try {
					writeFileSync(fd, JSON.stringify(claim));
				} finally {
					closeSync(fd);
				}
			}
		} catch {
			return;
		}
		if (this.readClaim()?.token !== this.token) return;
		this.floor = true;
		this.callbacks.onActivated(cause);
	}

	private releaseFloor(): void {
		const wasHolding = this.floor;
		this.floor = false;
		if (this.readClaim()?.token === this.token) rmSync(this.floorFile, { force: true });
		if (wasHolding) this.callbacks.onDeactivated();
	}
}
