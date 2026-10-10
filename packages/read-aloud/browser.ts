import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitBrowser, browserStream, type BrowserAdapter, type BrowserCall } from "../../shared/browser.ts";
import { fetchVoices, synthesizeChunks, prepareSpeechText } from "./edge-read-aloud.ts";
import { normalizeReaderSettings, type ReaderSettings } from "./reader-settings.ts";

export class BrowserReadAloud implements BrowserAdapter {
  private active?: { client: string; id: string; abort: AbortController; timer?: ReturnType<typeof setTimeout> };
  isActive(): boolean { return Boolean(this.active); }
  constructor(private readonly ctx: ExtensionContext, private readonly get: () => ReaderSettings, private readonly set: (settings: ReaderSettings) => void) {}
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
    if (call.action !== "speak") throw new Error("Unknown read-aloud action.");
    const text = call.body.text;
    if (typeof text !== "string" || text.length > 12_000) throw new Error("Read-aloud accepts at most 12,000 characters per message.");
    await this.dispose();
    const active: NonNullable<typeof this.active> = { client: call.client, id: call.run ?? crypto.randomUUID(), abort: new AbortController() };
    active.timer = setTimeout(() => { if (this.active === active) void this.dispose(); }, 30 * 60_000);
    active.timer.unref?.();
    this.active = active;
    const settings = this.get();
    const source = prepareSpeechText(text, settings.readCode);
    if (!source) { await this.dispose(); throw new Error("This message contains no speakable text."); }
    const signal = AbortSignal.any([call.signal, active.abort.signal]);
    return browserStream(async (emit, streamSignal) => {
      try {
        await synthesizeChunks({ text: source, voice: settings.voice, signal: streamSignal, onChunk: async (chunk) => {
          await emit({ ...chunk, audio: Buffer.from(chunk.audio).toString("base64") });
        } });
      } catch (error) { if (this.active === active) await this.dispose(); throw error; }
    }, signal);
  }
  async disconnect(client: string): Promise<void> { if (this.active?.client === client) await this.dispose(); }
  async dispose(): Promise<void> {
    const active = this.active; this.active = undefined;
    if (!active) return;
    clearTimeout(active.timer); active.abort.abort(new Error("Browser speech stopped."));
    emitBrowser(this.ctx.sessionManager.getSessionId(), "tts", "closed", {}, active.client, active.id);
  }
}
