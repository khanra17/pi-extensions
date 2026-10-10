import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	matchesKey,
	type TuiInputListener,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	EdgeReadAloudController,
	ReaderSnapshot,
} from "./read-aloud-controller.ts";

/** Structural subset of pi-tui 1.1 normalized mouse events; keeps older SDKs usable. */
type TuiMouseEvent = { type: string; button: string; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean };
type TuiMouseEventResult = { handled?: boolean; render?: boolean };

export type PanelResult = "close" | "voice";
export interface MessageNavigationState {
	index: number;
	total: number;
	role?: "user" | "assistant";
	phase?: "commentary" | "final";
}

export interface MessageNavigation {
	getState(): MessageNavigationState;
	previous(): void;
	next(): void;
}

type RenderRequester = {
	requestRender(): void;
	invalidate?(): void;
	mode?: "regular" | "fullscreen";
	terminal?: { columns: number; rows: number };
	/** Public fullscreen viewport methods; no dependency state is modified. */
	scrollBy?(lines: number): void;
	addInputListener?(listener: TuiInputListener): () => void;
};

type PanelAction =
	| "close"
	| "toggle-playback"
	| "seek-backward"
	| "seek-forward"
	| "previous-message"
	| "next-message"
	| "volume-up"
	| "volume-down"
	| "speed-up"
	| "speed-down"
	| "normal-speed"
	| "replay"
	| "stop"
	| "mute"
	| "toggle-auto"
	| "toggle-code"
	| "toggle-highlight"
	| "voice"
	| "toggle-help";

const PANEL_RENDER_INTERVAL_MS = 100;

/** Compact keyboard-driven player shown by /tts and Ctrl+Alt+V. */
export class EdgeReadAloudPanel {
	private snapshot: ReaderSnapshot;
	private readonly unsubscribe: () => void;
	private readonly scheduler: RenderThrottle;
	private showHelp = false;
	private closed = false;
	private removeScrollInput?: () => void;
	private hitRegions: Array<{ row: number; start: number; end: number; action: PanelAction }> = [];

	constructor(
		private readonly tui: RenderRequester,
		private readonly theme: Theme,
		private readonly reader: EdgeReadAloudController,
		private readonly onClose: (result: PanelResult) => void,
		private readonly navigation?: MessageNavigation,
		private readonly isFocused: () => boolean = () => true,
		private readonly onStop?: () => void,
	) {
		this.snapshot = reader.snapshot;
		if (tui.mode === "fullscreen" && tui.scrollBy && tui.addInputListener) {
			this.removeScrollInput = tui.addInputListener(data => {
				if (this.closed || !this.isFocused()) return;
				const match = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
				const code = match ? Number(match[1]) : 0;
				if (!(code & 64) || (code & 3) > 1) return;
				tui.scrollBy!((code & 1 ? 1 : -1) * (code & 8 ? 5 : 1));
				tui.requestRender();
				return { consume: true };
			});
		}
		this.scheduler = new RenderThrottle(tui, PANEL_RENDER_INTERVAL_MS);
		this.unsubscribe = reader.subscribe((snapshot) => {
			const immediate = snapshot.status !== this.snapshot.status;
			this.snapshot = snapshot;
			this.scheduler.request(immediate);
		});
	}

