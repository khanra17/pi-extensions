import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveDictationAuth, transcribeDictation, type DictationAuth } from "./backend.ts";
import { claimMicrophone } from "../../shared/microphone.ts";
import { Pcm16RmsMeter, prepareWavForTranscription } from "./audio.ts";
import { applyVoiceDictionary, loadVoiceDictionary, type VoiceDictionary } from "./dictionary.ts";
import { createAudioRecorder, type AudioRecorder } from "./recorder.ts";
import { TranscriptPreview } from "./preview.ts";
import type { VoiceSnapshot, VoiceStateLike } from "./ui.ts";

interface Recording {
	ctx: ExtensionContext;
	auth: DictationAuth;
	dictionary: VoiceDictionary;
	insert(text: string): void;
	startedAt: number;
}

interface Dependencies {
	auth: typeof resolveDictationAuth;
	dictionary: typeof loadVoiceDictionary;
	record: typeof createAudioRecorder;
	transcribe: typeof transcribeDictation;
	now(): number;
	previewIntervalMs?: number;
}

export class VoiceController implements VoiceStateLike {
	private current: VoiceSnapshot = { status: "idle", frame: 0 };
	private listeners = new Set<(snapshot: VoiceSnapshot) => void>();
	private generation = 0;
	private recorder?: AudioRecorder;
	private preview?: TranscriptPreview;
	private removePcm?: () => void;
	private recording?: Recording;
	private abort?: AbortController;
	private startTask?: Promise<void>;
	private stopTask?: Promise<void>;
	private cleanupTask?: Promise<void>;
	private ticker?: ReturnType<typeof setInterval>;
	private maxTimer?: ReturnType<typeof setTimeout>;
	private settleTimer?: ReturnType<typeof setTimeout>;
	private releaseInput?: () => void;
	private meter = new Pcm16RmsMeter();
	private disposed = false;
	private readonly dependencies: Dependencies;

	constructor(dependencies: Partial<Dependencies> = {}) {
		this.dependencies = { auth: resolveDictationAuth, dictionary: loadVoiceDictionary, record: createAudioRecorder, transcribe: transcribeDictation, now: Date.now, ...dependencies };
	}

	get snapshot(): VoiceSnapshot { return this.current; }
	get isRecording(): boolean { return this.current.status === "recording"; }
	get isBusy(): boolean { return ["starting", "recording", "transcribing"].includes(this.current.status); }

	subscribe(listener: (snapshot: VoiceSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.current);
		return () => { this.listeners.delete(listener); };
	}

	toggle(ctx: ExtensionContext, insert: (text: string) => void): void {
		if (this.isRecording) void this.stop();
		else if (this.isBusy) ctx.ui.notify("Dictation is busy. Press Escape to cancel.", "info");
		else void this.start(ctx, insert);
	}

	start(ctx: ExtensionContext, insert: (text: string) => void): Promise<void> {
		if (this.disposed || this.isBusy) return Promise.resolve();
		if (ctx.mode !== "tui") {
			ctx.ui.notify("Dictation requires Pi's terminal UI. Public extensions cannot capture a Pi Web browser microphone.", "warning");
			return Promise.resolve();
		}
		try { this.releaseInput = claimMicrophone(ctx.sessionManager.getSessionId(), "dictation"); }
		catch (error) { ctx.ui.notify(errorMessage(error), "warning"); return Promise.resolve(); }
		const generation = ++this.generation;
		const abort = this.abort = new AbortController();
		this.clearTimers();
		this.meter.reset();
		this.publish({ status: "starting", frame: 0, message: "Checking voice provider…" });
		this.ticker = setInterval(() => {
			if (generation === this.generation && this.isBusy) this.publish({ ...this.current, frame: this.current.frame + 1 });
		}, 100);
		const task = this.begin(generation, abort, ctx, insert, this.cleanupTask);
		this.startTask = task;
		void task.finally(() => { if (this.startTask === task) this.startTask = undefined; });
		return task;
	}

	async stop(): Promise<void> {
		if (this.stopTask) return this.stopTask;
		if (!this.isRecording || !this.recorder || !this.recording || !this.abort) return;
		const generation = this.generation;
		const recorder = this.recorder;
		const preview = this.preview;
		const recording = this.recording;
		const abort = this.abort;
		const duration = this.dependencies.now() - recording.startedAt;
		this.recorder = undefined;
		this.preview = undefined;
		this.removePcm?.(); this.removePcm = undefined;
		if (this.maxTimer) clearTimeout(this.maxTimer);
		this.maxTimer = undefined;
		this.publish({ status: "transcribing", frame: 0, startedAt: recording.startedAt, message: "Finalizing transcript…" });
		const task = (async () => {
			try {
				const [raw] = await Promise.all([recorder.stop(), preview?.cancel()]);
				if (!this.isCurrent(generation, abort)) return;
				if (duration < 1_000) throw new Error("Recording was too short. Speak for at least one second.");
				const audio = prepareWavForTranscription(raw).audio;
				const text = applyVoiceDictionary(await this.dependencies.transcribe(audio, recording.auth, abort.signal, message => { if (this.isCurrent(generation, abort)) this.publish({ ...this.current, message }); }), recording.dictionary);
				if (!this.isCurrent(generation, abort)) return;
				recording.insert(text);
				this.endActivity();
				this.publish({ status: "success", frame: 0, message: "Transcript ready to edit" });
				this.scheduleIdle(generation, 1_500);
			} catch (error) {
				if (this.isCurrent(generation, abort)) this.fail(generation, recording.ctx, error);
			}
		})();
		this.stopTask = task;
		try { await task; } finally { if (this.stopTask === task) this.stopTask = undefined; }
	}

