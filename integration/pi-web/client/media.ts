export interface SpeechChunk { index: number; total: number; text: string; audio: string; boundaries: Array<{ offsetSeconds: number; durationSeconds: number; text: string }> }
export class PcmCapture {
  private stream?: MediaStream;
  private context?: AudioContext;
  private node?: AudioWorkletNode;
  private source?: MediaStreamAudioSourceNode;
  private flushed?: () => void;
  private generation = 0;
  private parts: Float32Array[] = [];
  private samples = 0;
  sampleRate = 48_000;
  async start(): Promise<void> {
    if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access requires HTTPS (or localhost).");
    const generation = ++this.generation;
    try {
      const context = this.context = new AudioContext();
      this.sampleRate = context.sampleRate;
      const media = navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }).then(stream => {
        if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); throw new Error("Recording cancelled."); }
        this.stream = stream; return stream;
      });
      const [stream] = await Promise.all([media, context.resume()]);
      await context.audioWorklet.addModule("/pi-voice/pcm-worklet.js");
      if (generation !== this.generation) throw new Error("Recording cancelled.");
      const node = this.node = new AudioWorkletNode(context, "pi-voice-pcm");
      node.port.onmessage = ({ data }: MessageEvent<Float32Array | { flushed: true }>) => {
        if (!(data instanceof Float32Array)) { this.flushed?.(); this.flushed = undefined; return; }
        if (generation !== this.generation || this.samples >= this.sampleRate * 120) return;
        const remaining = this.sampleRate * 120 - this.samples;
        const part = data.length <= remaining ? data : data.slice(0, remaining);
        this.parts.push(part); this.samples += part.length;
      };
      const source = this.source = context.createMediaStreamSource(stream);
      source.connect(node); node.connect(context.destination);
    } catch (error) { this.stop(); throw error; }
  }
  wav(): Uint8Array {
    const source = new Float32Array(this.samples);
    let at = 0;
    for (const part of this.parts) { source.set(part, at); at += part.length; }
    const rate = 24_000;
    const length = Math.floor(source.length * rate / this.sampleRate);
    const output = new Uint8Array(44 + length * 2);
    const view = new DataView(output.buffer);
    const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) output[offset + i] = value.charCodeAt(i); };
    text(0, "RIFF"); view.setUint32(4, output.length - 8, true); text(8, "WAVEfmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    text(36, "data"); view.setUint32(40, length * 2, true);
    for (let i = 0; i < length; i++) {
      const from = i * this.sampleRate / rate, to = (i + 1) * this.sampleRate / rate;
      let sum = 0, weight = 0;
      for (let j = Math.floor(from); j < Math.ceil(to); j++) {
        const w = Math.min(to, j + 1) - Math.max(from, j);
        sum += (source[j] ?? 0) * w; weight += w;
      }
      const sample = Math.max(-1, Math.min(1, sum / (weight || 1)));
      view.setInt16(44 + i * 2, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
    }
    return output;
  }
  async finish(): Promise<Uint8Array> {
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.node) await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, 150);
      this.flushed = () => { clearTimeout(timer); resolve(); };
      this.node!.port.postMessage("flush");
    });
    const audio = this.wav(); this.stop(); return audio;
  }
  stop(): void {
    ++this.generation;
    this.flushed?.(); this.flushed = undefined;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = undefined;
    this.node?.disconnect(); this.node = undefined; this.source?.disconnect(); this.source = undefined;
    void this.context?.close().catch(() => {}); this.context = undefined; this.parts = []; this.samples = 0;
  }
}
export async function* speechChunks(response: Response, signal: AbortSignal): AsyncGenerator<SpeechChunk> {
  if (!response.body) throw new Error("Speech stream is missing.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 2 * 1024 * 1024) throw new Error("Speech stream exceeded its size limit.");
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        if (line.trim()) yield JSON.parse(line) as SpeechChunk;
      }
    }
    if (pending.trim()) throw new Error("Incomplete speech stream.");
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class SpeechPlayer {
  readonly audio = new Audio();
  private url?: string;
  private cancel?: () => void;
  private resumeWait?: () => void;
  paused = false;
  pause(): void { this.paused = true; this.audio.pause(); }
  async resume(): Promise<void> { this.paused = false; this.resumeWait?.(); if (this.audio.src) await this.audio.play(); }
  private timer?: ReturnType<typeof setInterval>;
  prime(): void {
    // Unlock a persistent element directly in the user's click, before network work.
    if (!this.audio.paused) return;
    if (!this.audio.src) {
      const bytes = new Uint8Array(44 + 4800), view = new DataView(bytes.buffer);
      const text = (at: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[at + i] = value.charCodeAt(i); };
      text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
      view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 24000, true); view.setUint32(28, 48000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, 4800, true);
      this.url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })); this.audio.src = this.url;
    }
    const source = this.audio.src;
    void this.audio.play().then(() => { if (this.audio.src === source) this.audio.pause(); }).catch(() => {});
  }
  async play(chunk: SpeechChunk, signal: AbortSignal, boundary: (word: string) => void): Promise<void> {
    if (signal.aborted) throw signal.reason;
    if (this.paused) await new Promise<void>((resolve, reject) => {
      const cleanup = () => { signal.removeEventListener("abort", abort); this.resumeWait = undefined; };
      const abort = () => { cleanup(); reject(signal.reason); };
      this.resumeWait = () => { cleanup(); resolve(); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    if (signal.aborted) throw signal.reason;
    const binary = atob(chunk.audio), bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(new Blob([bytes], { type: "audio/mpeg" }));
    this.audio.src = this.url;
    let previous = -1;
    this.timer = setInterval(() => {
      const at = chunk.boundaries.findLastIndex(word => word.offsetSeconds <= this.audio.currentTime);
      if (at >= 0 && at !== previous) { previous = at; boundary(chunk.boundaries[at].text); }
    }, 70);
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { this.audio.removeEventListener("ended", done); this.audio.removeEventListener("error", fail); signal.removeEventListener("abort", abort); this.cancel = undefined; };
        const done = () => { cleanup(); resolve(); };
        const fail = () => { cleanup(); reject(new Error("The browser could not decode speech audio.")); };
        const abort = () => { cleanup(); reject(signal.reason ?? new Error("Speech stopped.")); };
        this.cancel = abort;
        this.audio.addEventListener("ended", done, { once: true }); this.audio.addEventListener("error", fail, { once: true }); signal.addEventListener("abort", abort, { once: true });
        void this.audio.play().catch(error => { cleanup(); reject(new Error(`Tap Resume to allow browser audio: ${error.message}`)); });
      });
    } finally { clearInterval(this.timer); }
  }
  stop(): void { this.paused = false; this.resumeWait?.(); this.cancel?.(); this.audio.pause(); this.audio.removeAttribute("src"); this.audio.load(); clearInterval(this.timer); if (this.url) URL.revokeObjectURL(this.url); this.url = undefined; }
}
export function markWord(elements: HTMLElement[], word: string, cursor: { offset: number }): void {
  const css = CSS as unknown as { highlights?: Map<string, unknown> };
  if (!css.highlights || !("Highlight" in window)) return;
  const nodes: Text[] = [];
  for (const root of elements) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest("pre,code,[aria-hidden=true]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
    let node; while ((node = walker.nextNode())) nodes.push(node as Text);
  }
  const text = nodes.map(node => node.textContent).join("");
  let start = text.toLowerCase().indexOf(word.toLowerCase(), cursor.offset);
  if (start < 0) start = text.toLowerCase().indexOf(word.toLowerCase());
  if (start < 0) return;
  cursor.offset = start + word.length;
  let at = 0, begin: [Text, number] | undefined, end: [Text, number] | undefined;
  for (const node of nodes) {
    const length = node.length;
    if (!begin && start < at + length) begin = [node, start - at];
    if (cursor.offset <= at + length) { end = [node, cursor.offset - at]; break; }
    at += length;
  }
  if (!begin || !end) return;
  const range = new Range(); range.setStart(...begin); range.setEnd(...end);
  const Constructor = (window as unknown as { Highlight: new (...ranges: Range[]) => unknown }).Highlight;
  css.highlights.set("pi-voice-word", new Constructor(range));
}
export function clearWord(): void { (CSS as unknown as { highlights?: Map<string, unknown> }).highlights?.delete("pi-voice-word"); }
