import { prepareWavForTranscription, pcmToWav } from "./audio.ts";

const PCM_BYTES_PER_SECOND = 24_000 * 2;
const MAX_PCM_BYTES = PCM_BYTES_PER_SECOND * 120;

/** Progressive whole-clip ASR: works even when Codex's experimental realtime socket does not. */
export class TranscriptPreview {
	private chunks: Uint8Array[] = [];
	private bytes = 0;
	private revision = 0;
	private sentRevision = 0;
	private timer?: ReturnType<typeof setTimeout>;
	private request?: AbortController;
	private task?: Promise<void>;
	private closed = false;

	constructor(private readonly options: {
		transcribe(audio: Uint8Array, signal: AbortSignal): Promise<string>;
		onText(text: string): void;
		onUnavailable?(): void;
		intervalMs?: number;
	}) {}

	append(chunk: Uint8Array): void {
		if (this.closed || !chunk.length) return;
		const copy = chunk.slice(0, Math.max(0, MAX_PCM_BYTES - this.bytes));
		if (!copy.length) return;
		this.chunks.push(copy);
		this.bytes += copy.length;
		++this.revision;
		this.schedule();
	}

	async cancel(): Promise<void> {
		this.closed = true;
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		this.request?.abort();
		this.chunks = [];
		this.bytes = 0;
		await this.task;
	}

	private schedule(): void {
		if (this.closed || this.timer || this.task || this.bytes < PCM_BYTES_PER_SECOND || this.revision === this.sentRevision) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			const task = this.update().catch(() => undefined);
			this.task = task;
			void task.finally(() => {
				if (this.task === task) this.task = undefined;
				this.schedule();
			});
		}, this.options.intervalMs ?? 2_000);
		this.timer.unref?.();
	}

	private async update(): Promise<void> {
		const request = new AbortController();
		this.request = request;
		this.sentRevision = this.revision;
		const pcm = new Uint8Array(this.bytes);
		let offset = 0;
		for (const chunk of this.chunks) { pcm.set(chunk, offset); offset += chunk.length; }
		try {
			const audio = prepareWavForTranscription(pcmToWav(pcm, 24_000)).audio;
			const text = await this.options.transcribe(audio, AbortSignal.any([request.signal, AbortSignal.timeout(8_000)]));
			if (!this.closed && !request.signal.aborted && text.trim()) this.options.onText(text.trim());
		} catch {
			// Silence, a timeout or unavailable ASR never loses the recording or submits text.
			if (!this.closed) this.options.onUnavailable?.();
		} finally {
			if (this.request === request) this.request = undefined;
		}
	}
}
