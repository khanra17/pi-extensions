import { test } from "node:test";
import assert from "node:assert/strict";
import { assistantText, messagePhase, textContent } from "../shared/messages.ts";
import { claimMicrophone } from "../shared/microphone.ts";
import { buildLiveStartupContext } from "../packages/live/context.ts";
import { prepareSpeechText } from "../packages/read-aloud/edge-read-aloud.ts";
import { highlightMarkdown } from "../packages/read-aloud/highlight.ts";
import { validateLiveNativeBindings, resolveLiveNativePackage } from "../packages/live/native.ts";
import { LiveSessionController } from "../packages/live/controller.ts";

const codex = { provider: "openai-codex", api: "openai-codex-responses", id: "test-model" };
test("speech extraction never includes thinking or tool payloads/results", () => {
	const content = [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: "Working update" }, { type: "toolCall", name: "bash", arguments: { command: "SECRET" } }];
	assert.equal(assistantText({ role: "assistant", content, stopReason: "toolUse" }), "Working update");
	assert.equal(assistantText({ role: "toolResult", content: "SECRET" }), "");
	assert.equal(assistantText({ role: "assistant", content, stopReason: "aborted" }), "");
	assert.equal(textContent([{ type: "text", text: "Hello" }, null]), "Hello");
});
test("working update and final annotations remain distinct", () => {
	assert.equal(messagePhase({ content: [{ type: "text", textSignature: JSON.stringify({ phase: "commentary" }) }] }), "commentary");
	assert.equal(messagePhase({ content: [{ type: "text", textSignature: JSON.stringify({ phase: "final_answer" }) }] }), "final");
	assert.equal(messagePhase({ content: [{ type: "text", textSignature: "legacy" }] }), undefined);
});
test("dictation and Live have exclusive, idempotent per-session input ownership", () => {
	const release = claimMicrophone("exclusive", "dictation");
	assert.throws(() => claimMicrophone("exclusive", "live"), /Dictation is active/);
	const independent = claimMicrophone("other-session", "live"); independent();
	release(); release(); const next = claimMicrophone("exclusive", "live"); release();
	assert.throws(() => claimMicrophone("exclusive", "dictation"), /Live voice is active/); next();
});
test("Live context is compaction-aware, Unicode bounded, and excludes hidden payloads", () => {
	const context = buildLiveStartupContext({ cwd: "/workspace", model: codex, isIdle: () => false, sessionManager: {
		getBranch: () => { throw Error("should use context entries"); },
		buildContextEntries: () => [{ type: "compaction", summary: "Earlier summary" }, { type: "message", message: { role: "user", content: "你好世界".repeat(10_000) } }, { type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: "Ready" }] } }, { type: "message", message: { role: "toolResult", toolName: "read", content: "SECRET raw tool data" } }],
	} }, 1_024);
	assert.ok(new TextEncoder().encode(context).length <= 1_024); assert.ok(!context.includes("SECRET")); assert.match(context, /Earlier summary/); assert.match(context, /Ready/); assert.match(context, /read: completed/); assert.ok(!context.includes("�"));
});
test("speech text keeps prose and optionally skips fenced code", () => {
	const source = "Working **update**.\n```ts\nconst secret = 1;\n```\nFinal reply.";
	assert.ok(!prepareSpeechText(source, false).includes("const secret")); assert.ok(prepareSpeechText(source, true).includes("const secret"));
});
test("public Markdown highlighting preserves source and does not mutate code themes", () => {
	assert.equal(highlightMarkdown("Hello world", { source: "Hello world", start: 6, end: 11 }, (text) => `[${text}]`), "Hello [world]");
	const code = "```ts\nhello\n```";
	assert.equal(highlightMarkdown(code, { source: code, start: 6, end: 11 }, () => "MUTATED"), code);
});
test("Live native bindings are optional, validated, and platform-specific", () => {
	assert.equal(resolveLiveNativePackage("win32", "x64"), "@oh-my-pi/pi-natives-win32-x64");
	assert.equal(resolveLiveNativePackage("unknown", "arm"), undefined);
	assert.throws(() => validateLiveNativeBindings({}), /required microphone/);
});
test("stopping Live during delayed transport creation closes the late transport", async () => {
	let resolve!: (value: never) => void, entered = false, closed = 0, connected = 0;
	const transport = { connect: async () => { connected++; }, send: async () => {}, close: async () => { closed++; }, setMuted: () => {}, pushAudio: () => {} };
	const live = new LiveSessionController({ sessionId: "late-live", getAuth: async () => ({ accessToken: "fake", accountId: "fake", baseUrl: "https://invalid.example" }), delegate: () => {}, callbacks: { onPhase: () => {}, onLevels: () => {}, onTranscript: () => {}, onTerminal: () => {} },
		native: { AudioCapture: class { stop() {} }, LiveWebRtcPeer: class {} as never, __ompInstallTokioRuntime: () => {} },
		createTransport: async () => { entered = true; return new Promise((done) => { resolve = done; }); },
	});
	const start = live.start(); assert.equal(entered, true); await live.stop(); resolve(transport as never); await assert.rejects(start, /cancelled/);
	assert.equal(closed, 1); assert.equal(connected, 0); const release = claimMicrophone("late-live", "dictation"); release();
});
