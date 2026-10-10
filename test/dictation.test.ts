import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, matchesKey, type Terminal, type EditorTheme } from "@earendil-works/pi-tui";
import { DictationEditor } from "../packages/dictation/index.ts";
import { ComposerDraft, joinAtCursor } from "../packages/dictation/composer.ts";
import { TranscriptPreview } from "../packages/dictation/preview.ts";
import { VoiceController } from "../packages/dictation/controller.ts";
import { pcmToWav, type AudioRecorder } from "../packages/dictation/recorder.ts";
import { claimMicrophone } from "../shared/microphone.ts";

function composer(initial = "", at = initial.length) {
	let text = initial, writes = 0;
	const draft = new ComposerDraft({ getText: () => text, setText: (next) => { text = next; writes++; }, getCursorOffset: () => at, insertText: (value) => { text += ` ${value}`; } });
	draft.begin();
	return { draft, text: () => text, writes: () => writes, edit: (next: string) => { text = next; } };
}
function pcm(seconds = 1): Uint8Array {
	const bytes = new Uint8Array(48_000 * seconds), view = new DataView(bytes.buffer);
	for (let i = 0; i < bytes.length / 2; i++) view.setInt16(i * 2, Math.round(2_000 * Math.sin(i * 0.1)), true);
	return bytes;
}
async function until(condition: () => boolean): Promise<void> {
	const start = Date.now();
	while (!condition()) { if (Date.now() - start > 2_000) throw Error("Condition timed out"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }

for (const [before, text, after, expected] of [["hello", "world", "", "hello world"], ["hello", ", world", "", "hello, world"], ["", "你好", "世界", "你好 世界"], ["line\n", "two", "!", "line\ntwo!"]]) {
	test(`composer spacing: ${JSON.stringify(expected)}`, () => assert.equal(joinAtCursor(before!, text!, after!), expected));
}
test("preview appears in a nonempty draft at the insertion point; final replaces it", () => {
	const c = composer("before after", 7);
	c.draft.preview("one"); assert.equal(c.text(), "before one after");
	c.draft.preview("one two"); assert.equal(c.text(), "before one two after");
	c.draft.finish("One two."); assert.equal(c.text(), "before One two. after");
});
test("unchanged previews do not move the editor cursor repeatedly", () => {
	const c = composer(); c.draft.preview("hello"); c.draft.preview("hello"); assert.equal(c.writes(), 1);
});
test("cancel restores only our preview, preserving the original draft", () => {
	const c = composer("draft"); c.draft.preview("speech"); c.draft.cancel(); assert.equal(c.text(), "draft");
});
test("user edits win over preview, final text and cancellation", () => {
	const c = composer("draft"); c.draft.preview("speech"); c.edit("draft edited speech");
	c.draft.preview("more speech"); c.draft.finish("final speech"); c.draft.cancel(); assert.equal(c.text(), "draft edited speech");
});
test("a final-only transcript still preserves the original draft", () => {
	const c = composer("draft"); c.draft.finish("speech"); assert.equal(c.text(), "draft speech");
});
test("edits before the first preview get a final insertion, never an overwrite", () => {
	const c = composer("draft"); c.edit("changed draft"); c.draft.preview("speech"); c.draft.finish("speech"); assert.equal(c.text(), "changed draft speech");
});

test("progressive ASR sends growing WAV snapshots, serially, while capture continues", async () => {
	const first = deferred<string>(), seen: number[] = [], texts: string[] = [];
	let active = 0, maximum = 0;
	const preview = new TranscriptPreview({ intervalMs: 1, transcribe: async (audio) => {
		seen.push(new DataView(audio.buffer, audio.byteOffset).getUint32(40, true)); maximum = Math.max(maximum, ++active);
		const text = seen.length === 1 ? await first.promise : "hello world"; --active; return text;
	}, onText: (text) => texts.push(text) });
	try {
		preview.append(pcm()); await until(() => seen.length === 1);
		preview.append(pcm()); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(seen.length, 1);
		first.resolve("hello"); await until(() => texts.length === 2);
		assert.deepEqual(seen, [48_000, 96_000]); assert.deepEqual(texts, ["hello", "hello world"]); assert.equal(maximum, 1);
	} finally { first.resolve(""); await preview.cancel(); }
});
test("cancel fences a late preview response even if the transport ignores abort", async () => {
	const late = deferred<string>(); let calls = 0, updates = 0; let signal: AbortSignal | undefined;
	const preview = new TranscriptPreview({ intervalMs: 1, transcribe: async (_audio, requestSignal) => { signal = requestSignal; calls++; return late.promise; }, onText: () => updates++ });
	preview.append(pcm()); await until(() => calls === 1);
	const cancelled = preview.cancel(); assert.equal(signal?.aborted, true);
	late.resolve("stale"); await cancelled; preview.append(pcm()); assert.equal(updates, 0);
});
test("preview failures retain capture and retry only after new audio", async () => {
	let calls = 0; const texts: string[] = [];
	const preview = new TranscriptPreview({ intervalMs: 1, transcribe: async () => { if (++calls === 1) throw Error("offline"); return "recovered"; }, onText: (text) => texts.push(text) });
	try {
		preview.append(pcm()); await until(() => calls === 1); await new Promise((resolve) => setTimeout(resolve, 10)); assert.equal(calls, 1);
		preview.append(pcm()); await until(() => texts.length === 1); assert.deepEqual(texts, ["recovered"]);
	} finally { await preview.cancel(); }
});
test("subsecond PCM never triggers a preview upload", async () => {
	let calls = 0; const preview = new TranscriptPreview({ intervalMs: 1, transcribe: async () => { calls++; return ""; }, onText: () => {} });
	preview.append(pcm().slice(0, 20_000)); await new Promise((resolve) => setTimeout(resolve, 10)); await preview.cancel(); assert.equal(calls, 0);
});

function fixture(sessionId: string, transcribe: (audio: Uint8Array, signal: AbortSignal) => Promise<string> = async () => "final speech") {
	let now = 0, cancelled = 0, listener: ((chunk: Uint8Array) => void) | undefined;
	const notifications: string[] = [], inserted: string[] = [];
	const context = { mode: "tui", sessionManager: { getSessionId: () => sessionId }, ui: { notify: (text: string) => notifications.push(text) } } as unknown as ExtensionContext;
	const recorder: AudioRecorder = { stop: async () => pcmToWav(pcm(2), 24_000), cancel: async () => { cancelled++; }, onPcmChunk: (next) => { listener = next; return () => { listener = undefined; }; } };
	const voice = new VoiceController({ auth: async () => ({ accessToken: "fake", accountId: "fake", baseUrl: "https://invalid.example" }), dictionary: async () => ({ replacements: { hello: "Hello" } }), record: async () => recorder, transcribe: (audio, _auth, signal) => transcribe(audio, signal), now: () => now, previewIntervalMs: 1 });
	return { voice, context, inserted, notifications, recorder, cancelled: () => cancelled, advance: () => { now += 2_000; }, emit: () => listener?.(pcm()) };
}
test("controller publishes live text before stop, corrects it, then inserts final text exactly once", async () => {
	const f = fixture("progressive", async (_audio, signal) => signal.aborted ? "" : "hello speech");
	try {
		await f.voice.start(f.context, (text) => f.inserted.push(text)); f.emit();
		await until(() => Boolean(f.voice.snapshot.liveText)); assert.equal(f.voice.snapshot.liveText, "Hello speech"); assert.deepEqual(f.inserted, []);
		f.advance(); await Promise.all([f.voice.stop(), f.voice.stop()]); assert.deepEqual(f.inserted, ["Hello speech"]);
	} finally { await f.voice.dispose(); }
});
test("cancel during final ASR prevents insertion and releases microphone ownership", async () => {
	const late = deferred<string>(); let called = false;
	const f = fixture("late-final", async () => { called = true; return late.promise; });
	await f.voice.start(f.context, (text) => f.inserted.push(text)); f.advance();
	const stop = f.voice.stop(); await until(() => called);
	const cancel = f.voice.cancel(); late.resolve("stale"); await Promise.all([cancel, stop]); assert.deepEqual(f.inserted, []);
	const release = claimMicrophone("late-final", "live"); release(); await f.voice.dispose();
});
test("cancel during microphone startup cleans late acquisition and cannot revive recording", async () => {
	const late = deferred<AudioRecorder>(), f = fixture("permission");
	const voice = new VoiceController({ auth: async () => ({ accessToken: "fake", accountId: "fake", baseUrl: "https://invalid.example" }), dictionary: async () => ({ replacements: {} }), record: () => late.promise });
	const start = voice.start(f.context, () => assert.fail("unexpected insertion"));
	await until(() => voice.snapshot.message === "Opening microphone…");
	const cancel = voice.cancel(); late.resolve(f.recorder); await Promise.all([start, cancel]);
	assert.equal(voice.snapshot.status, "idle"); assert.equal(f.cancelled(), 1); await voice.dispose(); await f.voice.dispose();
});
const plain = (text: string) => text;
const editorTheme: EditorTheme = { borderColor: plain, selectList: { selectedPrefix: plain, selectedText: plain, description: plain, scrollInfo: plain, noMatch: plain } };
const editorBindings = { matches: (data: string, action: string) => action === "tui.input.submit" ? matchesKey(data, "enter") : action === "app.message.followUp" ? matchesKey(data, "alt+enter") : false } as KeybindingsManager;
function fakeTerminal(): Terminal {
	const noop = () => {};
	return { columns: 80, rows: 24, kittyProtocolActive: true, start: noop, stop: noop, drainInput: async () => {}, write: noop, moveBy: noop, hideCursor: noop, showCursor: noop, clearLine: noop, clearFromCursor: noop, clearScreen: noop, setTitle: noop, setProgress: noop, setProgramStatus: noop };
}
test("real CustomEditor displays previews in an existing draft and replaces final text without sending", async () => {
	let requests = 0, submissions = 0;
	const f = fixture("real-editor", async () => ++requests === 1 ? "hello preview" : "Final corrected speech");
	const tui = new TuiMainScreen(fakeTerminal());
	const editor = new DictationEditor(tui, editorTheme, editorBindings, f.context, f.voice);
	editor.onSubmit = () => submissions++;
	editor.setText("existing draft");
	try {
		await f.voice.start(f.context, (text) => editor.finishTranscript(text)); f.emit();
		await until(() => editor.getText().includes("Hello preview"));
		assert.equal(editor.getText(), "existing draft Hello preview");
		f.advance(); await f.voice.stop();
		assert.equal(editor.getText(), "existing draft Final corrected speech"); assert.equal(submissions, 0);
	} finally { await f.voice.dispose(); editor.close(); tui.stop(); }
});
test("real composer permits edits, holds send, and preserves edited previews after final ASR", async () => {
	let submissions = 0;
	const f = fixture("edited-editor", async () => "hello speech");
	const tui = new TuiMainScreen(fakeTerminal());
	const editor = new DictationEditor(tui, editorTheme, editorBindings, f.context, f.voice);
	editor.onSubmit = () => submissions++;
	try {
		await f.voice.start(f.context, (text) => editor.finishTranscript(text)); f.emit();
		await until(() => editor.getText() === "Hello speech");
		editor.handleInput("\r"); assert.equal(submissions, 0);
		editor.handleInput("!"); assert.equal(editor.getText(), "Hello speech!");
		f.advance(); await f.voice.stop(); assert.equal(editor.getText(), "Hello speech!"); assert.equal(submissions, 0);
	} finally { await f.voice.dispose(); editor.close(); tui.stop(); }
});
test("non-terminal commands never acquire a server microphone", async () => {
	const f = fixture("browser"); await f.voice.start({ ...f.context, mode: "rpc" }, () => assert.fail());
	assert.equal(f.voice.snapshot.status, "idle"); assert.match(f.notifications[0]!, /terminal UI/); await f.voice.dispose();
});
