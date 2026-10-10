import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { VoiceController } from "./controller.ts";
import { ComposerDraft, joinAtCursor } from "./composer.ts";
import { loadVoiceDictionary, removeVoiceReplacement, setVoiceReplacement, VOICE_DICTIONARY_PATH } from "./dictionary.ts";
import { recorderDescription } from "./recorder.ts";
import { VoiceStatusWidget, type VoiceSnapshot } from "./ui.ts";

const STATUS = "pi-dictation";

export default function dictation(pi: ExtensionAPI): void {
	const voice = new VoiceController();
	let editor: DictationEditor | undefined;
	let context: ExtensionContext | undefined;
	let widget: VoiceStatusWidget | undefined;
	const insert = (text: string) => editor?.finishTranscript(text);
	voice.subscribe((snapshot) => { if (context?.mode === "tui") updateStatus(context, snapshot); });

	pi.on("session_start", async (_event, ctx) => {
		await voice.cancel();
		editor?.close(); widget?.dispose();
		context = ctx;
		if (ctx.mode !== "tui") return;
		ctx.ui.setEditorComponent((tui, theme, bindings) => {
			editor?.close();
			return editor = new DictationEditor(tui, theme, bindings, ctx, voice);
		});
		ctx.ui.setWidget(STATUS, (tui, theme) => {
			widget?.dispose();
			return widget = new VoiceStatusWidget(tui, theme, voice);
		}, { placement: "aboveEditor" });
	});
	const cancel = async () => { await voice.cancel(); };
	pi.on("session_before_switch", cancel);
	pi.on("session_before_fork", cancel);
	pi.on("session_before_tree", cancel);
	pi.on("session_shutdown", async (_event, ctx) => {
		await voice.dispose();
		editor?.close(); widget?.dispose();
		editor = undefined; widget = undefined; context = undefined;
		if (ctx.mode === "tui") {
			ctx.ui.setStatus(STATUS, undefined);
			ctx.ui.setWidget(STATUS, undefined);
			ctx.ui.setEditorComponent(undefined);
		}
	});

	for (const key of ["alt+m", "ctrl+space"] as const) pi.registerShortcut(key, {
		description: "Start/stop editable microphone dictation",
		handler: async (ctx) => voice.toggle(ctx, insert),
	});
	pi.registerCommand("voice", {
		description: "Editable dictation; never submits the transcript",
		getArgumentCompletions: (prefix) => {
			const values = ["start", "stop", "cancel", "status", "corrections", "help"].filter((value) => value.startsWith(prefix));
			return values.length ? values.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const corrections = args.trim().match(/^corrections(?:\s+(.*))?$/iu);
			if (corrections) { await dictionaryCommand(corrections[1] ?? "", ctx); return; }
			switch (args.trim().toLowerCase()) {
				case "": case "toggle": voice.toggle(ctx, insert); break;
				case "start": await voice.start(ctx, insert); break;
				case "stop": if (voice.isRecording) await voice.stop(); else if (voice.snapshot.status === "starting") await voice.cancel(); break;
				case "cancel": await voice.cancel(); break;
				case "status": ctx.ui.notify(`Dictation: ${voice.snapshot.status} · ${recorderDescription()}`, "info"); break;
				default: ctx.ui.notify("/voice [start|stop|cancel|status|corrections|help] · Alt+M toggles · Ctrl+X stops · Esc cancels.", "info");
			}
		},
	});
}

export class DictationEditor extends CustomEditor {
	wantsKeyRelease = true;
	private readonly draft: ComposerDraft;
	private readonly unsubscribe: () => void;
	private previousStatus: VoiceSnapshot["status"] = "idle";

