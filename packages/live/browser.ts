import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitBrowser, requireOwner, type BrowserAdapter, type BrowserCall } from "../../shared/browser.ts";
import { resolveVoiceAuth } from "../../shared/codex.ts";
import { LiveSessionController, type LiveTransport } from "./controller.ts";
import { CodexLiveTransport, type LiveTransportOptions } from "./transport.ts";
import { buildLiveStartupContext } from "./context.ts";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
interface Active {
  client: string; id: string; abort: AbortController; live: LiveSessionController;
  answer: ReturnType<typeof deferred<string>>; peer: ReturnType<typeof deferred<void>>;
  started: Promise<void>; timer?: ReturnType<typeof setTimeout>;
}
export class BrowserLive implements BrowserAdapter {
  private active?: Active;
  isActive(): boolean { return Boolean(this.active); }
  constructor(private readonly pi: ExtensionAPI, private readonly ctx: ExtensionContext, private readonly voice: () => string, private readonly enabled: () => boolean,
    private readonly deps = { auth: resolveVoiceAuth, transport: (options: LiveTransportOptions): LiveTransport => new CodexLiveTransport(options) }) {}
  async handle(call: BrowserCall): Promise<unknown> {
    if (call.action === "start") {
      if (!this.enabled()) throw new Error("Live voice is disabled. Use /live enabled on.");
      if (this.active) throw new Error("Live voice is already active.");
      const offer = call.body.offer;
      if (typeof offer !== "string" || !offer.startsWith("v=0") || offer.length > 64_000) throw new Error("A valid bounded browser SDP offer is required.");
      const id = call.run ?? crypto.randomUUID(), abort = new AbortController();
      const answer = deferred<string>(), peer = deferred<void>();
      const live = new LiveSessionController({
        sessionId: this.ctx.sessionManager.getSessionId(), captureAudio: false,
        getAuth: () => this.deps.auth(this.ctx), voice: this.voice(), startupContext: buildLiveStartupContext(this.ctx), signal: abort.signal,
        createTransport: options => this.deps.transport({ ...options, browserOffer: offer,
          onBrowserAnswer: value => answer.resolve(value), waitForBrowserPeer: () => peer.promise }),
        delegate: text => { this.pi.sendUserMessage(text, this.ctx.isIdle() ? undefined : { deliverAs: "followUp" }); },
        callbacks: {
          onPhase: phase => emitBrowser(this.ctx.sessionManager.getSessionId(), "live", "phase", { phase }, call.client, id),
          onLevels: () => {},
          onTranscript: transcript => emitBrowser(this.ctx.sessionManager.getSessionId(), "live", "transcript", transcript, call.client, id),
          onTerminal: error => {
            const ended = error ?? new Error("Live voice ended."); answer.reject(ended); peer.reject(ended);
            if (this.active?.id === id) { clearTimeout(this.active.timer); this.active = undefined; }
            emitBrowser(this.ctx.sessionManager.getSessionId(), "live", "closed", { error: error?.message }, call.client, id);
          },
        },
      });
      const active: Active = { id, client: call.client, abort, live, answer, peer, started: Promise.resolve() };
      this.active = active;
      active.timer = setTimeout(() => { if (this.active === active) void this.dispose(new Error("Live startup timed out. Check microphone permission and the browser's WebRTC network connection.")); }, 90_000);
      active.timer.unref?.();
      const onAbort = () => { if (this.active === active) void this.dispose(); };
      call.signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (call.signal.aborted) throw new Error("Live startup cancelled.");
        active.started = live.start(); void active.started.catch(() => {});
        // Return SDP first. Waiting for sideband here deadlocks a browser that has no answer yet.
        const sdp = await answer.promise;
        if (this.active !== active || call.signal.aborted) throw new Error("Live startup cancelled.");
        return { run: id, answer: sdp };
      } catch (error) { if (this.active === active) await this.dispose(); throw error; }
      finally { call.signal.removeEventListener("abort", onAbort); }
    }
    const active = this.active;
    requireOwner(active?.client, active?.id, call);
    if (!active) throw new Error("Live voice is not active.");
    if (call.action === "stop") { await this.dispose(); return {}; }
    if (call.action === "connected") {
      const onAbort = () => { if (this.active === active) void this.dispose(); };
      call.signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (call.signal.aborted) throw new Error("Live startup cancelled.");
        active.peer.resolve(); await active.started;
        if (this.active !== active || call.signal.aborted) throw new Error("Live startup cancelled.");
        clearTimeout(active.timer); return { phase: active.live.phase };
      } finally { call.signal.removeEventListener("abort", onAbort); }
    }
    if (call.action === "mute") { active.live.toggleMute(); return { muted: active.live.muted }; }
    throw new Error("Unknown Live action.");
  }
  message(message: unknown): void { this.active?.live.handleAgentMessage(message); }
  settled(): void { this.active?.live.handleAgentSettled(); }
  async disconnect(client: string): Promise<void> { if (this.active?.client === client) await this.dispose(); }
  async dispose(error?: Error): Promise<void> {
    const active = this.active; if (!active) return;
    this.active = undefined; clearTimeout(active.timer);
    const stopped = error ?? new Error("Browser Live stopped.");
    active.abort.abort(stopped); active.answer.reject(stopped); active.peer.reject(stopped);
    await active.live.stop();
    emitBrowser(this.ctx.sessionManager.getSessionId(), "live", "closed", { error: error?.message }, active.client, active.id);
  }
}
