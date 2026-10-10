import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	AudioPlayer,
	AudioPlayerCallbacks,
	PlayerSnapshot,
} from "./audio-player.ts";

const DEFAULT_SNAPSHOT: PlayerSnapshot = {
	timePos: 0,
	paused: false,
	idleActive: true,
};
const COMMAND_TIMEOUT_MS = 3_000;
const CONNECT_TIMEOUT_MS = 5_000;
const POSITION_UPDATE_INTERVAL_MS = 100;

interface PendingCommand {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/** Full-featured external playback through mpv's JSON IPC. */
export class MpvAudioPlayer implements AudioPlayer {
	private child: ChildProcess | undefined;
	private socket: Socket | undefined;
	private ipcPath: string | undefined;
	private directory: string | undefined;
	private startPromise: Promise<void> | undefined;
	private snapshot: PlayerSnapshot = { ...DEFAULT_SNAPSHOT };
	private readBuffer = "";
	private loadedItems = 0;
	private requestId = 0;
	private speed = 1;
	private volume = 100;
	private paused = false;
	private stopping = false;
	private positionUpdateTimer: ReturnType<typeof setTimeout> | undefined;
	private lastPositionUpdateAt = 0;
	private readonly directoryCleanups = new Set<Promise<void>>();
	private readonly pending = new Map<number, PendingCommand>();

	constructor(private readonly callbacks: AudioPlayerCallbacks = {}) {}

	get state(): PlayerSnapshot {
		return { ...this.snapshot };
	}

	async start(): Promise<void> {
		if (this.running) return;
		if (this.startPromise) return this.startPromise;
		const start = this.startProcess();
		this.startPromise = start;
		try {
			await start;
		} finally {
			if (this.startPromise === start) this.startPromise = undefined;
		}
	}

	async reset(): Promise<void> {
		this.cancelPositionUpdate();
		this.loadedItems = 0;
		this.snapshot = { ...DEFAULT_SNAPSHOT };
		// Dispatch stop immediately but do not wait for its acknowledgement before
		// preparing the next message. IPC preserves command order, and waiting here
		// can make previous/next feel blocked for the full command timeout.
		if (this.running) this.control(["stop"]);
		this.emitUpdate();
		await this.rotateDirectory();
	}

	async queueAudio(audio: Uint8Array): Promise<number> {
		await this.start();
		if (!this.running || !this.directory) throw new Error("mpv is unavailable");
		const index = this.loadedItems;
		const path = join(
			this.directory,
			`${String(index).padStart(5, "0")}.mp3`,
		);
		await writeFile(path, audio);
		await this.command([
			"loadfile",
			path,
			index === 0 ? "replace" : "append-play",
		]);
		this.loadedItems += 1;
		this.snapshot.fileIndex ??= 0;
		this.snapshot.idleActive = false;
		this.emitUpdate();
		return estimateDuration(audio.byteLength);
	}

	setPaused(paused: boolean): void {
		if (this.paused === paused) return;
		this.paused = paused;
		this.snapshot.paused = paused;
		// Write the IPC command before callbacks can trigger a costly transcript
		// render; audible pause latency takes priority over UI acknowledgement.
		this.control(["set_property", "pause", paused]);
		this.emitUpdate();
	}

	setSpeed(speed: number): void {
		if (!Number.isFinite(speed) || this.speed === speed) return;
		this.speed = speed;
		this.control(["set_property", "speed", speed]);
	}

	setVolume(volume: number): void {
		if (!Number.isFinite(volume) || this.volume === volume) return;
		this.volume = volume;
		this.control(["set_property", "volume", volume]);
	}

	seek(seconds: number): void {
		this.control(["seek", seconds, "relative", "exact"]);
	}

