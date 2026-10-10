import { getRpcSession, startRpcSession } from "@/lib/rpc-manager";
import { resolveSessionPath } from "@/lib/session-reader";
import { isApiRequestAllowed } from "@/lib/request-security";
import { isWebPasswordEnabled, isValidWebSessionToken, isValidBasicAuthorization, PI_WEB_SESSION_COOKIE } from "@/lib/web-auth";
import { browserRegistry, subscribeBrowser, BROWSER_VOICE_VERSION, type BrowserFeature } from "@/lib/pi-voice-bridge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const features = new Set(["dictation", "live", "tts"]);
const clientPattern = /^[a-zA-Z0-9-]{1,80}$/;

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}
function authorize(request: Request): void {
  if (!isApiRequestAllowed(request)) throw new Error("Untrusted voice request.");
  if (!isWebPasswordEnabled()) return;
  const cookie = request.headers.get("cookie")?.split(";").map(value => value.trim()).find(value => value.startsWith(PI_WEB_SESSION_COOKIE + "="))?.slice(PI_WEB_SESSION_COOKIE.length + 1);
  if (!isValidWebSessionToken(cookie) && !isValidBasicAuthorization(request.headers.get("authorization"))) throw new Error("Authentication required.");
}
async function sessionFor(id: string) {
  if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("Invalid session ID.");
  let session = getRpcSession(id);
  if (!session?.isAlive()) {
    const path = await resolveSessionPath(id);
    if (!path) throw new Error("Session not found.");
    session = (await startRpcSession(id, path, undefined)).session;
  }
  // Extension loading is lazy upstream. This is a non-prompt operation.
  await session.send({ type: "get_commands" });
  return browserRegistry().sessions.get(session.sessionId);
}
async function boundedBody(request: Request, limit: number): Promise<Uint8Array> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > limit) throw new Error("Voice request exceeds its size limit.");
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) { await reader.cancel(); throw new Error("Voice request exceeds its size limit."); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const part of parts) { bytes.set(part, at); at += part.length; }
  return bytes;
}
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    authorize(request);
    const { id } = await params;
    const session = await sessionFor(id);
    const url = new URL(request.url);
    if (url.searchParams.get("events") !== "1") return json({ version: BROWSER_VOICE_VERSION, features: [...(session?.features.keys() ?? [])] });
    const client = url.searchParams.get("client") ?? "";
    if (!clientPattern.test(client)) return json({ error: "Invalid browser client." }, 400);
    if (!session) return json({ error: "Install the voice packages and reload this session." }, 409);
    const encoder = new TextEncoder();
    let dispose = () => {};
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const close = () => {
          if (closed) return; closed = true;
          clearInterval(heartbeat); dispose();
          request.signal.removeEventListener("abort", close);
          try { controller.close(); } catch {}
        };
        dispose = subscribeBrowser(id, client, event => {
          if (closed) return;
          if ((controller.desiredSize ?? 0) <= 0) { close(); return; }
          const bytes = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
          if (bytes.length > 128 * 1024) { close(); return; }
          controller.enqueue(bytes);
        });
        controller.enqueue(encoder.encode(": voice-v1\n\n"));
        heartbeat = setInterval(() => {
          if (!closed && (controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
          else close();
        }, 15_000);
        request.signal.addEventListener("abort", close, { once: true });
        if (request.signal.aborted) close();
      },
      cancel() { clearInterval(heartbeat); dispose(); },
    }, { highWaterMark: 64 });
    return new Response(body, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-store", "X-Accel-Buffering": "no" } });
  } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    authorize(request);
    const { id } = await params;
    const session = await sessionFor(id);
    const url = new URL(request.url);
    const feature = url.searchParams.get("feature") ?? "";
    const action = url.searchParams.get("action") ?? "";
    const client = request.headers.get("x-pi-voice-client") ?? "";
    const owned = request.headers.get("x-pi-voice-run") ?? undefined;
    if (owned && !clientPattern.test(owned)) return json({ error: "Invalid voice run." }, 400);
    if (!features.has(feature) || !clientPattern.test(client) || !/^[a-z-]{1,30}$/.test(action)) return json({ error: "Invalid voice request." }, 400);
    const adapter = session?.features.get(feature as BrowserFeature);
    if (!adapter) return json({ error: `The ${feature} extension is not loaded. Install it and reload this session.` }, 409);
    const wav = request.headers.get("content-type")?.split(";")[0] === "audio/wav";
    if (wav && (feature !== "dictation" || !["preview", "finish"].includes(action))) return json({ error: "Unexpected audio body." }, 400);
    if (!wav && request.headers.get("content-type")?.split(";")[0] !== "application/json") return json({ error: "JSON or WAV content type required." }, 415);
    const bytes = await boundedBody(request, wav ? 6 * 1024 * 1024 : 128 * 1024);
    const parsed: unknown = wav ? {} : JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json({ error: "Invalid control body." }, 400);
    const result = await adapter.handle({ action, client, run: owned, body: parsed as Record<string, unknown>, audio: wav ? bytes : undefined, signal: request.signal });
    return result instanceof Response ? result : json(result);
  } catch (error) { return json({ error: error instanceof Error ? error.message : String(error) }, 400); }
}
