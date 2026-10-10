export interface ComposerPort {
	getText(): string;
	setText(text: string): void;
	getCursorOffset(): number;
	insertText(text: string): void;
}

/** Own only our preview. A user edit wins over subsequent ASR updates and finalization. */
export class ComposerDraft {
	private original?: string;
	private expected?: string;
	private before = "";
	private after = "";
	private rendered = false;

	constructor(private readonly editor: ComposerPort) {}

	begin(): void {
		this.original = this.expected = this.editor.getText();
		const at = Math.max(0, Math.min(this.editor.getCursorOffset(), this.original.length));
		this.before = this.original.slice(0, at);
		this.after = this.original.slice(at);
		this.rendered = false;
	}

	preview(text: string): void {
		if (this.original === undefined || this.editor.getText() !== this.expected || !text.trim()) return;
		const next = joinAtCursor(this.before, text.trim(), this.after);
		if (next === this.expected) return;
		this.expected = next;
		this.rendered = true;
		this.editor.setText(next);
	}

	finish(text: string): void {
		if (this.original === undefined) { this.editor.insertText(text); return; }
		if (this.editor.getText() === this.expected) this.preview(text);
		else if (!this.rendered) this.editor.insertText(text);
		// If the user edited a visible preview, never append a duplicate or erase their edit.
		this.reset();
	}

	cancel(): void {
		if (this.original !== undefined && this.rendered && this.editor.getText() === this.expected) this.editor.setText(this.original);
		this.reset();
	}

	private reset(): void {
		this.original = this.expected = undefined;
		this.before = this.after = "";
		this.rendered = false;
	}
}

export function joinAtCursor(before: string, text: string, after: string): string {
	const prefix = before && !/\s$/u.test(before) && !/^[,.;:!?)}\]]/u.test(text) ? " " : "";
	const suffix = after && !/^\s|^[,.;:!?)}\]]/u.test(after) && !/[\s({\[]$/u.test(text) ? " " : "";
	return `${before}${prefix}${text}${suffix}${after}`;
}