	handleInput(data: string): void {
		if (this.closed) return;
		const action = resolvePanelAction(data);
		if (action) this.perform(action);
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.closed || event.type !== "click" || event.button !== "left" || event.shift || event.alt || event.ctrl) return;
		const hit = this.hitRegions.find(region => region.row === event.y && event.x >= region.start && event.x < region.end);
		if (!hit) return;
		this.perform(hit.action);
		return { handled: true, render: true };
	}

	render(width: number): string[] {
		this.hitRegions = [];
		if (width < 12)
			return [truncateToWidth("Edge TTS", Math.max(1, width), "")];

		const card = new PanelCard(width, this.theme);
		card.top();
		card.row(
			alignColumns(
				this.theme.fg("accent", this.theme.bold("Edge TTS")),
				this.theme.fg(statusColor(this.snapshot), statusLabel(this.snapshot)),
				card.innerWidth,
			),
		);
		card.row(this.renderMessageRow(card.innerWidth));
		card.row(this.renderProgressRow(card.innerWidth));
		if (this.snapshot.error) {
			card.row(this.theme.fg("error", singleLine(this.snapshot.error)));
		}
		card.separator();
		card.row(this.renderSettingsRow());
		this.controlRow(card, [
			["Space", playbackAction(this.snapshot)],
			["B", "prev"], ["N", "next"],
			["?", this.showHelp ? "less" : "help"], ["Esc", "close"],
		]);

		if (this.showHelp) {
			card.separator();
			for (const controls of HELP_ROWS) {
				this.controlRow(card, controls);
			}
		}
		card.bottom();
		return card.lines;
	}

	invalidate(): void {
		// All visual state comes from the latest immutable reader snapshot.
	}

	dispose(): void {
		this.closed = true;
		this.scheduler.dispose();
		this.removeScrollInput?.();
		this.unsubscribe();
	}

	private controlRow(card: PanelCard, controls: ReadonlyArray<readonly [string, string]>): void {
		let start = 2;
		for (const [key, description] of controls) {
			const size = visibleWidth(`${key} ${description}`);
			const data = key === "Space" ? " " : key === "Esc" ? "\x1b" : key === "B/N" ? "b" : key === "←/→" ? "\x1b[D" : key === "↑/↓" ? "\x1b[A" : key === "-/+" ? "-" : key;
			const action = resolvePanelAction(data);
			const alternate: PanelAction | undefined = key === "B/N" ? "next-message" : key === "←/→" ? "seek-forward" : key === "↑/↓" ? "volume-down" : key === "-/+" ? "speed-up" : undefined;
			const end = Math.min(start + size, card.innerWidth + 2);
			const midpoint = start + Math.ceil(size / 2);
			if (action && start < end) {
				this.hitRegions.push({ row: card.lines.length, start, end: alternate ? Math.min(midpoint, end) : end, action });
				if (alternate && midpoint < end) this.hitRegions.push({ row: card.lines.length, start: midpoint, end, action: alternate });
			}
			start += size + 3;
		}
		card.row(controlLine(this.theme, controls));
	}

	private perform(action: PanelAction): void {
		switch (action) {
			case "close":
				this.close("close");
				break;
			case "toggle-playback":
				this.reader.togglePause();
				break;
			case "seek-backward":
				this.reader.seek(-5);
				break;
			case "seek-forward":
				this.reader.seek(5);
				break;
			case "previous-message":
				this.navigation?.previous();
				break;
			case "next-message":
				this.navigation?.next();
				break;
			case "volume-up":
				this.reader.adjustVolume(5);
				break;
			case "volume-down":
				this.reader.adjustVolume(-5);
				break;
			case "speed-up":
				this.reader.adjustSpeed(0.1);
				break;
			case "speed-down":
				this.reader.adjustSpeed(-0.1);
				break;
			case "normal-speed":
				this.reader.setSpeed(1);
				break;
			case "replay":
				this.reader.replay();
				break;
			case "stop":
				this.onStop?.();
				void this.reader.stop();
				break;
			case "mute":
				this.reader.toggleMute();
				break;
			case "toggle-auto":
				this.reader.toggleAutoPlay();
				if (!this.reader.settingsSnapshot.autoPlay) this.onStop?.();
				break;
			case "toggle-code":
				this.reader.toggleReadCode();
				break;
			case "toggle-highlight":
				this.reader.toggleHighlight();
				break;
			case "voice":
				this.close("voice");
				break;
			case "toggle-help":
				this.showHelp = !this.showHelp;
				this.tui.requestRender();
				break;
		}
	}

	private renderMessageRow(width: number): string {
		const voice = this.theme.fg("text", shortVoiceName(this.snapshot.voice));
		const navigation = this.navigation?.getState();
		const message = navigation?.total
			? `${navigation.role === "user" ? "Your message" : navigation.phase === "commentary" ? "Working update" : navigation.phase === "final" ? "Final reply" : "Assistant"} ${navigation.index}/${navigation.total}`
			: "No message";
		return alignColumns(voice, this.theme.fg("muted", message), width);
	}

	private renderProgressRow(width: number): string {
		const percent = `${Math.round(this.snapshot.overallProgress * 100)}%`;
		const estimated = this.snapshot.durationEstimated ? "~" : "";
		const time = `${formatTime(this.snapshot.overallTimePos)}/${estimated}${formatTime(this.snapshot.overallDuration)}`;
		const suffix = `${percent}  ${time}`;
		const barWidth = Math.max(4, width - visibleWidth(suffix) - 2);
		return `${renderProgressBar(this.snapshot.overallProgress, barWidth, this.theme)}  ${this.theme.fg("text", suffix)}`;
	}

	private renderSettingsRow(): string {
		const divider = this.theme.fg("borderMuted", " · ");
		const speed = this.theme.fg("accent", `${this.snapshot.speed.toFixed(1)}×`);
		const volume = this.snapshot.muted
			? this.theme.fg("warning", "Muted")
			: this.theme.fg("text", `${this.snapshot.volume}%`);
		const auto = toggleValue(this.theme, "Auto", this.snapshot.autoPlay);
		const code = this.theme.fg(
			this.snapshot.readCode ? "success" : "muted",
			this.snapshot.readCode ? "Code speak" : "Code skip",
		);
		const highlight = toggleValue(
			this.theme,
			"Highlight",
			this.snapshot.highlightEnabled,
		);
		return [speed, volume, auto, code, highlight].join(divider);
	}

	private close(result: PanelResult): void {
		if (this.closed) return;
		this.closed = true;
		this.onClose(result);
	}
}

