import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export type VoiceStatus = "idle" | "starting" | "recording" | "transcribing" | "success" | "error";

export interface VoiceSnapshot {
	status: VoiceStatus;
	startedAt?: number;
	message?: string;
	liveText?: string;
	/** Normalized microphone RMS (0..1) while recording. */
	rms?: number;
	frame: number;
}

export interface VoiceStateLike {
	readonly snapshot: VoiceSnapshot;
	subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void;
}

/** Responsive, theme-aware voice panel shown only while useful. */
export class VoiceStatusWidget {
	private snapshot: VoiceSnapshot;
	private readonly unsubscribe: () => void;

	constructor(
		private readonly tui: { requestRender: () => void },
		private readonly theme: Theme,
		state: VoiceStateLike,
	) {
		this.snapshot = state.snapshot;
		this.unsubscribe = state.subscribe((snapshot) => {
			this.snapshot = snapshot;
			this.tui.requestRender();
		});
	}

	render(width: number): string[] {
		if (width < 16 || this.snapshot.status === "idle") return [];

		const status = this.snapshot.status;
		const style = statusStyle(status);
		const spinner = spinnerFrames[this.snapshot.frame % spinnerFrames.length]!;
		const elapsed = this.snapshot.startedAt ? formatDuration(Date.now() - this.snapshot.startedAt) : "";
		const label =
			status === "recording"
				? `●  LISTENING${elapsed ? `  ${elapsed}` : ""}`
				: status === "starting"
					? `${spinner}  PREPARING`
					: status === "transcribing"
						? `${spinner}  TRANSCRIBING`
						: status === "success"
							? "✓  TRANSCRIPT READY"
							: "!  VOICE INPUT FAILED";
		const detail =
			(status === "recording" && this.snapshot.liveText
				? `Live: ${this.snapshot.liveText}`
				: undefined) ??
			this.snapshot.message ??
			(status === "recording"
				? "Microphone active"
				: status === "transcribing"
					? "Sending audio through Codex"
					: "Voice input unavailable");
		const hint =
			status === "recording"
				? "Ctrl+X stop  ·  Esc cancel  ·  Alt+M toggle"
				: status === "starting" || status === "transcribing"
					? "Esc cancel"
					: status === "success"
						? "Inserted at the cursor · undo normally with Ctrl+Z"
						: "See the notification for details";

		const lines = [
			this.border(width, "top", width >= 26 ? "CODEX VOICE" : "VOICE", style.border),
			this.line(width, this.theme.fg(style.label, this.theme.bold(label)), style.border),
		];
		if (status === "recording" && width >= 28) {
			const pulse = voicePulse(this.snapshot.rms ?? 0, this.snapshot.frame);
			lines.push(
				this.line(
					width,
					`${this.theme.fg("accent", pulse)}  ${this.theme.fg("dim", detail)}`,
					style.border,
				),
			);
		} else {
			lines.push(this.line(width, this.theme.fg(style.detail, detail), style.border));
		}
		lines.push(this.line(width, this.theme.fg("dim", hint), style.border));
		lines.push(this.border(width, "bottom", undefined, style.border));
		return lines;
	}

	invalidate(): void {}

	dispose(): void {
		this.unsubscribe();
	}

	private line(width: number, content: string, borderColor: ThemeColor): string {
		const inner = Math.max(1, width - 4);
		const fitted = truncateToWidth(content, inner, "");
		const padding = " ".repeat(Math.max(0, inner - visibleWidth(fitted)));
		return `${this.theme.fg(borderColor, "│")} ${fitted}${padding} ${this.theme.fg(borderColor, "│")}`;
	}

	private border(width: number, side: "top" | "bottom", title: string | undefined, color: ThemeColor): string {
		const left = side === "top" ? "╭" : "╰";
		const right = side === "top" ? "╮" : "╯";
		if (!title) return this.theme.fg(color, `${left}${"─".repeat(Math.max(0, width - 2))}${right}`);

		const titleText = ` ${title} `;
		const remaining = Math.max(0, width - 2 - visibleWidth(titleText));
		const leftCount = Math.floor(remaining / 2);
		return (
			this.theme.fg(color, `${left}${"─".repeat(leftCount)}`) +
			this.theme.fg("accent", titleText) +
			this.theme.fg(color, `${"─".repeat(remaining - leftCount)}${right}`)
		);
	}
}

function statusStyle(status: VoiceStatus): { border: ThemeColor; label: ThemeColor; detail: ThemeColor } {
	if (status === "recording") return { border: "borderAccent", label: "error", detail: "text" };
	if (status === "error") return { border: "error", label: "error", detail: "error" };
	if (status === "success") return { border: "success", label: "success", detail: "success" };
	return { border: "borderAccent", label: "accent", detail: "text" };
}

const spinnerFrames = ["◐", "◓", "◑", "◒"] as const;
const pulseFrames = [
	[1, 2, 4, 6, 4, 2, 1],
	[2, 4, 6, 7, 6, 4, 2],
	[4, 6, 7, 6, 4, 2, 4],
	[6, 7, 6, 4, 2, 4, 6],
	[7, 6, 4, 2, 4, 6, 7],
	[6, 4, 2, 4, 6, 7, 6],
] as const;
const pulseGlyphs = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

function voicePulse(rms: number, frame: number): string {
	const level = rmsToDisplayLevel(rms);
	if (level === 0) return pulseGlyphs[0]!.repeat(7);

	const pattern = pulseFrames[frame % pulseFrames.length]!;
	const maximumHeight = 1 + level * (pulseGlyphs.length - 1);
	return pattern
		.map((height) => {
			const glyphIndex = Math.max(0, Math.min(pulseGlyphs.length - 1, Math.round((height / 7) * maximumHeight) - 1));
			return pulseGlyphs[glyphIndex]!;
		})
		.join("");
}

function rmsToDisplayLevel(rms: number): number {
	if (!Number.isFinite(rms) || rms <= 0.001) return 0;
	// Speech is usually well below full scale, so map dBFS rather than using a
	// linear scale that would make normal microphone input look almost flat.
	const decibels = 20 * Math.log10(Math.min(1, rms));
	return Math.max(0, Math.min(1, (decibels + 50) / 40));
}

function formatDuration(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}
