import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveVoiceAuth as resolveExplicitVoiceAuth, resolveCodexVoiceAuth, transcribeWithCodex } from "../shared/codex.ts";
import { CodexLiveTransport, buildLiveSignalingUrl, buildLiveSidebandUrl, buildLiveHeaders, parseLiveCallId } from "../packages/live/transport.ts";
const resolveVoiceAuth = (ctx: ExtensionContext) => resolveExplicitVoiceAuth(ctx, "openai");
const token = "fixture." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" } })).toString("base64url") + ".fixture";
const context = (baseUrl: string, apiKey: string, oauth = false) => ({ model: { provider: "openai", api: "openai-responses", baseUrl }, modelRegistry: {
  getProvider: (id: string) => { assert.equal(id, "openai"); return { id, baseUrl, getModels: () => [{ id: "chat-model", provider: id, api: "openai-responses", baseUrl }] }; },
  getApiKeyAndHeaders: async (model: { id: string; provider: string }) => { assert.equal(model.id, "pi-voice"); assert.equal(model.provider, "openai"); return { ok: true, apiKey, baseUrl, headers: { "X-Cockpit-Scope": "fixture-bound-account" } }; },
  isUsingOAuth: () => oauth,
  getProviderAuth: (provider: string) => { assert.equal(provider, "openai", "Must not switch providers/accounts"); return { source: oauth ? "OAuth" : "API key", auth: { apiKey } }; },
} }) as unknown as ExtensionContext;

