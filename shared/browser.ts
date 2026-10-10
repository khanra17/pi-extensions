import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const BROWSER_VOICE_VERSION = 1 as const;
export const BROWSER_VOICE_KEY = Symbol.for("@khanra17/pi-extensions/browser-voice/v1");
export type BrowserFeature = "dictation" | "live" | "tts";
export interface BrowserCall {
  action: string;
  client: string;
  run?: string;
  body: Record<string, unknown>;
  audio?: Uint8Array;
  signal: AbortSignal;
}
export interface BrowserAdapter {
  isActive?(): boolean;
  handle(call: BrowserCall): Promise<unknown | Response>;
  disconnect(client: string): Promise<void>;
  dispose(): Promise<void>;
}
export interface BrowserEvent { feature: BrowserFeature; type: string; data: unknown; client?: string; run?: string }
export interface BrowserSession {
  features: Map<BrowserFeature, BrowserAdapter>;
  listeners: Map<string, Set<(event: BrowserEvent) => void>>;
  grace: Map<string, ReturnType<typeof setTimeout>>;
  leases?: Map<BrowserFeature, () => void>;
}
export interface BrowserRegistry {
  version: typeof BROWSER_VOICE_VERSION;
  sessions: Map<string, BrowserSession>;
}
export function browserRegistry(): BrowserRegistry {
  const root = globalThis as unknown as Record<symbol, BrowserRegistry | undefined>;
  let registry = root[BROWSER_VOICE_KEY];
  if (registry && registry.version !== BROWSER_VOICE_VERSION) throw new Error("Incompatible browser voice bridge. Update the integration and extensions together.");
  if (!registry) root[BROWSER_VOICE_KEY] = registry = { version: BROWSER_VOICE_VERSION, sessions: new Map() };
  return registry;
}
export function registerBrowserFeature(ctx: ExtensionContext, feature: BrowserFeature, adapter: BrowserAdapter): () => Promise<void> {
  const registry = browserRegistry();
  const id = ctx.sessionManager.getSessionId();
  let session = registry.sessions.get(id);
  if (!session) registry.sessions.set(id, session = { features: new Map(), listeners: new Map(), grace: new Map() });
  session.leases ??= new Map();
  session.leases.get(feature)?.();
  const previous = session.features.get(feature);
  if (previous && previous !== adapter) void previous.dispose().catch(() => {});
  session.features.set(feature, adapter);
  const liveness = (globalThis as unknown as Record<symbol, { version?: number; register?: (provider: { name: string; sessionId: string; sessionFile?: string; isActive(): boolean }) => () => void } | undefined>)[Symbol.for("@agegr/pi-web/session-liveness/v1")];
  const releaseLease = liveness?.version === 1 ? liveness.register?.({ name: "pi-voice-" + feature, sessionId: id, sessionFile: ctx.sessionManager.getSessionFile(), isActive: () => adapter.isActive?.() ?? false }) : undefined;
  if (releaseLease) session.leases.set(feature, releaseLease);
  return async () => {
    releaseLease?.();
    if (session!.features.get(feature) !== adapter) return;
    session!.features.delete(feature);
    session!.leases?.delete(feature);
    await adapter.dispose();
    emitBrowser(id, feature, "closed", {});
    if (!session!.features.size) {
      for (const timer of session!.grace.values()) clearTimeout(timer);
      registry.sessions.delete(id);
    }
  };
}
export function emitBrowser(id: string, feature: BrowserFeature, type: string, data: unknown, client?: string, run?: string): void {
  const session = browserRegistry().sessions.get(id);
  if (!session) return;
  const event = { feature, type, data, client, run };
  for (const [owner, listeners] of session.listeners) {
    if (client && client !== owner) continue;
    for (const listener of listeners) { try { listener(event); } catch {} }
  }
}
export function requestBrowser(ctx: ExtensionContext, feature: BrowserFeature, action: string, args = ""): boolean {
  const id = ctx.sessionManager.getSessionId();
  const session = browserRegistry().sessions.get(id);
  if (!session?.listeners.size) {
    ctx.ui.notify("Open this session in the voice-enabled Pi Web integration. Stock Pi Web has no browser audio bridge.", "warning");
    return false;
  }
  emitBrowser(id, feature, "request", { action, args });
  return true;
}
export function subscribeBrowser(id: string, client: string, listener: (event: BrowserEvent) => void): () => void {
  const session = browserRegistry().sessions.get(id);
  if (!session) throw new Error("Voice extensions are not loaded in this session.");
  const timer = session.grace.get(client);
  if (timer) clearTimeout(timer);
  session.grace.delete(client);
  let listeners = session.listeners.get(client);
  if (!listeners) session.listeners.set(client, listeners = new Set());
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (listeners!.size) return;
    session.listeners.delete(client);
    const timer = setTimeout(() => {
      session.grace.delete(client);
      for (const adapter of session.features.values()) void adapter.disconnect(client).catch(() => {});
    }, 2_000);
    timer.unref?.();
    session.grace.set(client, timer);
  };
}
export function requireOwner(owner: string | undefined, run: string | undefined, call: BrowserCall): void {
  if (!owner || owner !== call.client || !run || run !== call.run) throw new Error("This browser does not own the active voice run.");
}
/** A bounded, backpressure-aware NDJSON response; cancellation aborts synthesis. */
export function browserStream(produce: (emit: (value: unknown) => Promise<void>, signal: AbortSignal) => Promise<void>, signal: AbortSignal): Response {
  const abort = new AbortController();
  const linked = AbortSignal.any([signal, abort.signal]);
  const encoder = new TextEncoder();
  let wake: (() => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = async (value: unknown) => {
        if (linked.aborted) throw linked.reason;
        while ((controller.desiredSize ?? 0) <= 0) {
          await new Promise<void>((resolve) => {
            const done = () => { linked.removeEventListener("abort", done); resolve(); };
            wake = done;
            linked.addEventListener("abort", done, { once: true });
            if (linked.aborted) done();
          });
          if (linked.aborted) throw linked.reason;
        }
        const bytes = encoder.encode(JSON.stringify(value) + "\n");
        if (bytes.length > 2 * 1024 * 1024) throw new Error("Speech chunk exceeds the bridge limit.");
        controller.enqueue(bytes);
      };
      void produce(emit, linked).then(() => controller.close()).catch((error) => {
        try { controller.error(error); } catch {}
      });
    },
    pull() { wake?.(); wake = undefined; },
    cancel() { abort.abort(new Error("Browser playback disconnected.")); wake?.(); },
  }, { highWaterMark: 1 });
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" } });
}
