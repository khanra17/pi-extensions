import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, ModelRegistry, type ExtensionContext, type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { getVoiceProvider, setVoiceProvider, voiceProviderInfo, voiceProviderPath, configureVoiceProvider } from "../shared/voice-provider.ts";
import { resolveVoiceAuth } from "../shared/codex.ts";
import { resolveDictationAuth } from "../packages/dictation/backend.ts";
import dictation from "../packages/dictation/index.ts";
import liveVoice from "../packages/live/index.ts";
import { BrowserDictation } from "../packages/dictation/browser.ts";
import { BrowserLive } from "../packages/live/browser.ts";
import { registerBrowserFeature, subscribeBrowser } from "../shared/browser.ts";
const token = "fixture." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url") + ".fixture";
async function isolated(run: (directory: string) => Promise<void>) {
  const previous = process.env.PI_CODING_AGENT_DIR, directory = await mkdtemp(join(tmpdir(), "pi-voice-providers-"));
  process.env.PI_CODING_AGENT_DIR = directory;
  try { await run(directory); }
  finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; await rm(directory, { recursive: true, force: true }); }
}
async function context(directory: string): Promise<ExtensionContext> {
  await writeFile(join(directory, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: "http://localhost:18080/v1", headers: { "X-Scope": "fixture" }, modelOverrides: { "gpt-5.5": { headers: { "X-Chat-Only": "must-not-leak" } } } } } }));
  await writeFile(join(directory, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "fixture-cockpit-key" }, "openai-codex": { type: "oauth", access: token, refresh: "fixture-refresh", expires: Date.now() + 3600_000 } }));
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json"), refreshOnCreate: false });
  return { modelRegistry: new ModelRegistry(runtime), sessionManager: SessionManager.inMemory(), cwd: directory, isIdle: () => true } as unknown as ExtensionContext;
}
const call = (action: string, body = {}) => ({ action, body, client: "owner", run: "provider-run", signal: new AbortController().signal });

