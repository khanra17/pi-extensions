import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserDictation } from "../packages/dictation/browser.ts";
import { browserRegistry, registerBrowserFeature, subscribeBrowser, emitBrowser, browserStream, requireOwner, type BrowserCall } from "../shared/browser.ts";
import { pcmToWav } from "../packages/dictation/audio.ts";
import { claimMicrophone } from "../shared/microphone.ts";
import { LiveSessionController } from "../packages/live/controller.ts";
import { SpeechPlayer } from "../integration/pi-web/client/media.ts";
import { readFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
const context = (id: string) => ({ sessionManager: { getSessionId: () => id, getSessionFile: () => undefined }, ui: { notify: () => {} } }) as unknown as ExtensionContext;
const call = (action: string, run?: string, client = "one", audio?: Uint8Array): BrowserCall => ({ action, run, client, audio, body: {}, signal: new AbortController().signal });
const deps = { auth: async () => ({ accessToken: "fixture", accountId: "fixture", baseUrl: "https://invalid.example" }), dictionary: async () => ({ replacements: {} }), transcribe: async () => "hello" };
const wav = () => pcmToWav(new Uint8Array(48_000), 24_000);
test("browser dictation previews, finalizes once, and releases session input", async () => {
  const adapter = new BrowserDictation(context("browser-final"), deps);
  const { run } = await adapter.handle(call("start", "requested-run")) as { run: string };
  assert.equal(run, "requested-run"); assert.equal(adapter.isActive(), true);
  assert.deepEqual(await adapter.handle(call("preview", run, "one", wav())), { text: "hello" });
  assert.deepEqual(await adapter.handle(call("finish", run, "one", wav())), { text: "hello" });
  assert.equal(adapter.isActive(), false); const release = claimMicrophone("browser-final", "live"); release();
});
test("a second viewing device cannot transcribe, stop or release another run", async () => {
  const adapter = new BrowserDictation(context("browser-owner"), deps);
  const { run } = await adapter.handle(call("start")) as { run: string };
  await assert.rejects(adapter.handle(call("cancel", run, "two")), /own/);
  await adapter.disconnect("two"); assert.equal(adapter.isActive(), true);
  await adapter.disconnect("one"); assert.equal(adapter.isActive(), false);
});
test("cancelling delayed authentication cannot revive a browser microphone lease", async () => {
  let resolve!: (value: Awaited<ReturnType<typeof deps.auth>>) => void;
  const adapter = new BrowserDictation(context("browser-late"), { ...deps, auth: () => new Promise(done => { resolve = done; }) });
  const start = adapter.handle(call("start", "known-run"));
  await adapter.handle(call("cancel", "known-run"));
  resolve(await deps.auth()); await assert.rejects(start, /cancelled/);
  const release = claimMicrophone("browser-late", "live"); release();
});
test("late transcription results cannot restore a cancelled browser run", async () => {
  let resolve!: (value: string) => void;
  const adapter = new BrowserDictation(context("browser-preview-late"), { ...deps, transcribe: () => new Promise(done => { resolve = done; }) });
  const { run } = await adapter.handle(call("start")) as { run: string };
  const preview = adapter.handle(call("preview", run, "one", wav()));
  const cancelled = adapter.dispose(); resolve("too late"); await assert.rejects(preview, /cancelled/); await cancelled;
  assert.equal(adapter.isActive(), false);
});
test("browser registry isolates feature events and cleans up independently", async () => {
  const seen: string[] = [];
  const adapter = { handle: async () => ({}), disconnect: async () => {}, dispose: async () => {} };
  const remove = registerBrowserFeature(context("registry-test"), "tts", adapter);
  const unsubscribe = subscribeBrowser("registry-test", "one", event => seen.push(event.type));
  emitBrowser("registry-test", "tts", "private", {}, "two"); emitBrowser("registry-test", "tts", "mine", {}, "one");
  assert.deepEqual(seen, ["mine"]); unsubscribe(); await remove(); assert.equal(browserRegistry().sessions.has("registry-test"), false);
});
test("stream chunks are bounded, ordered and cancellation propagates", async () => {
  const response = browserStream(async emit => { await emit({ index: 0 }); await emit({ index: 1 }); }, new AbortController().signal);
  assert.equal(await response.text(), '{"index":0}\n{"index":1}\n');
  const large = browserStream(async emit => { await emit("x".repeat(2 * 1024 * 1024)); }, new AbortController().signal);
  await assert.rejects(large.text(), /limit/);
  let signal!: AbortSignal;
  const cancelled = browserStream(async (emit, abort) => { signal = abort; await emit(1); await emit(2); }, new AbortController().signal);
  await cancelled.body!.cancel(); assert.equal(signal.aborted, true);
});
test("browser Live never constructs or starts the host microphone", async () => {
  let nativeCapture = 0, connected = 0;
  const live = new LiveSessionController({ sessionId: "browser-live-capture", captureAudio: false, getAuth: deps.auth, delegate: () => {}, callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} }, native: { AudioCapture: class { constructor() { nativeCapture++; throw Error("host microphone must not start"); } } as never, LiveWebRtcPeer: class {} as never, __ompInstallTokioRuntime: () => {} }, createTransport: async () => ({ connect: async () => { connected++; }, send: async () => {}, close: async () => {}, setMuted: () => {}, pushAudio: () => {} }) });
  await live.start(); assert.equal(connected, 1); assert.equal(nativeCapture, 0); await live.stop();
});
test("browser Pause holds a pending chunk before audio arrives", async () => {
  class AudioFixture extends EventTarget { src = ""; paused = true; currentTime = 0; plays = 0; async play() { this.paused = false; this.plays++; } pause() { this.paused = true; } removeAttribute() { this.src = ""; } load() {} }
  const previous = globalThis.Audio; globalThis.Audio = AudioFixture as unknown as typeof Audio;
  const player = new SpeechPlayer();
  try {
    player.pause();
    const playback = player.play({ index: 0, total: 1, text: "test", audio: "AA==", boundaries: [] }, new AbortController().signal, () => {});
    await new Promise(resolve => setTimeout(resolve, 10)); assert.equal((player.audio as unknown as AudioFixture).plays, 0);
    await player.resume(); await new Promise(resolve => setTimeout(resolve, 10)); assert.equal((player.audio as unknown as AudioFixture).plays, 1);
    player.audio.dispatchEvent(new Event("ended")); await playback;
  } finally { player.stop(); globalThis.Audio = previous; }
});
test("stopping paused browser speech rejects the waiting chunk without playback", async () => {
  class AudioFixture extends EventTarget { src = ""; paused = true; currentTime = 0; plays = 0; async play() { this.plays++; } pause() {} removeAttribute() { this.src = ""; } load() {} }
  const previous = globalThis.Audio; globalThis.Audio = AudioFixture as unknown as typeof Audio;
  const player = new SpeechPlayer(), abort = new AbortController();
  try {
    player.pause(); const playback = player.play({ index: 0, total: 1, text: "", audio: "AA==", boundaries: [] }, abort.signal, () => {});
    abort.abort(new Error("stopped")); player.stop(); await assert.rejects(playback, /stopped/);
    assert.equal((player.audio as unknown as AudioFixture).plays, 0);
  } finally { player.stop(); globalThis.Audio = previous; }
});
test("ownership needs both the browser identity and matching run", () => {
  assert.throws(() => requireOwner("one", "new", call("stop", "old")), /own/);
  assert.doesNotThrow(() => requireOwner("one", "new", call("stop", "new")));
});
test("source-only Pi Web adapter fails closed and leaves inputs unchanged", async () => {
  const { adaptSources, hostFiles } = await import("../integration/pi-web/adapter.mjs");
  const files = Object.fromEntries(hostFiles.map((path: string) => [path, "changed upstream"]));
  assert.throws(() => adaptSources(files), /compatibility check failed/);
  assert.equal(files[hostFiles[0]], "changed upstream");
});
test("Pi Web route rejects raw tool/thinking access and caps audio/control bodies", () => {
  const source = readFileSync(new URL("../integration/pi-web/server/route.ts", import.meta.url), "utf8");
  assert.match(source, /isApiRequestAllowed/); assert.match(source, /isValidWebSessionToken/); assert.match(source, /6 \* 1024 \* 1024/); assert.match(source, /128 \* 1024/);
  assert.ok(!source.includes("tool-result-image")); assert.ok(!source.includes("entries/[entryId]/thinking"));
});