	async dispose(): Promise<void> {
		if (this.startPromise) await this.startPromise.catch(() => undefined);
		this.stopping = true;
		if (this.running) await this.command(["quit"]).catch(() => undefined);
		const child = this.child;
		if (child && child.exitCode === null && child.signalCode === null) {
			if (!(await waitForExit(child, 750))) {
				child.kill();
				await waitForExit(child, 750);
			}
		}
		this.cancelPositionUpdate();
		this.rejectPending(new Error("mpv is shutting down"));
		this.socket?.destroy();
		this.socket = undefined;
		this.child = undefined;
		await this.removeIpcPath();
		await this.removeDirectory();
		await Promise.allSettled(this.directoryCleanups);
		this.snapshot = { ...DEFAULT_SNAPSHOT };
	}

	private get running(): boolean {
		return Boolean(
			this.child &&
				this.child.exitCode === null &&
				this.child.signalCode === null &&
				this.socket &&
				!this.socket.destroyed &&
				!this.stopping,
		);
	}

	private async startProcess(): Promise<void> {
		const command = await findMpv();
		this.stopping = false;
		this.ipcPath = createIpcPath();
		await this.rotateDirectory();
		const child = spawn(
			command,
			[
				"--no-config",
				"--no-video",
				"--really-quiet",
				"--idle=yes",
				"--force-window=no",
				"--audio-display=no",
				"--terminal=no",
				"--audio-pitch-correction=yes",
				"--gapless-audio=yes",
				"--prefetch-playlist=yes",
				"--demuxer-readahead-secs=20",
				"--audio-buffer=0.05",
				`--input-ipc-server=${this.ipcPath}`,
			],
			{ stdio: ["ignore", "ignore", "pipe"], windowsHide: true },
		);
		this.child = child;
		child.stderr?.resume();
		child.once("error", (error) => this.handleFailure(error, child));
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			const expected = this.stopping;
			this.markStopped(child);
			if (!expected)
				this.callbacks.onError?.(
					new Error(
						`mpv exited${code === null ? ` (${signal ?? "unknown"})` : ` with code ${code}`}`,
					),
				);
		});

