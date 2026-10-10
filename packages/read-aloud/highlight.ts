import type { ReaderSnapshot } from "./read-aloud-controller.ts";

export interface WordRange { source: string; start: number; end: number }

/** Align spoken text with original Markdown without changing any SDK components. */
export class WordAlignment {
	private source = "";
	private speech = "";
	private positions = new Map<number, { start: number; end: number }>();

	range(snapshot: ReaderSnapshot): WordRange | undefined {
		if (!snapshot.highlightEnabled || !["playing", "paused"].includes(snapshot.status) || snapshot.speechHighlightEnd <= snapshot.speechHighlightStart) return;
		const source = snapshot.sourceText.trim();
		if (source !== this.source || snapshot.text !== this.speech) {
			this.source = source; this.speech = snapshot.text; this.positions.clear();
		}
		const at = snapshot.speechHighlightStart;
		const cached = this.positions.get(at);
		if (cached) return { source, ...cached };
		let start = 0, end = source.length;
		for (const [position, range] of [...this.positions].sort(([a], [b]) => a - b)) {
			if (position < at) start = range.end;
			else if (position > at) { end = range.start; break; }
		}
		const spoken = snapshot.text.slice(at, snapshot.speechHighlightEnd).trim();
		const core = spoken.match(/[\p{L}\p{N}_'’−-]+/u)?.[0];
		for (const word of [spoken, core]) {
			if (!word) continue;
			const index = source.slice(start, end).toLowerCase().indexOf(word.toLowerCase());
			if (index < 0) continue;
			const range = { start: start + index, end: start + index + word.length };
			this.positions.set(at, range);
			return { source, ...range };
		}
	}
}

export function highlightMarkdown(markdown: string, range: WordRange | undefined, style: (text: string) => string): string {
	if (!range) return markdown;
	let block = range.source.indexOf(markdown);
	while (block >= 0) {
		const start = range.start - block, end = range.end - block;
		if (start >= 0 && end <= markdown.length && end > start) {
			// Fenced code uses Pi's own syntax highlighter; never replace/patch its theme.
			const fences = markdown.slice(0, start).match(/^ {0,3}(?:`{3,}|~{3,})/gm) ?? [];
			if (fences.length % 2) return markdown;
			return `${markdown.slice(0, start)}${style(markdown.slice(start, end))}${markdown.slice(end)}`;
		}
		block = range.source.indexOf(markdown, block + 1);
	}
	return markdown;
}