test("dictation and Live preferences persist independently, default to Codex, and contain no keys or endpoints", async () => isolated(async directory => {
  assert.equal(await getVoiceProvider("dictation"), "openai-codex"); assert.equal(await getVoiceProvider("live"), "openai-codex");
  await writeFile(voiceProviderPath("dictation"), JSON.stringify({ unrelated: true }));
  await setVoiceProvider("dictation", "openai"); assert.equal(await getVoiceProvider("dictation"), "openai"); assert.equal(await getVoiceProvider("live"), "openai-codex");
  await setVoiceProvider("live", "openai"); await setVoiceProvider("dictation", "codex");
  assert.equal(await getVoiceProvider("live"), "openai"); assert.equal(await getVoiceProvider("dictation"), "openai-codex");
  const stored = JSON.parse(await readFile(voiceProviderPath("dictation"), "utf8")); assert.deepEqual(stored, { unrelated: true, provider: "openai-codex" });
  assert.ok(!JSON.stringify(stored).includes("fixture-cockpit-key"));
  await assert.rejects(setVoiceProvider("live", "../auth.json"), /provider ID/);
}));
test("real Pi registry uses OpenAI's configured base URL/key for dictation while chat stays on Codex", async () => isolated(async directory => {
  const ctx = await context(directory);
  Object.defineProperty(ctx, "model", { get: () => { throw Error("Voice auth must not consult or change the chat model"); } });
  await setVoiceProvider("dictation", "openai");
  const auth = await resolveDictationAuth(ctx);
  assert.equal(auth.baseUrl, "http://localhost:18080/v1"); assert.equal(auth.route, "openai"); assert.equal(auth.accessToken, "fixture-cockpit-key");
  assert.equal(auth.headers?.["X-Chat-Only"] ?? auth.headers?.["x-chat-only"], undefined);
  assert.equal(auth.headers?.["X-Scope"] ?? auth.headers?.["x-scope"], "fixture");
  const liveAuth = await resolveVoiceAuth(ctx, await getVoiceProvider("live"));
  assert.equal(liveAuth.route, undefined); assert.equal(liveAuth.accessToken, token); assert.equal(liveAuth.accountId, "fixture-account");
  const info = await voiceProviderInfo(ctx, "dictation"); assert.equal(info.endpoint, "http://localhost:18080/v1"); assert.equal(info.provider, "openai");
  assert.ok(!JSON.stringify(info).includes("fixture-cockpit-key"));
}));
test("switching chat models cannot redirect an explicitly selected voice provider or make it fall back", async () => isolated(async directory => {
  const ctx = await context(directory);
  const first = await resolveVoiceAuth(ctx, "openai");
  Object.defineProperty(ctx, "model", { value: { provider: "anthropic", api: "anthropic-messages", baseUrl: "https://api.anthropic.com" } });
  assert.deepEqual(await resolveVoiceAuth(ctx, "openai"), first);
  await assert.rejects(resolveVoiceAuth(ctx, "missing-voice-provider"), /not configured/);
}));
test("browser provider settings broadcasts are feature-scoped and do not change chat or read-aloud", async () => isolated(async directory => {
  const ctx = await context(directory), seen: string[] = [];
  const remove = registerBrowserFeature(ctx, "dictation", { handle: async () => ({}), disconnect: async () => {}, dispose: async () => {} });
  const unsubscribe = subscribeBrowser(ctx.sessionManager.getSessionId(), "owner", event => seen.push(event.feature + ":" + event.type));
  try {
    const info = await configureVoiceProvider(ctx, "dictation", "openai"); assert.equal(info.provider, "openai");
    assert.deepEqual(seen, ["dictation:settings"]); assert.equal(await getVoiceProvider("live"), "openai-codex");
    await assert.rejects(configureVoiceProvider(ctx, "dictation", "not-configured"), /not configured/);
    assert.equal(await getVoiceProvider("dictation"), "openai");
  } finally { unsubscribe(); await remove(); }
}));
test("CLI commands choose each voice provider without switching chat", async () => isolated(async directory => {
  const ctx = await context(directory), commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const pi = { on: () => {}, registerShortcut: () => {}, registerTool: () => {}, registerMessageRenderer: () => {}, registerCommand: (name: string, command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }) => commands.set(name, command) } as unknown as ExtensionAPI;
  Object.assign(ctx, { mode: "tui", ui: { notify: () => {} } });
  Object.defineProperty(ctx, "model", { get: () => { throw Error("Provider selection must not inspect chat"); } });
  dictation(pi); liveVoice(pi);
  await commands.get("voice")!.handler("provider openai", ctx);
  assert.equal(await getVoiceProvider("dictation"), "openai"); assert.equal(await getVoiceProvider("live"), "openai-codex");
  await commands.get("live")!.handler("provider openai", ctx);
  await commands.get("voice")!.handler("provider codex", ctx);
  assert.equal(await getVoiceProvider("dictation"), "openai-codex"); assert.equal(await getVoiceProvider("live"), "openai");
}));
test("browser endpoint metadata excludes URL credentials and query tokens", async () => isolated(async directory => {
  const ctx = await context(directory);
  ctx.modelRegistry.registerProvider("openai", { baseUrl: "http://username:fixture-url-key@localhost:18080/v1?api_key=fixture-query-key#private" });
  await setVoiceProvider("dictation", "openai");
  const info = await voiceProviderInfo(ctx, "dictation"); assert.equal(info.endpoint, "http://localhost:18080/v1");
  assert.ok(!JSON.stringify(info).includes("fixture-url-key")); assert.ok(!JSON.stringify(info).includes("fixture-query-key"));
}));
test("an active dictation keeps its captured provider and rejects mid-run changes", async () => isolated(async directory => {
  const ctx = await context(directory);
  const adapter = new BrowserDictation(ctx, { auth: resolveDictationAuth, transcribe: async () => "fixture", dictionary: async () => ({ replacements: {} }) });
  await setVoiceProvider("dictation", "openai");
  await adapter.handle(call("start"));
  try { await assert.rejects(adapter.handle(call("configure", { provider: "openai-codex" })), /Stop dictation/); assert.equal(await getVoiceProvider("dictation"), "openai"); }
  finally { await adapter.dispose(); }
}));
test("Live's own browser settings persist separately and reject changes while starting", async () => isolated(async directory => {
  const ctx = await context(directory);
  const adapter = new BrowserLive({ sendUserMessage: () => {} } as unknown as ExtensionAPI, ctx, () => "sol", () => true, {
    auth: async () => resolveVoiceAuth(ctx, await getVoiceProvider("live")),
    transport: options => ({ connect: async () => { options.onBrowserAnswer!("fixture-answer"); await options.waitForBrowserPeer!(); }, send: async () => {}, close: async () => {}, pushAudio: () => {}, setMuted: () => {} }) });
  const info = await adapter.handle(call("configure", { provider: "openai" })) as { provider: string };
  assert.equal(info.provider, "openai"); assert.equal(await getVoiceProvider("dictation"), "openai-codex");
  await adapter.handle(call("start", { offer: "v=0\r\nfixture" }));
  try { await assert.rejects(adapter.handle(call("configure", { provider: "openai-codex" })), /Stop Live/); }
  finally { await adapter.dispose(); }
}));