	releasePushToTalk(): void {
		if (this.current.status === "starting") void this.cancel();
		else if (this.isRecording) void this.stop();
	}

	async cancel(): Promise<void> {
		++this.generation;
		const recorder = this.recorder;
		const preview = this.preview;
		const start = this.startTask;
		const stop = this.stopTask;
		const priorCleanup = this.cleanupTask;
		const releaseInput = this.releaseInput;
		this.releaseInput = undefined;
		this.abort?.abort();
		this.recorder = this.preview = undefined;
		this.startTask = this.stopTask = undefined;
		this.endActivity();
		this.clearTimers();
		this.publish({ status: "idle", frame: 0 });
		const cleanup = Promise.allSettled([recorder?.cancel(), preview?.cancel(), start, stop, priorCleanup]).then(() => { releaseInput?.(); });
		this.cleanupTask = cleanup;
		await cleanup;
		if (this.cleanupTask === cleanup) this.cleanupTask = undefined;
	}

	async dispose(): Promise<void> { this.disposed = true; await this.cancel(); this.listeners.clear(); }

	private async begin(generation: number, abort: AbortController, ctx: ExtensionContext, insert: (text: string) => void, cleanup?: Promise<void>): Promise<void> {
		let recorder: AudioRecorder | undefined;
		try {
			const auth = await this.dependencies.auth(ctx);
			const dictionary = await this.dependencies.dictionary();
			await cleanup;
			if (!this.isCurrent(generation, abort)) return;
			this.publish({ status: "starting", frame: 0, message: "Opening microphone…" });
			recorder = await this.dependencies.record({ streamPcm: true });
			if (!this.isCurrent(generation, abort)) { await recorder.cancel(); return; }
			const startedAt = this.dependencies.now();
			this.recorder = recorder;
			this.recording = { ctx, auth, dictionary, insert, startedAt };
			const hasPreview = Boolean(recorder.onPcmChunk) && process.env.PI_DICTATION_PREVIEW !== "0";
			this.publish({ status: "recording", frame: 0, rms: 0, startedAt, message: hasPreview ? "Listening · updating composer…" : "Listening · transcript on stop" });
			if (recorder.onPcmChunk) {
				const preview = hasPreview ? new TranscriptPreview({
					transcribe: (audio, signal) => this.dependencies.transcribe(audio, auth, signal, message => { if (this.isCurrent(generation, abort) && this.isRecording) this.publish({ ...this.current, message }); }),
					timeoutMs: 8_000,
					intervalMs: this.dependencies.previewIntervalMs,
					onText: (text) => {
						if (this.isCurrent(generation, abort) && this.isRecording) this.publish({ ...this.current, liveText: applyVoiceDictionary(text, dictionary), message: "Listening · composer preview" });
					},
					onUnavailable: error => {
						if (this.isCurrent(generation, abort) && this.isRecording) {
							const message = `Preview failed: ${errorMessage(error)} · Recording continues.`;
							this.publish({ ...this.current, message });
							if ((error as { retryable?: boolean })?.retryable === false) ctx.ui.notify(message, "error");
						}
					},
				}) : undefined;
				this.preview = preview;
				this.removePcm = recorder.onPcmChunk((chunk) => {
					if (!this.isCurrent(generation, abort) || !this.isRecording) return;
					const rms = this.meter.update(chunk);
					if (rms !== undefined) this.publish({ ...this.current, rms });
					preview?.append(chunk);
				});
			}
			this.maxTimer = setTimeout(() => { if (this.isCurrent(generation, abort)) void this.stop(); }, 120_000);
		} catch (error) {
			await recorder?.cancel().catch(() => undefined);
			if (this.isCurrent(generation, abort)) { this.recorder = undefined; this.fail(generation, ctx, error); }
		}
	}

	private isCurrent(generation: number, abort: AbortController): boolean {
		return !this.disposed && generation === this.generation && this.abort === abort && !abort.signal.aborted;
	}

	private fail(generation: number, ctx: ExtensionContext, error: unknown): void {
		void this.preview?.cancel(); this.preview = undefined;
		this.endActivity();
		const message = errorMessage(error);
		this.publish({ status: "error", frame: 0, message });
		ctx.ui.notify(message, "error");
		this.scheduleIdle(generation, 6_000);
	}

	private endActivity(): void {
		if (this.ticker) clearInterval(this.ticker);
		if (this.maxTimer) clearTimeout(this.maxTimer);
		this.ticker = this.maxTimer = undefined;
		this.removePcm?.(); this.removePcm = undefined;
		this.abort = undefined;
		this.recording = undefined;
		this.releaseInput?.(); this.releaseInput = undefined;
	}

	private clearTimers(): void {
		if (this.ticker) clearInterval(this.ticker);
		if (this.maxTimer) clearTimeout(this.maxTimer);
		if (this.settleTimer) clearTimeout(this.settleTimer);
		this.ticker = this.maxTimer = this.settleTimer = undefined;
	}

	private scheduleIdle(generation: number, ms: number): void {
		this.settleTimer = setTimeout(() => { if (generation === this.generation) this.publish({ status: "idle", frame: 0 }); }, ms);
	}

	private publish(snapshot: VoiceSnapshot): void {
		this.current = snapshot;
		for (const listener of this.listeners) { try { listener(snapshot); } catch { /* UI cannot interrupt capture cleanup. */ } }
	}
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