		try {
			const socket = await connectIpc(this.ipcPath, child);
			if (this.child !== child || this.stopping) {
				socket.destroy();
				throw new Error("mpv startup was cancelled");
			}
			this.socket = socket;
			this.configureSocket(socket);
			await Promise.all([
				this.command(["observe_property", 1, "time-pos"]),
				this.command(["observe_property", 2, "duration"]),
				this.command(["observe_property", 3, "pause"]),
				this.command(["observe_property", 4, "idle-active"]),
				this.command(["observe_property", 5, "playlist-pos"]),
			]);
		} catch (error) {
			this.stopping = true;
			if (child.exitCode === null && child.signalCode === null) child.kill();
			this.markStopped(child);
			await this.removeIpcPath();
			await this.removeDirectory();
			throw error;
		}
	}

	private configureSocket(socket: Socket): void {
		socket.setEncoding("utf8");
		socket.on("data", (data: string | Buffer) =>
			this.handleData(data.toString()),
		);
		socket.on("error", (error) => {
			if (this.socket !== socket || this.stopping) return;
			this.callbacks.onError?.(error);
		});
		socket.on("close", () => {
			if (this.socket !== socket) return;
			this.socket = undefined;
			this.rejectPending(new Error("mpv IPC connection closed"));
		});
	}

	private command(command: unknown[]): Promise<void> {
		const socket = this.socket;
		if (!socket || socket.destroyed || this.stopping)
			return Promise.reject(new Error("mpv is not running"));
		const id = ++this.requestId;
		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`mpv command timed out: ${String(command[0])}`));
			}, COMMAND_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timer });
			socket.write(`${JSON.stringify({ command, request_id: id })}\n`, (error) => {
				if (!error) return;
				const pending = this.pending.get(id);
				if (!pending) return;
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(error);
			});
		});
	}

	private control(command: unknown[]): void {
		if (!this.running) return;
		// Live controls are best-effort. A lost acknowledgement must not abort
		// otherwise healthy playback; process/socket failures are reported separately.
		void this.command(command).catch(() => undefined);
	}

	private handleData(data: string): void {
		this.readBuffer += data;
		while (true) {
			const newline = this.readBuffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.readBuffer.slice(0, newline).trim();
			this.readBuffer = this.readBuffer.slice(newline + 1);
			if (!line) continue;
			try {
				this.handleMessage(JSON.parse(line) as unknown);
			} catch {
				// Ignore non-JSON diagnostics.
			}
		}
	}

	private handleMessage(value: unknown): void {
		if (!isRecord(value)) return;
		if (typeof value.request_id === "number") {
			const pending = this.pending.get(value.request_id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(value.request_id);
				if (value.error === "success") pending.resolve();
				else pending.reject(new Error(`mpv command failed: ${String(value.error)}`));
			}
		}
		if (value.event === "idle") {
			this.snapshot.idleActive = true;
			this.emitUpdate();
			if (this.loadedItems > 0) this.callbacks.onIdle?.();
		}
		if (value.event !== "property-change") return;
		const name = typeof value.name === "string" ? value.name : "";
		const data = value.data;
		let positionOnly = false;
		switch (name) {
			case "time-pos":
				if (typeof data === "number") {
					this.snapshot.timePos = data;
					positionOnly = true;
				}
				break;
			case "duration":
				if (typeof data === "number") this.snapshot.duration = data;
				break;
			case "pause":
				if (typeof data === "boolean") this.snapshot.paused = data;
				break;
			case "idle-active":
				if (typeof data === "boolean") this.snapshot.idleActive = data;
				break;
			case "playlist-pos":
				if (typeof data === "number" && data !== this.snapshot.fileIndex) {
					this.snapshot.fileIndex = data;
					this.snapshot.timePos = 0;
					this.snapshot.audioTimePos = undefined;
					this.snapshot.duration = undefined;
				} else if (data === null) this.snapshot.fileIndex = undefined;
				break;
			default:
				return;
		}
		if (positionOnly) this.schedulePositionUpdate();
		else this.emitUpdate();
	}

	private schedulePositionUpdate(): void {
		const elapsed = performance.now() - this.lastPositionUpdateAt;
		if (elapsed >= POSITION_UPDATE_INTERVAL_MS) {
			this.lastPositionUpdateAt = performance.now();
			this.emitUpdate();
			return;
		}
		if (this.positionUpdateTimer) return;
		this.positionUpdateTimer = setTimeout(() => {
			this.positionUpdateTimer = undefined;
			this.lastPositionUpdateAt = performance.now();
			this.emitUpdate();
		}, POSITION_UPDATE_INTERVAL_MS - elapsed);
		this.positionUpdateTimer.unref?.();
	}

	private cancelPositionUpdate(): void {
		if (this.positionUpdateTimer) clearTimeout(this.positionUpdateTimer);
		this.positionUpdateTimer = undefined;
		this.lastPositionUpdateAt = 0;
	}

	private handleFailure(error: Error, child: ChildProcess): void {
		if (this.child !== child) return;
		const expected = this.stopping;
		this.markStopped(child);
		if (!expected) this.callbacks.onError?.(error);
	}

	private markStopped(child: ChildProcess): void {
		if (this.child !== child) return;
		this.cancelPositionUpdate();
		this.child = undefined;
		this.socket?.destroy();
		this.socket = undefined;
		this.rejectPending(new Error("mpv stopped"));
		child.stderr?.destroy();
	}

	private rejectPending(error: Error): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private async rotateDirectory(): Promise<void> {
		const previous = this.directory;
		this.directory = await mkdtemp(join(tmpdir(), "pi-edge-tts-mpv-"));
		if (previous) this.queueDirectoryRemoval(previous);
	}

	private async removeDirectory(): Promise<void> {
		const directory = this.directory;
		this.directory = undefined;
		if (!directory) return;
		await removeDirectoryPath(directory);
	}

	private queueDirectoryRemoval(directory: string): void {
		let cleanup!: Promise<void>;
		cleanup = removeDirectoryPath(directory).finally(() => {
			this.directoryCleanups.delete(cleanup);
		});
		this.directoryCleanups.add(cleanup);
	}

	private async removeIpcPath(): Promise<void> {
		const path = this.ipcPath;
		this.ipcPath = undefined;
		if (!path || process.platform === "win32") return;
		await rm(path, { force: true }).catch(() => undefined);
	}

	private emitUpdate(): void {
		this.callbacks.onUpdate?.(this.state);
	}
}