class RenderThrottle {
	private lastRenderAt = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private disposed = false;

	constructor(
		private readonly tui: RenderRequester,
		private readonly intervalMs: number,
	) {}

	request(immediate: boolean): void {
		if (this.disposed) return;
		const delay = this.intervalMs - (performance.now() - this.lastRenderAt);
		if (immediate || delay <= 0) {
			this.flush();
			return;
		}
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			this.flush();
		}, delay);
		this.timer.unref?.();
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
	}

	private flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		if (this.disposed) return;
		this.lastRenderAt = performance.now();
		this.tui.requestRender();
	}
}

class PanelCard {
	readonly lines: string[] = [];
	readonly innerWidth: number;

	constructor(
		private readonly width: number,
		private readonly theme: Theme,
	) {
		this.innerWidth = Math.max(1, width - 4);
	}

	top(): void {
		this.lines.push(this.border("╭", "╮", "borderAccent"));
	}

	bottom(): void {
		this.lines.push(this.border("╰", "╯", "borderAccent"));
	}

	separator(): void {
		this.lines.push(this.border("├", "┤", "borderMuted"));
	}

	row(content: string): void {
		if (this.width < 5) {
			this.lines.push(truncateToWidth(content, this.width, ""));
			return;
		}
		const fitted = truncateToWidth(content, this.innerWidth, "");
		this.lines.push(
			`│ ${fitted}${" ".repeat(Math.max(0, this.innerWidth - visibleWidth(fitted)))} │`,
		);
	}

	private border(
		left: string,
		right: string,
		color: Parameters<Theme["fg"]>[0],
	): string {
		return this.theme.fg(
			color,
			`${left}${"─".repeat(Math.max(0, this.width - 2))}${right}`,
		);
	}
}

const HELP_ROWS: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
	[
		["Space", "pause/play"],
		["←/→", "seek"],
		["R", "replay"],
		["X", "stop"],
	],
	[
		["B/N", "messages"],
		["V", "voice"],
	],
	[
		["↑/↓", "volume"],
		["-/+", "speed"],
		["0", "normal"],
		["M", "mute"],
	],
	[
		["A", "auto"],
		["C", "code"],
		["H", "highlight"],
		["?", "less"],
		["Esc", "close"],
	],
];

