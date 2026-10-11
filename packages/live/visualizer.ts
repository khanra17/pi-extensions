import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { VOICE_SHORTCUTS } from "../../shared/shortcuts.ts";
import {
	type Component,
	type TUI,
	Key,
	matchesKey,
	sliceByColumn,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { LivePhase, LiveTranscript } from "./controller.ts";

/** Structural subset of pi-tui 1.1 normalized mouse events; keeps older SDKs usable. */
type TuiMouseEvent = { type: string; button: string; x: number; y: number; shift: boolean; alt: boolean; ctrl: boolean };
type TuiMouseEventResult = { handled?: boolean; render?: boolean };

const ANIMATION_INTERVAL_MS = 80;
const LIVE_TOGGLE_KEY = VOICE_SHORTCUTS.live;
const ANSI_ESCAPE_REGEXP = new RegExp(String.raw`\u001B\[[0-?]*[ -/]*[@-~]`, "g");

export interface LiveVisualizerOptions {
	theme: Theme;
	requestRender(): void;
	onStop(): void;
	onToggleMute(): void;
	tui?: TUI & { scrollBy?(lines: number): void };
	isFocused?: () => boolean;
}

type RenderCache = {
	width: number;
	phase: LivePhase;
	displayLevel: number;
	frame: number;
	transcriptRole: LiveTranscript["role"] | undefined;
	transcriptText: string;
	lines: string[];
};

function sanitizeTranscript(text: string): string {
	const withoutAnsi = text.replace(ANSI_ESCAPE_REGEXP, "");
	let safe = "";
	for (const character of withoutAnsi) {
		const code = character.charCodeAt(0);
		safe += code <= 31 || (code >= 127 && code <= 159) ? " " : character;
	}
	return safe.replace(/\s+/gu, " ").trim();
}

function truncateFromStart(text: string, width: number): string {
	if (width <= 0) return "";
	const textWidth = visibleWidth(text);
	if (textWidth <= width) return text;
	if (width === 1) return "…";
	return `…${sliceByColumn(text, textWidth - width + 1, width - 1, true)}`;
}

/** Compact, focus-safe live panel with an RMS microphone spectrum and transcript. */
export class LiveVisualizer implements Component {
	readonly wantsKeyRelease = false;
	private readonly options: LiveVisualizerOptions;
	private phase: LivePhase = "connecting";
	private inputLevel = 0;
	private displayLevel = 0;
	private frame = 0;
	private transcriptRole: LiveTranscript["role"] | undefined;
	private transcriptText = "";
	private cache: RenderCache | undefined;
	private animationInterval: ReturnType<typeof setInterval> | undefined;
	private disposed = false;
	private removeScrollInput?: () => void;
	private hitRegions: Array<{ start: number; end: number; action: "mute" | "stop" }> = [];

	constructor(options: LiveVisualizerOptions) {
		this.options = options;
		const tui = options.tui;
		if (tui?.mode === "fullscreen" && tui.scrollBy) {
			this.removeScrollInput = tui.addInputListener(data => {
				if (this.disposed || options.isFocused?.() === false) return;
				const match = /^\x1b\[<(\d+);\d+;\d+M$/.exec(data);
				const code = match ? Number(match[1]) : 0;
				if (!(code & 64) || (code & 3) > 1) return;
				tui.scrollBy!((code & 1 ? 1 : -1) * (code & 8 ? 5 : 1));
				tui.requestRender();
				return { consume: true };
			});
		}
		this.animationInterval = setInterval(() => {
			if (this.disposed) return;
			this.frame += 1;
			const decayed = this.displayLevel * 0.84;
			this.displayLevel = Math.max(this.inputLevel, decayed < 0.001 ? 0 : decayed);
			this.changed();
		}, ANIMATION_INTERVAL_MS);
		this.animationInterval.unref?.();
	}

	setPhase(phase: LivePhase): void {
		if (this.phase === phase) return;
		this.phase = phase;
		this.changed();
	}

	setInputLevel(level: number): void {
		const next = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
		if (this.inputLevel === next) return;
		this.inputLevel = next;
		if (next > this.displayLevel) this.displayLevel = next;
		this.changed();
	}

	setTranscript(transcript: LiveTranscript | undefined): void {
		const role = transcript?.role;
		const text = sanitizeTranscript(transcript?.text ?? "");
		if (this.transcriptRole === role && this.transcriptText === text) return;
		this.transcriptRole = role;
		this.transcriptText = text;
		this.changed();
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, Key.escape) ||
			matchesKey(data, Key.ctrl("c")) ||
			matchesKey(data, LIVE_TOGGLE_KEY)
		) {
			this.options.onStop();
		} else if (matchesKey(data, Key.space)) {
			this.options.onToggleMute();
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || event.type !== "click" || event.button !== "left" || event.y !== 4 || event.shift || event.alt || event.ctrl) return;
		const hit = this.hitRegions.find(region => event.x >= region.start && event.x < region.end);
		if (!hit) return;
		if (hit.action === "mute") this.options.onToggleMute(); else this.options.onStop();
		return { handled: true, render: true };
	}

	invalidate(): void {
		this.cache = undefined;
	}

	dispose(): void {
		this.disposed = true;
		this.removeScrollInput?.();
		if (this.animationInterval) clearInterval(this.animationInterval);
		this.animationInterval = undefined;
		this.cache = undefined;
	}

	render(maxWidth: number): string[] {
		if (maxWidth <= 0) return ["", "", "", "", ""];
		if (
			this.cache &&
			this.cache.width === maxWidth &&
			this.cache.phase === this.phase &&
			this.cache.displayLevel === this.displayLevel &&
			this.cache.frame === this.frame &&
			this.cache.transcriptRole === this.transcriptRole &&
			this.cache.transcriptText === this.transcriptText
		) {
			return this.cache.lines;
		}

		const lines = this.renderLines(maxWidth);
		this.cache = {
			width: maxWidth,
			phase: this.phase,
			displayLevel: this.displayLevel,
			frame: this.frame,
			transcriptRole: this.transcriptRole,
			transcriptText: this.transcriptText,
			lines,
		};
		return lines;
	}

	private changed(): void {
		this.invalidate();
		this.options.requestRender();
	}

	private renderLines(width: number): string[] {
		this.hitRegions = [];
		if (width === 1) {
			const color =
				this.phase === "error"
					? "error"
					: this.phase === "muted" || this.phase === "standby"
						? "dim"
						: "success";
			return [
				this.options.theme.fg("border", "┐"),
				this.options.theme.fg(color, "▂"),
				this.options.theme.fg(color, "▆"),
				this.options.theme.fg("accent", "…"),
				this.options.theme.fg("border", "┘"),
			];
		}

		const innerWidth = width - 2;
		const theme = this.options.theme;
		const border = (content: string): string => theme.fg("border", "│") + content + theme.fg("border", "│");
		const top = theme.fg("border", `┌${"─".repeat(innerWidth)}┐`);
		const spectrumColor: ThemeColor =
			this.phase === "muted" || this.phase === "connecting" || this.phase === "standby"
				? "dim"
				: this.phase === "error"
					? "error"
					: "success";
		const spectrumRows = this.generateSpectrum(innerWidth, 2).map((row) =>
			border(theme.fg(spectrumColor, row)),
		);
		return [top, ...spectrumRows, this.renderTranscript(innerWidth, border), this.renderFooter(innerWidth)];
	}

	private renderTranscript(innerWidth: number, border: (content: string) => string): string {
		const theme = this.options.theme;
		const label =
			this.transcriptRole === "assistant"
				? "live › "
				: this.transcriptRole === "user"
					? "you › "
					: "";
		const labelWidth = visibleWidth(label);
		const showLabel = labelWidth < innerWidth;
		const available = Math.max(0, innerWidth - (showLabel ? labelWidth : 0));
		const transcript = truncateFromStart(this.transcriptText, available);
		const contentWidth = (showLabel ? labelWidth : 0) + visibleWidth(transcript);
		const padding = " ".repeat(Math.max(0, innerWidth - contentWidth));
		const themedLabel = showLabel ? theme.fg("dim", label) : "";
		const transcriptColor: ThemeColor = this.transcriptRole === "assistant" ? "borderAccent" : "accent";
		return border(themedLabel + theme.fg(transcriptColor, transcript) + padding);
	}

	private renderFooter(innerWidth: number): string {
		const theme = this.options.theme;
		const spinners = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const staticIcons: Record<LivePhase, string> = {
			standby: "◌",
			connecting: "○",
			listening: "●",
			working: "○",
			speaking: "»",
			muted: "×",
			error: "!",
		};
		const icon =
			this.phase === "connecting" || this.phase === "working"
				? spinners[this.frame % spinners.length]!
				: staticIcons[this.phase];
		const phaseColors: Record<LivePhase, ThemeColor> = {
			standby: "dim",
			connecting: "dim",
			listening: "success",
			working: "warning",
			speaking: "accent",
			muted: "dim",
			error: "error",
		};
		const status = `${icon} ${this.phase}`;
		const fullLabel = ` ${status} · space mute · esc end `;
		const shortLabel = ` ${status} `;
		if (innerWidth >= visibleWidth(fullLabel) + 1) {
			const muteStart = 2 + visibleWidth(` ${status} · `);
			const stopStart = muteStart + visibleWidth("space mute · ");
			this.hitRegions = [{ start: muteStart, end: muteStart + visibleWidth("space mute"), action: "mute" }, { start: stopStart, end: stopStart + visibleWidth("esc end"), action: "stop" }];
		}
		const label =
			innerWidth >= visibleWidth(fullLabel) + 1
				? fullLabel
				: innerWidth >= visibleWidth(shortLabel) + 1
					? shortLabel
					: "";
		if (!label) return theme.fg("border", `└${"─".repeat(innerWidth)}┘`);
		const clipped = truncateToWidth(label, Math.max(0, innerWidth - 1), "");
		const remaining = Math.max(0, innerWidth - visibleWidth(clipped) - 1);
		return (
			theme.fg("border", "└─") +
			theme.fg(phaseColors[this.phase], clipped) +
			theme.fg("border", `${"─".repeat(remaining)}┘`)
		);
	}

	private generateSpectrum(width: number, rows: number): string[] {
		const blocks = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
		const output = Array.from({ length: rows }, () => "");
		const microphoneEnergy = Math.min(1, Math.sqrt(this.displayLevel * 5));
		const connectingEnergy =
			this.phase === "connecting" ? 0.06 + 0.03 * Math.sin(this.frame * 0.35) : 0;
		const energy =
			this.phase === "muted" || this.phase === "standby"
				? 0
				: Math.max(microphoneEnergy, connectingEnergy);
		const maxHeight = rows * (blocks.length - 1);
		for (let column = 0; column < width; column += 1) {
			const carrier = 0.5 + 0.5 * Math.sin(this.frame * 0.43 + column * 0.71);
			const shimmer = 0.5 + 0.5 * Math.sin(this.frame * 0.19 - column * 1.17);
			const height = Math.round(energy * (0.3 + carrier * 0.5 + shimmer * 0.2) * maxHeight);
			for (let row = 0; row < rows; row += 1) {
				const units = Math.max(0, Math.min(blocks.length - 1, height - (rows - row - 1) * 8));
				output[row] = `${output[row] ?? ""}${blocks[units] ?? ""}`;
			}
		}
		return output;
	}
}

export const LIVE_VISUALIZER_TOGGLE_KEY = LIVE_TOGGLE_KEY;
