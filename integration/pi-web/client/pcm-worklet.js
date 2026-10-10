class PiVoicePcm extends AudioWorkletProcessor {
  constructor() { super(); this.parts = []; this.count = 0; this.port.onmessage = () => { this.flush(); this.port.postMessage({ flushed: true }); }; }
  flush() {
    if (!this.count) return;
    const samples = new Float32Array(this.count); let at = 0;
    for (const part of this.parts) { samples.set(part, at); at += part.length; }
    this.port.postMessage(samples, [samples.buffer]); this.parts = []; this.count = 0;
  }
  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    if (input) {
      this.parts.push(new Float32Array(input)); this.count += input.length;
      if (this.count >= 2048) this.flush();
    }
    for (const channels of outputs) for (const output of channels) output.fill(0);
    return true;
  }
}
registerProcessor("pi-voice-pcm", PiVoicePcm);
