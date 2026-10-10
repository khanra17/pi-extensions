import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitBrowser, requireOwner, type BrowserAdapter, type BrowserCall } from "../../shared/browser.ts";
import { resolveCodexVoiceAuth } from "../../shared/codex.ts";
import { LiveSessionController } from "./controller.ts";
import { CodexLiveTransport } from "./transport.ts";
import { buildLiveStartupContext } from "./context.ts";

export class BrowserLive implements BrowserAdapter {
  private active?: { client: string; id: string; abort: AbortController; live: LiveSessionController };
  isActive(): boolean { return Boolean(this.active); }
  constructor(private readonly pi: ExtensionAPI, private readonly ctx: ExtensionContext, private readonly voice: () => string, private readonly enabled: () => boolean) {}
  async handle(call: BrowserCall): Promise<unknown> {
    if (call.action === "start") {
      if (!this.enabled()) throw new Error("Live voice is disabled. Use /live enabled on.");
      if (this.active) throw new Error("Live voice is already active.");
      const offer = call.body.offer;
      if (typeof offer !== "string" || !offer.startsWith("v=0") || offer.length > 64_000) throw new Error("A valid bounded browser SDP offer is required.");
      const id = call.run ?? crypto.randomUUID();
      const abort = new AbortController();
      let answer = "";
      const live = new LiveSessionController({
        sessionId: this.ctx.sessionManager.getSessionId(), captureAudio: false,
        getAuth: () => resolveCodexVoiceAuth(this.ctx),
        voice: this.voice(), startupContext: buildLiveStartupContext(this.ctx), signal: abort.signal,
        createTransport: (options) => new CodexLiveTransport({ ...options, browserOffer: offer, onBrowserAnswer: (value) => { answer = value; } }),
        delegate: (text) => { this.pi.sendUserMessage(text, this.ctx.isIdle() ? undefined : { deliverAs: "followUp" }); },
        callbacks: {
          onPhase: (phase) => emitBrowser(this.ctx.sessionManager.getSessionId(), "live", "phase", { phase }, call.client, id),
          onLevels: () => {},
          onTranscript: (transcript) => emitBrowser(this.ctx.sessionManager.getSessionId(), "live", "transcript", transcript, call.client, id),
          onTerminal: (error) => {
            if (this.active?.id === id) this.active = undefined;
            emitBrowser(this.ctx.sessionManager.getSessionId(), "live", "closed", { error: error?.message }, call.client, id);
          },
        },
      });
      const active = { id, client: call.client, abort, live };
      this.active = active;
      const onAbort = () => { if (this.active === active) void this.dispose(); };
      call.signal.addEventListener("abort", onAbort, { once: true });
      try {
        await live.start();
        if (this.active !== active || call.signal.aborted) throw new Error("Live startup cancelled.");
        return { run: id, answer };
      } catch (error) { if (this.active === active) await this.dispose(); throw error; }
      finally { call.signal.removeEventListener("abort", onAbort); }
    }
    const active = this.active;
    requireOwner(active?.client, active?.id, call);
    if (!active) throw new Error("Live voice is not active.");
    if (call.action === "stop") { await this.dispose(); return {}; }
    if (call.action === "mute") { active.live.toggleMute(); return { muted: active.live.muted }; }
    throw new Error("Unknown Live action.");
  }
  message(message: unknown): void { this.active?.live.handleAgentMessage(message); }
  settled(): void { this.active?.live.handleAgentSettled(); }
  async disconnect(client: string): Promise<void> { if (this.active?.client === client) await this.dispose(); }
  async dispose(): Promise<void> {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    active.abort.abort(new Error("Browser Live stopped."));
    await active.live.stop();
    emitBrowser(this.ctx.sessionManager.getSessionId(), "live", "closed", {}, active.client, active.id);
  }
}
