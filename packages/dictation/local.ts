import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { prepareWavForTranscription } from "./audio.ts";
export const LOCAL_MODEL = "onnx-community/whisper-tiny";
export const LOCAL_REVISION = "ff4177021cc41f7db950912b73ea4fdf7d01d8e7";
const require = createRequire(import.meta.url);
// An owned worker isolates CPU inference and downloads; cancellation terminates both.
// eval avoids Node's prohibition on stripping TypeScript inside installed node_modules.
const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
(async () => {
  const { pipeline, env } = await import(workerData.moduleUrl);
  env.cacheDir = workerData.cache; env.allowLocalModels = false;
  parentPort.postMessage({ progress: 'Local Whisper: loading model; first use downloads its public model files.' });
  const pipe = await pipeline('automatic-speech-recognition', workerData.model, {
    revision: workerData.revision, device: 'cpu', dtype: 'q8',
    progress_callback: data => { if (data.status === 'download' || data.status === 'done') parentPort.postMessage({ progress: 'Local Whisper: loading/downloading ' + (data.file || 'model') }); }
  });
  parentPort.postMessage({ progress: 'Local Whisper: transcribing on server CPU; audio stays on this machine.' });
  const result = await pipe(workerData.samples, { chunk_length_s: 30, stride_length_s: 5, language: workerData.language, task: 'transcribe', return_timestamps: false });
  parentPort.postMessage({ text: result.text });
})().catch(error => parentPort.postMessage({ error: error.message }));
`;
export function wavToLocalSamples(audio: Uint8Array): Float32Array<ArrayBuffer> {
  const wav = prepareWavForTranscription(audio).audio;
  const data = new DataView(wav.buffer, wav.byteOffset + 44, wav.byteLength - 44);
  const count = data.byteLength / 2;
  if (count < 24_000 || count > 120 * 24_000) throw new Error("Record between one second and two minutes.");
  const samples = new Float32Array(Math.floor(count * 16_000 / 24_000));
  for (let index = 0; index < samples.length; index++) {
    const position = index * 1.5, left = Math.floor(position), right = Math.min(left + 1, count - 1), fraction = position - left;
    samples[index] = (data.getInt16(left * 2, true) * (1 - fraction) + data.getInt16(right * 2, true) * fraction) / 32_768;
  }
  return samples;
}
export async function transcribeLocal(audio: Uint8Array, signal: AbortSignal, progress: (message: string) => void = () => {}): Promise<string> {
  signal.throwIfAborted();
  let moduleUrl: string;
  try { moduleUrl = pathToFileURL(require.resolve("@huggingface/transformers")).href; }
  catch { throw new Error("Local Whisper is not installed. Reinstall pi-dictation with npm optional dependencies enabled."); }
  const samples = wavToLocalSamples(audio);
  const env = { ...process.env }; delete env.HF_TOKEN; delete env.HUGGING_FACE_HUB_TOKEN;
  const worker = new Worker(workerCode, { eval: true, env,
    workerData: { moduleUrl, model: LOCAL_MODEL, revision: LOCAL_REVISION, samples, language: process.env.PI_DICTATION_LANGUAGE ?? "en", cache: join(getAgentDir(), "voice-models") }, transferList: [samples.buffer] });
  try {
    return await new Promise<string>((resolve, reject) => {
      const abort = () => reject(signal.reason ?? new Error("Local transcription cancelled."));
      const message = (value: { progress?: string; text?: string; error?: string }) => {
        if (signal.aborted) return;
        if (value.progress) progress(value.progress);
        if (value.error) reject(new Error("Local Whisper failed: " + value.error));
        if (typeof value.text === "string") { const text = value.text.trim(); if (text) resolve(text); else reject(new Error("No speech was recognized.")); }
      };
      worker.on("message", message); worker.once("error", reject); worker.once("exit", () => reject(new Error("Local Whisper stopped before returning a transcript.")));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void worker.once("exit", () => signal.removeEventListener("abort", abort));
    });
  } finally { await worker.terminate(); }
}
