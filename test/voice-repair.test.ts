import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BrowserLive } from "../packages/live/browser.ts";
import type { BrowserCall } from "../shared/browser.ts";
import { claimMicrophone } from "../shared/microphone.ts";
import { voiceShortcut, VOICE_SHORTCUTS } from "../shared/shortcuts.ts";
import { waitForLivePeer } from "../integration/pi-web/client/media.ts";
import { transcribeWithCodex, CodexTranscriptionBlocked } from "../shared/codex.ts";
import { TranscriptPreview } from "../packages/dictation/preview.ts";
const call = (action: string, client = "owner"): BrowserCall => ({ action, client, run: "run", body: { offer: "v=0\r\nfixture" }, signal: new AbortController().signal });
const ctx = () => ({ cwd: process.cwd(), isIdle: () => true, sessionManager: SessionManager.inMemory() }) as unknown as ExtensionContext;
const auth = async () => ({ accessToken: "fixture", accountId: "fixture", baseUrl: "https://invalid.example" });
test("browser Live returns its SDP before waiting for peer and sideband, then acknowledges readiness", async () => {
  const context = ctx(); let sideband = 0;
  const live = new BrowserLive({ sendUserMessage: () => {} } as unknown as ExtensionAPI, context, () => "marin", () => true, { auth,
    transport: options => ({ connect: async () => { options.onBrowserAnswer!("answer"); await options.waitForBrowserPeer!(); sideband++; }, send: async () => {}, close: async () => {}, pushAudio: () => {}, setMuted: () => {} }) });
  assert.deepEqual(await live.handle(call("start")), { run: "run", answer: "answer" }); assert.equal(sideband, 0);
  await assert.rejects(live.handle(call("connected", "other")), /own/);
  assert.deepEqual(await live.handle(call("connected")), { phase: "listening" }); assert.equal(sideband, 1);
  await live.dispose(); const release = claimMicrophone(context.sessionManager.getSessionId(), "dictation"); release();
});
test("cancelling browser Live between SDP and peer acknowledgement closes startup and releases input", async () => {
  const context = ctx(); let sideband = 0;
  const live = new BrowserLive({} as ExtensionAPI, context, () => "marin", () => true, { auth,
    transport: options => ({ connect: async () => { options.onBrowserAnswer!("answer"); await options.waitForBrowserPeer!(); sideband++; }, send: async () => {}, close: async () => {}, pushAudio: () => {}, setMuted: () => {} }) });
  await live.handle(call("start")); await live.disconnect("owner");
  assert.equal(live.isActive(), false); assert.equal(sideband, 0);
  const release = claimMicrophone(context.sessionManager.getSessionId(), "dictation"); release();
});
test("signaling failure rejects startup instead of waiting forever for SDP", async () => {
  const live = new BrowserLive({} as ExtensionAPI, ctx(), () => "marin", () => true, { auth,
    transport: () => ({ connect: async () => { throw Error("signaling forbidden (403)"); }, send: async () => {}, close: async () => {}, pushAudio: () => {}, setMuted: () => {} }) });
  await assert.rejects(live.handle(call("start")), /signaling forbidden/); assert.equal(live.isActive(), false);
});
test("browser peer readiness is bounded and reports ICE failures", async () => {
  class Peer extends EventTarget { connectionState = "connecting"; iceConnectionState = "checking"; }
  const peer = new Peer(); const signal = new AbortController().signal;
  const ready = waitForLivePeer(peer as RTCPeerConnection, signal, 100);
  peer.connectionState = "connected"; peer.dispatchEvent(new Event("connectionstatechange")); await ready;
  peer.connectionState = "connecting"; await assert.rejects(waitForLivePeer(peer as RTCPeerConnection, signal, 5), /timed out.*ICE checking/);
  peer.iceConnectionState = "failed"; await assert.rejects(waitForLivePeer(peer as RTCPeerConnection, signal), /WebRTC failed/);
});
test("voice shortcuts use one modifier family, reject AltGraph and do not take old browser/IME keys", () => {
  const event = { ctrlKey: true, altKey: true, shiftKey: false, metaKey: false, code: "KeyM" };
  assert.equal(voiceShortcut(event), "dictation"); assert.equal(voiceShortcut({ ...event, code: "KeyL" }), "live");
  assert.equal(voiceShortcut({ ...event, code: "KeyV" }), "tts"); assert.equal(voiceShortcut({ ...event, altKey: false, shiftKey: true, code: "KeyL" }), undefined);
  assert.equal(voiceShortcut({ ...event, altKey: false, code: "Space" }), undefined);
  assert.equal(voiceShortcut({ ...event, getModifierState: key => key === "AltGraph" }), undefined);
  assert.deepEqual(Object.values(VOICE_SHORTCUTS), ["ctrl+alt+m", "ctrl+alt+l", "ctrl+alt+v"]);
});
test("Cloudflare is an explicit non-retryable endpoint failure, not proof of valid credentials", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes("/codex/models") ? new Response("{}") : new Response("challenge", { status: 403, headers: { "cf-mitigated": "challenge", "cf-ray": "fixture-ray" } });
  try {
    await assert.rejects(transcribeWithCodex(new Uint8Array(48_044), { ...await auth(), accountId: "challenge-test" }, new AbortController().signal), error => {
      assert.ok(error instanceof CodexTranscriptionBlocked); assert.equal(error.retryable, false); assert.match(error.message, /does not establish whether your credentials are valid/); assert.ok(!error.message.includes("Local Whisper")); assert.ok(!error.message.includes("session is valid")); return true;
    });
  } finally { globalThis.fetch = previous; }
});
test("a permanent preview failure is surfaced once without repeated uploads or lost recording", async () => {
  let calls = 0; const errors: unknown[] = [];
  const preview = new TranscriptPreview({ intervalMs: 1, transcribe: async () => { calls++; throw new CodexTranscriptionBlocked("Cloudflare"); }, onText: () => assert.fail(), onUnavailable: error => errors.push(error) });
  try { preview.append(new Uint8Array(48_000)); await new Promise(resolve => setTimeout(resolve, 20)); preview.append(new Uint8Array(48_000)); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(calls, 1); assert.equal(errors.length, 1); }
  finally { await preview.cancel(); }
});
