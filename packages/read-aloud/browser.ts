import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitBrowser, browserStream, requireOwner, type BrowserAdapter, type BrowserCall } from "../../shared/browser.ts";
import { fetchVoices, synthesizeChunks, prepareSpeechText, type SynthesisOptions } from "./edge-read-aloud.ts";
import { normalizeReaderSettings, type ReaderSettings } from "./reader-settings.ts";
import { playableMessageFromEntry } from "./session-playlist.ts";
import { SpeechWindow } from "./speech-window.ts";

interface Active {
  client: string; id: string; abort: AbortController; window: SpeechWindow;
  sent: number; timer?: ReturnType<typeof setTimeout>;
}
export class BrowserReadAloud implements BrowserAdapter {
  private active?: Active;
  isActive(): boolean { return Boolean(this.active); }
  constructor(private readonly ctx: ExtensionContext, private readonly get: () => ReaderSettings, private readonly set: (settings: ReaderSettings) => void,
    private readonly synthesize: (options: SynthesisOptions) => Promise<void> = synthesizeChunks) {}
  private renew(active: Active): void {
    clearTimeout(active.timer);
    active.timer = setTimeout(() => { if (this.active === active) void this.dispose(); }, 30 * 60_000);
    active.timer.unref?.();
  }
  async handle(call: BrowserCall): Promise<unknown | Response> {
    if (call.action === "settings") return this.get();
    if (call.action === "voices") return fetchVoices(AbortSignal.any([call.signal, AbortSignal.timeout(15_000)]));
    if (call.action === "configure") {
      const next: Record<string, unknown> = {};
      for (const key of ["voice", "speed", "volume", "muted", "autoPlay", "readCode", "highlightEnabled"] as const) {
        if (key in call.body) next[key] = call.body[key];
      }
      const settings = normalizeReaderSettings({ ...this.get(), ...next });
      this.set(settings);
      return settings;
    }
    if (this.active && this.active.client !== call.client) throw new Error("Read-aloud is active in another viewing device.");
    if (call.action === "stop") { if (this.active?.id === call.run) await this.dispose(); return {}; }
    if (call.action === "progress") {
      const active = this.active;
      requireOwner(active?.client, active?.id, call);
      const index = call.body.index;
      if (!active || !Number.isInteger(index) || (index as number) < 0 || (index as number) > active.sent) throw new Error("Invalid speech playback position.");
      active.window.advance(index as number); this.renew(active);
      return {};
    }
    if (call.action !== "speak") throw new Error("Unknown read-aloud action.");
    // Resolve visible session messages by ID: long replies never need a giant
    // control request or an arbitrary per-message character rejection.
    let text = call.body.text;
    if (typeof call.body.entryId === "string") {
      const entry = this.ctx.sessionManager.getEntry(call.body.entryId);
      text = entry && playableMessageFromEntry(entry)?.text;
    }
    if (typeof text !== "string") throw new Error("A readable session message is required.");
    const settings = this.get(), source = prepareSpeechText(text, settings.readCode);
    if (!source) throw new Error("This message contains no speakable text.");
    await this.dispose();
    const active: Active = { client: call.client, id: call.run ?? crypto.randomUUID(), abort: new AbortController(), window: new SpeechWindow(), sent: -1 };
    this.active = active; this.renew(active);
    const signal = AbortSignal.any([call.signal, active.abort.signal]);
    return browserStream(async (emit, streamSignal) => {
      try {
        await this.synthesize({ text: source, voice: settings.voice, signal: streamSignal,
          beforeChunk: (index, abort) => active.window.wait(index, abort),
          onChunk: async chunk => {
            active.sent = chunk.index;
            await emit({ ...chunk, audio: Buffer.from(chunk.audio).toString("base64") });
          } });
      } catch (error) { if (this.active === active) await this.dispose(error); throw error; }
    }, signal);
  }
  async disconnect(client: string): Promise<void> { if (this.active?.client === client) await this.dispose(); }
  async dispose(error?: unknown): Promise<void> {
    const active = this.active; this.active = undefined;
    if (!active) return;
    clearTimeout(active.timer); active.abort.abort(new Error("Browser speech stopped."));
    emitBrowser(this.ctx.sessionManager.getSessionId(), "tts", "closed", error ? { error: error instanceof Error ? error.message : String(error) } : {}, active.client, active.id);
  }
}
