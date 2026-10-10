import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { requireOwner, emitBrowser, type BrowserAdapter, type BrowserCall } from "../../shared/browser.ts";
import { claimMicrophone } from "../../shared/microphone.ts";
import { resolveCodexVoiceAuth, transcribeWithCodex } from "../../shared/codex.ts";
import { applyVoiceDictionary, loadVoiceDictionary } from "./dictionary.ts";
import { prepareWavForTranscription } from "./audio.ts";

interface Run {
  id: string; client: string; abort: AbortController; release(): void;
  auth?: Awaited<ReturnType<typeof resolveCodexVoiceAuth>>;
  dictionary?: Awaited<ReturnType<typeof loadVoiceDictionary>>;
  pending: Set<Promise<unknown>>; final?: Promise<unknown>; timer?: ReturnType<typeof setTimeout>;
}
export class BrowserDictation implements BrowserAdapter {
  private run?: Run;
  isActive(): boolean { return Boolean(this.run); }
  constructor(private readonly ctx: ExtensionContext, private readonly deps = {
    auth: resolveCodexVoiceAuth, transcribe: transcribeWithCodex, dictionary: loadVoiceDictionary,
  }) {}
  async handle(call: BrowserCall): Promise<unknown> {
    if (call.action === "start") {
      if (this.run) throw new Error("A microphone run is already active. Stop it first.");
      const run: Run = { id: call.run ?? crypto.randomUUID(), client: call.client, abort: new AbortController(), release: claimMicrophone(this.ctx.sessionManager.getSessionId(), "dictation"), pending: new Set() };
      this.run = run;
      run.timer = setTimeout(() => { void this.cancel(); }, 200_000);
      run.timer.unref?.();
      try {
        run.auth = await this.deps.auth(this.ctx);
        run.dictionary = await this.deps.dictionary();
        if (this.run !== run || run.abort.signal.aborted || call.signal.aborted) throw new Error("Dictation startup cancelled.");
        return { run: run.id };
      } catch (error) { if (this.run === run) await this.cancel(); throw error; }
    }
    const run = this.run;
    requireOwner(run?.client, run?.id, call);
    if (!run) throw new Error("Dictation is not recording.");
    if (call.action === "cancel") { await this.cancel(); return {}; }
    if (call.action !== "preview" && call.action !== "finish") throw new Error("Unknown dictation action.");
    if (run.final) { if (call.action === "finish") return run.final; throw new Error("Final transcription is in progress."); }
    if (run.pending.size) throw new Error("A transcription is already in progress.");
    if (!call.audio || call.audio.byteLength > 6 * 1024 * 1024) throw new Error("A bounded WAV recording is required.");
    const prepared = prepareWavForTranscription(call.audio);
    if (prepared.audio.byteLength < 48_044 || prepared.audio.byteLength > 44 + 120 * 24_000 * 2) throw new Error("Record between one second and two minutes.");
    const signal = AbortSignal.any([call.signal, run.abort.signal, AbortSignal.timeout(call.action === "preview" ? 8_000 : 60_000)]);
    const operation = (async () => {
      const transcript = await this.deps.transcribe(prepared.audio, run.auth!, signal);
      if (this.run !== run || run.abort.signal.aborted || signal.aborted) throw new Error("Transcription cancelled.");
      return { text: applyVoiceDictionary(transcript, run.dictionary!) };
    })();
    run.pending.add(operation);
    if (call.action === "finish") run.final = operation;
    try { return await operation; }
    finally {
      run.pending.delete(operation);
      if (call.action === "finish" && this.run === run) { this.run = undefined; clearTimeout(run.timer); run.release(); }
    }
  }
  async cancel(): Promise<void> {
    const run = this.run;
    this.run = undefined;
    if (!run) return;
    clearTimeout(run.timer);
    run.abort.abort(new Error("Dictation cancelled."));
    await Promise.allSettled([...run.pending]);
    run.release();
    emitBrowser(this.ctx.sessionManager.getSessionId(), "dictation", "closed", {}, run.client, run.id);
  }
  async disconnect(client: string): Promise<void> { if (this.run?.client === client) await this.cancel(); }
  async dispose(): Promise<void> { await this.cancel(); }
}