function resolvePanelAction(data: string): PanelAction | undefined {
	if (matchesKey(data, "escape") || data === "q" || data === "Q") return "close";
	if (
		matchesKey(data, "space") ||
		matchesKey(data, "enter") ||
		data === "p" ||
		data === "P"
	)
		return "toggle-playback";
	if (matchesKey(data, "left")) return "seek-backward";
	if (matchesKey(data, "right")) return "seek-forward";
	if (matchesKey(data, "up") || data === ">") return "volume-up";
	if (matchesKey(data, "down") || data === "<") return "volume-down";
	if (data === "[" || data === "-") return "speed-down";
	if (data === "]" || data === "+" || data === "=") return "speed-up";
	if (data === "0") return "normal-speed";

	switch (data.toLowerCase()) {
		case "b":
			return "previous-message";
		case "n":
			return "next-message";
		case "r":
			return "replay";
		case "x":
			return "stop";
		case "m":
			return "mute";
		case "a":
			return "toggle-auto";
		case "c":
			return "toggle-code";
		case "h":
			return "toggle-highlight";
		case "v":
			return "voice";
		case "?":
			return "toggle-help";
		default:
			return undefined;
	}
}

function controlLine(
	theme: Theme,
	controls: ReadonlyArray<readonly [string, string]>,
): string {
	return controls
		.map(
			([key, description]) =>
				`${theme.fg("accent", theme.bold(key))} ${theme.fg("dim", description)}`,
		)
		.join(theme.fg("borderMuted", " · "));
}

function renderProgressBar(progress: number, width: number, theme: Theme): string {
	const safeWidth = Math.max(1, width);
	const filled = Math.round(clamp(progress, 0, 1) * safeWidth);
	return (
		theme.fg("accent", "━".repeat(filled)) +
		theme.fg("borderMuted", "─".repeat(Math.max(0, safeWidth - filled)))
	);
}

function alignColumns(left: string, right: string, width: number): string {
	const safeWidth = Math.max(1, width);
	const rightWidth = visibleWidth(right);
	const leftWidth = Math.max(1, safeWidth - rightWidth - 2);
	const fittedLeft = truncateToWidth(left, leftWidth, "…");
	const fittedRight = truncateToWidth(
		right,
		Math.max(1, safeWidth - visibleWidth(fittedLeft) - 1),
		"…",
	);
	const gap = " ".repeat(
		Math.max(1, safeWidth - visibleWidth(fittedLeft) - visibleWidth(fittedRight)),
	);
	return `${fittedLeft}${gap}${fittedRight}`;
}

function toggleValue(theme: Theme, label: string, enabled: boolean): string {
	return theme.fg(enabled ? "success" : "muted", `${label} ${enabled ? "on" : "off"}`);
}

function playbackAction(snapshot: ReaderSnapshot): string {
	if (snapshot.status === "paused") return "resume";
	if (snapshot.status === "playing" || snapshot.status === "synthesizing")
		return "pause";
	return "play";
}

function statusLabel(snapshot: ReaderSnapshot): string {
	switch (snapshot.status) {
		case "synthesizing":
			return "Buffering";
		case "playing":
			return "Playing";
		case "paused":
			return "Paused";
		case "finished":
			return "Finished";
		case "error":
			return "Error";
		default:
			return "Ready";
	}
}

function statusColor(snapshot: ReaderSnapshot): Parameters<Theme["fg"]>[0] {
	switch (snapshot.status) {
		case "playing":
		case "finished":
			return "success";
		case "paused":
			return "warning";
		case "error":
			return "error";
		default:
			return "accent";
	}
}

function shortVoiceName(code: string): string {
	const match = code.match(/^([^,]+),\s*(.+)$/);
	if (!match) return code;
	return `${displayVoiceName(match[2] ?? "")} · ${match[1] ?? ""}`;
}

function displayVoiceName(name: string): string {
	return name
		.replace(/Neural$/u, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
}

function formatTime(value: number | undefined): string {
	if (value === undefined || !Number.isFinite(value)) return "00:00";
	const totalSeconds = Math.max(0, Math.floor(value));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	return hours > 0
		? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
		: `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function singleLine(value: string): string {
	return value.replace(/\s+/gu, " ").trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
