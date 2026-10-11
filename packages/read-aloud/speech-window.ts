/** Playback, not download speed, controls the five-sentence look-ahead. */
export const SPEECH_LOOKAHEAD = 5;
export class SpeechWindow {
  private current = 0;
  private readonly waiters = new Set<() => void>();
  advance(index: number): void {
    if (!Number.isInteger(index) || index < this.current) return;
    this.current = index;
    for (const wake of this.waiters) wake();
  }
  async wait(index: number, signal: AbortSignal): Promise<void> {
    while (index > this.current + SPEECH_LOOKAHEAD) {
      signal.throwIfAborted();
      await new Promise<void>(resolve => {
        const wake = () => { this.waiters.delete(wake); signal.removeEventListener("abort", wake); resolve(); };
        this.waiters.add(wake);
        signal.addEventListener("abort", wake, { once: true });
        if (signal.aborted || index <= this.current + SPEECH_LOOKAHEAD) wake();
      });
    }
    signal.throwIfAborted();
  }
}