test("selected OpenAI endpoint uses its own resolved base URL/key/headers without Codex login or fallback", async () => {
  const auth = await resolveVoiceAuth(context("http://127.0.0.1:30100/v1/", "fixture-cockpit-key"));
  assert.equal(auth.route, "openai"); assert.equal(auth.baseUrl, "http://127.0.0.1:30100/v1"); assert.equal(auth.accountId, "");
  assert.equal(auth.accessToken, "fixture-cockpit-key"); assert.equal(auth.headers?.["X-Cockpit-Scope"], "fixture-bound-account");
  const headers = buildLiveHeaders(auth, "session", "realtime", "must-not-send");
  assert.equal(headers.authorization, "Bearer fixture-cockpit-key"); assert.equal(headers["chatgpt-account-id"], undefined); assert.equal(headers["x-oai-attestation"], undefined);
});
test("direct Codex OAuth normalizes Pi's /backend-api/codex model endpoint before appending voice routes", async () => {
  const auth = await resolveVoiceAuth(context("https://chatgpt.com/backend-api/codex/", token, true));
  assert.equal(auth.route, undefined); assert.equal(auth.accountId, "fixture-account"); assert.equal(auth.baseUrl, "https://chatgpt.com/backend-api");
  assert.equal(new URL(buildLiveSignalingUrl(auth.baseUrl)).pathname, "/backend-api/codex/realtime/calls");
  assert.equal(buildLiveSidebandUrl("rtc_fixture", auth), "wss://api.openai.com/v1/live/rtc_fixture");
  const canonical = await resolveCodexVoiceAuth({ modelRegistry: { getProvider: () => ({ auth: { oauth: {} }, baseUrl: "https://chatgpt.com/backend-api/codex" }), getProviderAuth: async () => ({ source: "OAuth", auth: { apiKey: token } }) } } as unknown as ExtensionContext);
  assert.equal(canonical.baseUrl, "https://chatgpt.com/backend-api");
  await assert.rejects(resolveVoiceAuth(context("https://chatgpt.com/backend-api/codex", "fixture-key")), /requires Pi's Codex login/);
});
test("request-time OAuth works before provider availability snapshots are refreshed", async () => {
  const ctx = context("https://chatgpt.com/backend-api/codex", token, true);
  ctx.modelRegistry.isUsingOAuth = () => false;
  assert.equal((await resolveVoiceAuth(ctx)).accountId, "fixture-account");
});
test("a selected official API-key endpoint cannot become a paid Speech fallback", async () => {
  await assert.rejects(resolveVoiceAuth(context("https://api.openai.com/v1", "fixture-key")), /official paid Speech API is not a fallback/);
});
test("Cockpit transcription uses the documented multipart route and does not prime an unrelated OAuth service", async () => {
  const original = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push(String(input)); assert.equal(String(input), "http://127.0.0.1:30100/v1/audio/transcriptions");
    const headers = new Headers(init?.headers); assert.equal(headers.get("Authorization"), "Bearer fixture-cockpit-key"); assert.equal(headers.get("ChatGPT-Account-Id"), null); assert.equal(headers.get("Content-Type"), null);
    const body = init!.body as FormData; assert.equal(body.get("model"), "whisper-1"); assert.equal(body.get("response_format"), "json"); assert.equal((body.get("file") as Blob).size, 48_044);
    return Response.json({ text: "fixture transcript" });
  };
  try {
    const auth = await resolveVoiceAuth(context("http://127.0.0.1:30100/v1", "fixture-cockpit-key"));
    assert.equal(await transcribeWithCodex(new Uint8Array(48_044), auth, new AbortController().signal), "fixture transcript"); assert.equal(requests.length, 1);
  } finally { globalThis.fetch = original; }
});
test("Cockpit Live bootstrap and frameless sideband both stay on the configured gateway/account", async () => {
  const server = createServer((request, response) => {
    assert.equal(new URL(request.url!, "http://fixture").pathname, "/v1/realtime/calls"); assert.equal(request.headers.authorization, "Bearer fixture-cockpit-key");
    assert.equal(request.headers["x-cockpit-scope"], "fixture-bound-account"); assert.equal(request.headers["chatgpt-account-id"], undefined);
    let body = ""; request.setEncoding("utf8"); request.on("data", part => body += part); request.on("end", () => {
      const value = JSON.parse(body); assert.equal(value.session.model, "gpt-live-1-codex"); assert.deepEqual(value.session.delegation, { type: "client" });
      response.writeHead(201, { "Content-Type": "application/json", Location: "https://untrusted.invalid/v1/live/rtc_fixture" }); response.end(JSON.stringify({ sdp: "v=0\r\nfixture-answer" }));
    });
  });
  const wss = new WebSocketServer({ noServer: true }); let sideband = "", answer = "", received = "";
  server.on("upgrade", (request, socket, head) => {
    sideband = request.url!; assert.equal(sideband, "/v1/live/rtc_fixture"); assert.equal(request.headers.authorization, "Bearer fixture-cockpit-key"); assert.equal(request.headers["x-cockpit-scope"], "fixture-bound-account");
    wss.handleUpgrade(request, socket, head, ws => { ws.on("message", value => received = value.toString()); wss.emit("connection", ws, request); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  let transport: CodexLiveTransport | undefined;
  try {
  const auth = await resolveVoiceAuth(context(`http://127.0.0.1:${port}/v1`, "fixture-cockpit-key"));
  transport = new CodexLiveTransport({ sessionId: "fixture", instructions: "Fixture instructions", voice: "sol", getAuth: async () => auth, browserOffer: "v=0\r\nfixture", onBrowserAnswer: value => answer = value, waitForBrowserPeer: async () => {}, callbacks: { onEvent: () => {}, onOutputLevel: () => {} } });
    await transport.connect(); assert.equal(answer, "v=0\r\nfixture-answer"); assert.equal(transport.connected, true);
    await transport.send({ type: "session.close" }); for (let i = 0; i < 50 && !received; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(JSON.parse(received).type, "session.close");
  } finally {
    await transport?.close(); for (const client of wss.clients) client.terminate();
    await new Promise<void>(resolve => wss.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
test("gateway sideband URLs cannot be replaced by an upstream Location and call IDs are bounded", () => {
  assert.equal(parseLiveCallId("/v1/realtime/calls/rtc_fixture"), "rtc_fixture"); assert.equal(parseLiveCallId("/v1/realtime?call_id=rtc_fixture"), "rtc_fixture"); assert.equal(parseLiveCallId("../invalid/path"), undefined);
  assert.equal(parseLiveCallId("rtc_" + "x".repeat(200)), undefined);
  const auth = { accessToken: "fixture", accountId: "", baseUrl: "https://gateway.invalid/prefix/v1", route: "openai" as const };
  assert.equal(buildLiveSidebandUrl("rtc_fixture", auth), "wss://gateway.invalid/prefix/v1/live/rtc_fixture");
});
