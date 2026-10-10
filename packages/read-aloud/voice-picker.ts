import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type Focusable,
	fuzzyFilter,
	Input,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Voice } from "./edge-read-aloud.ts";

interface VoicePickerKeybindings {
	matches(data: string, action: string): boolean;
}

interface VoicePickerOptions {
	voices: readonly Voice[];
	currentVoice: string;
	theme: Theme;
	keybindings: VoicePickerKeybindings;
	requestRender: () => void;
	onSelect: (voice: Voice | undefined) => void;
}

const MAX_VISIBLE = 10;
const PAGE_SIZE = 8;

/** Search-first voice browser with fuzzy matching and IME-aware input. */
export class VoicePicker implements Component, Focusable {
	private readonly voices: Voice[];
	private readonly currentVoice: string;
	private readonly theme: Theme;
	private readonly keybindings: VoicePickerKeybindings;
	private readonly requestRender: () => void;
	private readonly onSelect: (voice: Voice | undefined) => void;
	private readonly input = new Input();
	private filtered: Voice[];
	private selectedIndex = 0;
	private closed = false;
	private _focused = false;

	constructor(options: VoicePickerOptions) {
		this.voices = [...options.voices];
		this.currentVoice = options.currentVoice;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.requestRender = options.requestRender;
		this.onSelect = options.onSelect;
		this.filtered = this.voices;
		const currentIndex = this.filtered.findIndex(
			(voice) => voice.code === this.currentVoice,
		);
		this.selectedIndex = Math.max(0, currentIndex);
	}

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.input.focused = value;
	}

	handleInput(data: string): void {
		if (this.closed) return;

		if (matchesKey(data, Key.ctrl("c"))) {
			if (this.input.getValue()) {
				this.input.setValue("");
				this.refreshFilter();
			} else {
				this.close(undefined);
			}
			return;
		}
		if (matchesKey(data, Key.escape)) {
			this.close(undefined);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.confirm")) {
			this.close(this.filtered[this.selectedIndex]);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			this.moveSelection(-1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down")) {
			this.moveSelection(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageUp")) {
			this.moveSelection(-PAGE_SIZE, false);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.pageDown")) {
			this.moveSelection(PAGE_SIZE, false);
			return;
		}
		if (matchesKey(data, Key.home)) {
			this.setSelectedIndex(0);
			return;
		}
		if (matchesKey(data, Key.end)) {
			this.setSelectedIndex(this.filtered.length - 1);
			return;
		}

		const previousQuery = this.input.getValue();
		this.input.handleInput(data);
		if (this.input.getValue() !== previousQuery) this.refreshFilter();
		else this.requestRender();
	}

	render(width: number): string[] {
		if (width < 8) return [truncateToWidth("Voice picker", width, "")];
		const lines: string[] = [];
		const innerWidth = width - 4;
		const query = this.input.getValue().trim();
		const resultLabel = query
			? `${this.filtered.length} match${this.filtered.length === 1 ? "" : "es"}`
			: `${this.voices.length} voices`;

		lines.push(this.border(width, "top"));
		lines.push(
			this.line(
				width,
				`${this.theme.fg("accent", this.theme.bold("CHOOSE A VOICE"))}  ${this.theme.fg("dim", resultLabel)}`,
			),
		);
		lines.push(
			this.line(
				width,
				this.theme.fg(
					"muted",
					"Type any name, language, region, locale, or gender",
				),
			),
		);

		const inputWidth = Math.max(4, innerWidth - 9);
		const inputLine = this.input.render(inputWidth)[0] ?? "> ";
		lines.push(
			this.line(width, `${this.theme.fg("muted", "Search ")} ${inputLine}`),
		);
		lines.push(this.separator(width));

		if (this.filtered.length === 0) {
			lines.push(
				this.line(
					width,
					this.theme.fg("warning", "No matching voices — try fewer words"),
				),
			);
			for (let index = 1; index < MAX_VISIBLE; index += 1)
				lines.push(this.line(width, ""));
		} else {
			const { start, end } = this.visibleRange();
			for (let index = start; index < end; index += 1) {
				const voice = this.filtered[index];
				if (voice) lines.push(this.voiceLine(width, voice, index));
			}
			for (let index = end - start; index < MAX_VISIBLE; index += 1)
				lines.push(this.line(width, ""));
		}

		lines.push(this.separator(width));
		const selected = this.filtered[this.selectedIndex];
		if (selected) {
			const position = `${this.selectedIndex + 1}/${this.filtered.length}`;
			lines.push(
				this.line(
					width,
					`${this.theme.fg("text", selected.friendlyName)}  ${this.theme.fg("dim", position)}`,
				),
			);
		} else {
			lines.push(this.line(width, this.theme.fg("dim", "No voice selected")));
		}
		lines.push(
			this.line(
				width,
				this.theme.fg(
					"dim",
					"↑↓ navigate  PgUp/PgDn jump  Enter choose  Ctrl+C clear  Esc close",
				),
			),
		);
		lines.push(this.border(width, "bottom"));
		return lines;
	}

	invalidate(): void {
		this.input.invalidate();
	}

	private refreshFilter(): void {
		const query = this.input.getValue().trim();
		this.filtered = query
			? fuzzyFilter(this.voices, query, voiceSearchText)
			: this.voices;
		this.selectedIndex = 0;
		this.requestRender();
	}

	private moveSelection(delta: number, wrap = true): void {
		if (this.filtered.length === 0) return;
		const next = this.selectedIndex + delta;
		if (wrap) {
			this.selectedIndex =
				((next % this.filtered.length) + this.filtered.length) %
				this.filtered.length;
		} else {
			this.selectedIndex = clamp(next, 0, this.filtered.length - 1);
		}
		this.requestRender();
	}

	private setSelectedIndex(index: number): void {
		if (this.filtered.length === 0) return;
		this.selectedIndex = clamp(index, 0, this.filtered.length - 1);
		this.requestRender();
	}

	private visibleRange(): { start: number; end: number } {
		const start = Math.max(
			0,
			Math.min(
				this.selectedIndex - Math.floor(MAX_VISIBLE / 2),
				this.filtered.length - MAX_VISIBLE,
			),
		);
		return {
			start,
			end: Math.min(start + MAX_VISIBLE, this.filtered.length),
		};
	}

	private voiceLine(width: number, voice: Voice, index: number): string {
		const selected = index === this.selectedIndex;
		const current = voice.code === this.currentVoice;
		const pointer = selected ? "›" : " ";
		const marker = current ? "●" : " ";
		const name = displayVoiceName(voice.name);
		const left = `${pointer} ${marker} ${name}`;
		const details = `${voice.locale}  ${voice.gender ?? ""}`.trimEnd();
		const available = Math.max(1, width - 4);
		const detailsWidth = visibleWidth(details);
		const leftWidth = Math.max(1, available - detailsWidth - 2);
		const fittedLeft = truncateToWidth(left, leftWidth, "…");
		const gap = " ".repeat(
			Math.max(2, available - visibleWidth(fittedLeft) - detailsWidth),
		);
		let content = `${fittedLeft}${gap}${details}`;
		content = truncateToWidth(content, available, "");
		content += " ".repeat(Math.max(0, available - visibleWidth(content)));

		if (selected) {
			content = this.theme.bg("selectedBg", this.theme.fg("accent", content));
		} else if (current) {
			content = this.theme.fg("success", content);
		} else {
			content = `${content.slice(0, 2)}${this.theme.fg("text", content.slice(2))}`;
		}
		return `│ ${content} │`;
	}

	private line(width: number, content: string): string {
		const innerWidth = width - 4;
		const fitted = truncateToWidth(content, innerWidth, "");
		return `│ ${fitted}${" ".repeat(Math.max(0, innerWidth - visibleWidth(fitted)))} │`;
	}

	private separator(width: number): string {
		return this.theme.fg("borderMuted", `├${"─".repeat(width - 2)}┤`);
	}

	private border(width: number, position: "top" | "bottom"): string {
		const [left, right] = position === "top" ? ["╭", "╮"] : ["╰", "╯"];
		return this.theme.fg(
			"borderAccent",
			`${left}${"─".repeat(width - 2)}${right}`,
		);
	}

	private close(voice: Voice | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.onSelect(voice);
	}
}

function voiceSearchText(voice: Voice): string {
	return [
		voice.name,
		displayVoiceName(voice.name),
		voice.locale,
		voice.locale.replaceAll("-", " "),
		voice.friendlyName,
		voice.gender ?? "",
	].join(" ");
}

function displayVoiceName(name: string): string {
	return name
		.replace(/Neural$/u, "")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.trim();
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
