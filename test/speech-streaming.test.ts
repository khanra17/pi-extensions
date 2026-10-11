import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { synthesizeChunks, planSpeechSentences, type SynthesisChunk } from "../packages/read-aloud/edge-read-aloud.ts";
import { SpeechWindow } from "../packages/read-aloud/speech-window.ts";
import { BrowserReadAloud } from "../packages/read-aloud/browser.ts";
import { DEFAULT_SETTINGS } from "../packages/read-aloud/reader-settings.ts";
import { playBufferedSpeech } from "../integration/pi-web/client/media.ts";
import { browserStream, registerBrowserFeature, subscribeBrowser, type BrowserCall } from "../shared/browser.ts";
const tick = () => new Promise(resolve => setTimeout(resolve, 5));
async function until(check: () => boolean) { for (let i = 0; i < 100 && !check(); i++) await tick(); assert.ok(check()); }
const chunk = (text: string, index: number, total: number): SynthesisChunk => ({ text, index, total, audio: new Uint8Array([1]), boundaries: [] });

test("sentence plan starts with precisely the first sentence, including Unicode and safe long-sentence splits", () => {
  assert.deepEqual(planSpeechSentences("First sentence. Next sentence! Last one?"), ["First sentence.", "Next sentence!", "Last one?"]);
  assert.deepEqual(planSpeechSentences("你好。世界！"), ["你好。", "世界！"]);
  assert.deepEqual(planSpeechSentences("The value is 3.14. Done."), ["The value is 3.14.", "Done."]);
  const source = ("你好 & < > 😀 ").repeat(2000), parts = planSpeechSentences(source);
  assert.ok(parts.length > 1); assert.ok(parts.every(part => !part.includes("�")));
  assert.equal(parts.join(" ").replace(/\s+/gu, " ").trim(), source.trim());
  assert.ok(parts.every(part => Buffer.byteLength(part.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")) <= 4096));
});
test("first audio publishes before any look-ahead synthesis, followed by a rolling five-sentence window", async () => {
  const started: number[] = [], emitted: number[] = [], window = new SpeechWindow(), abort = new AbortController();
  const run = synthesizeChunks({ text: Array.from({ length: 20 }, (_, i) => `Sentence ${i}.`).join(" "), voice: DEFAULT_SETTINGS.voice, signal: abort.signal,
    beforeChunk: (index, signal) => window.wait(index, signal),
    synthesizePart: async (text, index, total) => { if (index > 0) assert.equal(emitted[0], 0); started.push(index); return chunk(text, index, total); },
    onChunk: value => { emitted.push(value.index); } });
  await until(() => emitted.length === 6);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]); await tick(); assert.equal(started.length, 6);
  window.advance(1); await until(() => emitted.length === 7); assert.equal(started.at(-1), 6);
  abort.abort(); await assert.rejects(run, /Stopped|abort/i);
});
test("empty sentence audio is an error, never silently skipped", async () => {
  await assert.rejects(synthesizeChunks({ text: "First sentence.", voice: DEFAULT_SETTINGS.voice, synthesizePart: async () => undefined, onChunk: () => assert.fail() }), /no audio for the first sentence/);
});
test("out-of-order synthesis stays ordered and a later failure cannot prevent first audio", async () => {
  const emitted: number[] = [];
  await assert.rejects(synthesizeChunks({ text: "First sentence. Second sentence. Third sentence.", voice: DEFAULT_SETTINGS.voice,
    synthesizePart: async (text, index, total) => { if (index === 1) { await tick(); throw Error("fixture failed"); } return chunk(text, index, total); },
    onChunk: value => { emitted.push(value.index); } }), /fixture failed/);
  assert.deepEqual(emitted, [0]);
});
test("long session replies are addressed by ID, not rejected or posted as giant JSON", async () => {
  const source = "First sentence. " + "Another sentence to read. ".repeat(12_000);
  let seen = "";
  const ctx = { sessionManager: { getSessionId: () => "long-reader", getEntry: (id: string) => id === "long-entry" ? { id, type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: source }] } } : undefined } } as unknown as ExtensionContext;
  const adapter = new BrowserReadAloud(ctx, () => DEFAULT_SETTINGS, () => {}, async options => { seen = options.text; await options.onChunk(chunk("First sentence.", 0, 1)); });
  const call: BrowserCall = { action: "speak", client: "one", run: "long-run", body: { entryId: "long-entry" }, signal: new AbortController().signal };
  try {
    const response = await adapter.handle(call) as Response; await response.text();
    assert.ok(seen.length > 128 * 1024); assert.equal(seen, source.trim()); assert.ok(!seen.includes("SECRET"));
    await assert.rejects(adapter.handle({ ...call, action: "progress", client: "two", body: { index: 0 } }), /another viewing device/);
    await assert.rejects(adapter.handle({ ...call, action: "progress", run: "stale", body: { index: 0 } }), /own/);
    await assert.rejects(adapter.handle({ ...call, action: "progress", body: { index: 100 } }), /Invalid/);
    assert.deepEqual(await adapter.handle({ ...call, action: "progress", body: { index: 0 } }), {});
  } finally { await adapter.dispose(); }
});
test("synthesis errors keep their actual cause in the independent in-page error event", async () => {
  const context = { sessionManager: { getSessionId: () => "reader-error", getSessionFile: () => undefined } } as unknown as ExtensionContext;
  const adapter = new BrowserReadAloud(context, () => DEFAULT_SETTINGS, () => {}, async () => { throw Error("fixture service cause"); });
  const remove = registerBrowserFeature(context, "tts", adapter), errors: unknown[] = [];
  const unsubscribe = subscribeBrowser("reader-error", "one", event => { if (event.type === "closed") errors.push(event.data); });
  try {
    const response = await adapter.handle({ action: "speak", client: "one", run: "error-run", body: { text: "First sentence." }, signal: new AbortController().signal }) as Response;
    await assert.rejects(response.text(), /fixture service cause/); assert.deepEqual(errors, [{ error: "fixture service cause" }]);
  } finally { unsubscribe(); await remove(); }
});
test("browser downloads the next five sentences while the first is still playing; cancellation releases the reader", async () => {
  const emitted: number[] = [], played: number[] = [], abort = new AbortController();
  let released = false;
  const response = browserStream(async (emit, signal) => { try { for (let i = 0; i < 30; i++) { await emit({ ...chunk(`Sentence ${i}.`, i, 30), audio: "AQ==" }); emitted.push(i); } } finally { released = signal.aborted; } }, abort.signal);
  const run = playBufferedSpeech(response, abort.signal, async (value, signal) => {
    played.push(value.index);
    await new Promise<void>((_, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
  });
  await until(() => emitted.length >= 6); assert.deepEqual(played, [0]);
  // One transport enqueue plus the current sentence and five queued sentences.
  await tick(); assert.ok(emitted.length <= 7);
  abort.abort(new Error("fixture cancelled")); await assert.rejects(run, /fixture cancelled/);
  await until(() => released);
});
test("a failed buffered stream immediately interrupts playback instead of playing stale audio", async () => {
  const response = browserStream(async emit => { await emit({ ...chunk("First.", 0, 2), audio: "AQ==" }); throw Error("buffer failed"); }, new AbortController().signal);
  await assert.rejects(playBufferedSpeech(response, new AbortController().signal, async (_, signal) => {
    await new Promise<void>((_, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); if (signal.aborted) reject(signal.reason); });
  }), /buffer failed/);
});