async function removeDirectoryPath(directory: string): Promise<void> {
	await rm(directory, {
		recursive: true,
		force: true,
		maxRetries: 8,
		retryDelay: 100,
	}).catch(() => undefined);
}

let cachedCommand: string | undefined;

export async function findMpv(): Promise<string> {
	if (cachedCommand && (await canRun(cachedCommand))) return cachedCommand;
	const candidates = [
		process.env.PI_TTS_MPV,
		process.platform === "win32" && process.env.ProgramFiles
			? join(process.env.ProgramFiles, "MPV", "mpv.exe")
			: undefined,
		process.platform === "win32" && process.env.LOCALAPPDATA
			? join(process.env.LOCALAPPDATA, "Programs", "mpv", "mpv.exe")
			: undefined,
		process.platform === "win32" ? "mpv.exe" : "mpv",
	].filter((candidate): candidate is string => Boolean(candidate));
	for (const candidate of [...new Set(candidates)]) {
		if (await canRun(candidate)) {
			cachedCommand = candidate;
			return candidate;
		}
	}
	throw new Error("mpv was not found");
}

function canRun(command: string): Promise<boolean> {
	return new Promise((resolve) => {
		const child = spawn(command, ["--version"], {
			stdio: "ignore",
			windowsHide: true,
		});
		let settled = false;
		const finish = (result: boolean): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(result);
		};
		const timer = setTimeout(() => {
			child.kill();
			finish(false);
		}, COMMAND_TIMEOUT_MS);
		child.once("error", () => finish(false));
		child.once("exit", (code) => finish(code === 0));
	});
}

function createIpcPath(): string {
	const id = randomUUID();
	return process.platform === "win32"
		? `\\\\.\\pipe\\pi-edge-tts-${id}`
		: join(process.env.TMPDIR ?? "/tmp", `pi-edge-tts-${id}.sock`);
}

function connectIpc(path: string, child: ChildProcess): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const finish = (error?: Error, socket?: Socket): void => {
			if (settled) {
				socket?.destroy();
				return;
			}
			settled = true;
			if (timer) clearTimeout(timer);
			child.off("error", onError);
			child.off("exit", onExit);
			if (error) reject(error);
			else if (socket) resolve(socket);
			else reject(new Error("Could not connect to mpv IPC"));
		};
		const onError = (error: Error): void => finish(error);
		const onExit = (code: number | null): void =>
			finish(new Error(`mpv exited before IPC was ready (${code ?? "signal"})`));
		child.once("error", onError);
		child.once("exit", onExit);
		const attempt = (): void => {
			if (Date.now() >= deadline) {
				finish(new Error("Timed out connecting to mpv IPC"));
				return;
			}
			const socket = createConnection(path);
			socket.once("connect", () => finish(undefined, socket));
			socket.once("error", () => {
				socket.destroy();
				if (!settled) timer = setTimeout(attempt, 50);
			});
		};
		attempt();
	});
}

function waitForExit(child: ChildProcess, milliseconds: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			child.off("exit", onExit);
			resolve(false);
		}, milliseconds);
		const onExit = (): void => {
			clearTimeout(timer);
			resolve(true);
		};
		child.once("exit", onExit);
	});
}

function estimateDuration(bytes: number): number {
	return Math.max(0.1, bytes / 6_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