	constructor(tui: TUI, theme: EditorTheme, private readonly bindings: KeybindingsManager, private readonly context: ExtensionContext, private readonly voice: VoiceController) {
		super(tui, theme, bindings);
		this.draft = new ComposerDraft({
			getText: () => this.getText(),
			setText: (text) => { this.setText(text); tui.requestRender(); },
			getCursorOffset: () => {
				const cursor = this.getCursor();
				return this.getLines().slice(0, cursor.line).reduce((sum, line) => sum + line.length + 1, 0) + cursor.col;
			},
			insertText: (text) => {
				const { line, col } = this.getCursor();
				const value = this.getLines()[line] ?? "";
				const joined = joinAtCursor(value.slice(0, col), text.trim(), value.slice(col));
				this.insertTextAtCursor(joined.slice(col, joined.length - value.slice(col).length));
				tui.requestRender();
			},
		});
		this.unsubscribe = voice.subscribe((snapshot) => {
			if (snapshot.status === "starting" && this.previousStatus !== "starting") this.draft.begin();
			if (snapshot.status === "recording" && snapshot.liveText) this.draft.preview(snapshot.liveText);
			if (snapshot.status === "idle" || snapshot.status === "error") this.draft.cancel();
			this.previousStatus = snapshot.status;
		});
	}

	finishTranscript(text: string): void { this.draft.finish(text); }
	close(): void { this.unsubscribe(); this.draft.cancel(); }

	override handleInput(data: string): void {
		if (isKeyRelease(data)) { if (matchesKey(data, "space")) this.voice.releasePushToTalk(); return; }
		const insert = (text: string) => this.finishTranscript(text);
		if (matchesKey(data, "alt+m") || matchesKey(data, "ctrl+space")) { this.voice.toggle(this.context, insert); return; }
		if (this.voice.isBusy && matchesKey(data, "escape")) { void this.voice.cancel(); return; }
		if (this.voice.isRecording && matchesKey(data, "ctrl+x")) { void this.voice.stop(); return; }
		if (this.voice.isBusy && (this.bindings.matches(data, "tui.input.submit") || this.bindings.matches(data, "app.message.followUp"))) {
			this.context.ui.notify("Stop dictation before sending, or press Escape to cancel.", "info"); return;
		}
		// Encoded Space press/release supports hold-to-talk; ordinary Space is always text.
		if (!this.voice.isBusy && !this.getText() && data !== " " && matchesKey(data, "space") && !isKeyRepeat(data)) {
			void this.voice.start(this.context, insert); return;
		}
		// Editing is allowed. ComposerDraft relinquishes its preview after a user text edit.
		super.handleInput(data);
	}
}

async function dictionaryCommand(args: string, ctx: ExtensionContext): Promise<void> {
	const [action = "", ...words] = args.trim().split(/\s+/u);
	const value = words.join(" ");
	if (!action || action === "list") {
		const dictionary = await loadVoiceDictionary();
		ctx.ui.notify(`${Object.entries(dictionary.replacements).map(([from, to]) => `${from} → ${to}`).join(", ") || "No corrections"} · ${VOICE_DICTIONARY_PATH}`, "info");
	} else if (action === "remove" && value) {
		await removeVoiceReplacement(value); ctx.ui.notify("Correction removed.", "info");
	} else if (action === "replace" && value.includes("=>")) {
		const at = value.indexOf("=>"); const from = value.slice(0, at).trim(); const to = value.slice(at + 2).trim();
		if (!from || !to) { ctx.ui.notify("Both sides of the correction are required.", "warning"); return; }
		await setVoiceReplacement(from, to); ctx.ui.notify("Correction saved locally.", "info");
	} else ctx.ui.notify("/voice corrections [replace <heard> => <correct>|remove <heard>]", "warning");
}

function updateStatus(ctx: ExtensionContext, snapshot: VoiceSnapshot): void {
	const text = snapshot.status === "idle" ? undefined : snapshot.status === "recording" ? "● listening · Alt+M/Ctrl+X stop · Esc cancel" : snapshot.message;
	ctx.ui.setStatus(STATUS, text ? ctx.ui.theme.fg(snapshot.status === "error" ? "error" : "accent", text) : undefined);
}
