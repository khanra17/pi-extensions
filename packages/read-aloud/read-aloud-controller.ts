import type { AudioPlayer } from "./audio-player.ts";
import {
	prepareSpeechText,
	synthesizeChunks,
	type SpeechBoundary,
	type SynthesisChunk,
} from "./edge-read-aloud.ts";
import { AutomaticAudioPlayer } from "./playback-engine.ts";
import { SpeechWindow } from "./speech-window.ts";
import {
	DEFAULT_SETTINGS,
	normalizeReaderSettings,
	type ReaderSettings,
} from "./reader-settings.ts";

export { DEFAULT_SETTINGS, type ReaderSettings } from "./reader-settings.ts";

export type ReaderStatus =
	| "idle"
	| "synthesizing"
	| "playing"
	| "paused"
	| "finished"
	| "error";

export interface ReaderSnapshot {
	status: ReaderStatus;
	/** Changes whenever playback is started, stopped, or replaced. */
	playbackId: number;
	/** Exact unmodified session message currently being read. */
	sourceText: string;
	/** Prepared speech text sent to Edge Read Aloud. */
	text: string;
	voice: string;
	speed: number;
	volume: number;
	muted: boolean;
	autoPlay: boolean;
	readCode: boolean;
	highlightEnabled: boolean;
	currentChunk: number;
	synthesizedChunks: number;
	totalChunks: number;
	timePos: number;
	duration?: number;
	overallTimePos: number;
	overallDuration?: number;
	overallProgress: number;
	durationEstimated: boolean;
	currentPassage: string;
	highlightStart: number;
	highlightEnd: number;
	speechHighlightStart: number;
	speechHighlightEnd: number;
	error?: string;
}

interface ControllerCallbacks {
	onSnapshot?: (snapshot: ReaderSnapshot) => void;
	onSettingsChange?: (settings: ReaderSettings) => void;
	onError?: (message: string) => void;
}

const STOPPED_MESSAGE = "Stopped";
const FALLBACK_SECONDS_PER_CHARACTER = 0.055;

interface LocatedBoundary extends SpeechBoundary {
	start: number;
	end: number;
}

export class EdgeReadAloudController {
	private settings: ReaderSettings;
	private readonly callbacks: ControllerCallbacks;
	private readonly listeners = new Set<(snapshot: ReaderSnapshot) => void>();
	private latestResponse = "";
	private activeRawText = "";
	private activeSpeechText = "";
	private status: ReaderStatus = "idle";
	private errorMessage: string | undefined;
	private currentChunk = 0;
	private totalChunks = 0;
	private timePos = 0;
	private duration: number | undefined;
	private queuedFiles = 0;
	private readonly chunkTexts: string[] = [];
	private readonly chunkTextStarts: number[] = [];
	private readonly chunkBoundaries: LocatedBoundary[][] = [];
	private readonly chunkDurations: Array<number | undefined> = [];
	private synthesisFinished = false;
	private playbackCompleted = false;
	private activePlayerJob: number | undefined;
	private job = 0;
	private abortController: AbortController | undefined;
	private synthesisWindow: SpeechWindow | undefined;
	private runPromise: Promise<void> | undefined;
	private finishTimer: ReturnType<typeof setTimeout> | undefined;
	private player: AudioPlayer | undefined;
	private disposed = false;

	constructor(settings: ReaderSettings, callbacks: ControllerCallbacks = {}) {
		this.settings = normalizeReaderSettings(settings);
		this.callbacks = callbacks;
	}

	get settingsSnapshot(): ReaderSettings {
		return { ...this.settings };
	}

	get lastResponse(): string {
		return this.latestResponse;
	}

	get isActive(): boolean {
		return (
			this.status === "synthesizing" ||
			this.status === "playing" ||
			this.status === "paused"
		);
	}

	get snapshot(): ReaderSnapshot {
		return this.makeSnapshot();
	}

	setSettings(settings: ReaderSettings): void {
		this.settings = normalizeReaderSettings(settings);
		this.player?.setSpeed(this.settings.speed);
		this.player?.setVolume(this.settings.muted ? 0 : this.settings.volume);
		this.emit();
	}

	setLastResponse(text: string): void {
		const nextResponse = text.trim();
		if (!this.isActive && nextResponse !== this.latestResponse) {
			this.activeRawText = "";
			this.activeSpeechText = "";
			this.status = "idle";
			this.errorMessage = undefined;
			this.currentChunk = 0;
			this.totalChunks = 0;
			this.timePos = 0;
			this.duration = undefined;
			this.queuedFiles = 0;
			this.clearPlaybackArrays();
			this.synthesisFinished = false;
			this.playbackCompleted = false;
		}
		this.latestResponse = nextResponse;
		this.emit();
	}

	hasResponse(): boolean {
		return this.latestResponse.length > 0;
	}

	subscribe(listener: (snapshot: ReaderSnapshot) => void): () => void {
		this.listeners.add(listener);
		listener(this.snapshot);
		return () => this.listeners.delete(listener);
	}

	async play(text?: string): Promise<void> {
		if (this.disposed) return;
		const rawText = (text ?? this.latestResponse).trim();
		if (!rawText) {
			this.setError("There is no assistant response to read yet.");
			return;
		}

		const speechText = prepareSpeechText(rawText, this.settings.readCode);
		if (!speechText) {
			this.setError("The response has no readable text.");
			return;
		}

		// Claim a generation before awaiting anything. This prevents rapid play and
		// replay requests from sharing a stale audio queue.
		const job = ++this.job;
		this.clearFinishTimer();
		this.abortController?.abort();
		this.abortController = undefined;
		const previousRun = this.runPromise;
		if (previousRun) await previousRun.catch(() => undefined);
		if (!this.isJobNumberCurrent(job)) return;

		this.activePlayerJob = undefined;
		if (this.player) await this.player.reset().catch(() => undefined);
		if (!this.isJobNumberCurrent(job)) return;

		const abortController = new AbortController();
		this.abortController = abortController;
		this.latestResponse = rawText;
		this.activeRawText = rawText;
		this.activeSpeechText = speechText;
		this.status = "synthesizing";
		this.errorMessage = undefined;
		this.resetCounters();
		this.emit();

		const run = this.runPlayback(job, speechText, abortController.signal);
		this.runPromise = run;
		await run;
		if (this.runPromise === run) this.runPromise = undefined;
	}

	async stop(): Promise<void> {
		const job = ++this.job;
		this.clearFinishTimer();
		this.abortController?.abort();
		this.abortController = undefined;

		const previousRun = this.runPromise;
		if (previousRun) await previousRun.catch(() => undefined);
		if (!this.isJobNumberCurrent(job)) return;
		if (this.runPromise === previousRun) this.runPromise = undefined;

		this.activePlayerJob = undefined;
		if (this.player) await this.player.reset().catch(() => undefined);
		if (!this.isJobNumberCurrent(job)) return;
		this.resetPlaybackState();
		this.emit();
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.stop();
		await this.player?.dispose();
		this.player = undefined;
		this.listeners.clear();
	}

	togglePause(): void {
		if (this.status === "playing" || this.status === "synthesizing") {
			// Stop the audio engine before transcript/UI work. Highlight rendering can
			// be expensive for long sessions and must never delay an audible pause.
			this.player?.setPaused(true);
			this.status = "paused";
			this.emit();
			return;
		}
		if (this.status === "paused") {
			this.player?.setPaused(false);
			this.status = "playing";
			this.emit();
			return;
		}
		if (this.status === "idle" || this.status === "finished") void this.play();
	}

	setSpeed(speed: number): void {
		if (!Number.isFinite(speed)) return;
		this.settings.speed = clamp(speed, 0.5, 2);
		this.player?.setSpeed(this.settings.speed);
		this.emitSettings();
	}

	adjustSpeed(delta: number): void {
		this.setSpeed(Math.round((this.settings.speed + delta) * 10) / 10);
	}

	setVolume(volume: number): void {
		if (!Number.isFinite(volume)) return;
		this.settings.volume = clamp(Math.round(volume), 0, 100);
		this.player?.setVolume(this.settings.muted ? 0 : this.settings.volume);
		this.emitSettings();
	}

	adjustVolume(delta: number): void {
		this.setVolume(this.settings.volume + delta);
	}

	toggleMute(): void {
		this.settings.muted = !this.settings.muted;
		this.player?.setVolume(this.settings.muted ? 0 : this.settings.volume);
		this.emitSettings();
	}

	toggleAutoPlay(): void {
		this.settings.autoPlay = !this.settings.autoPlay;
		this.emitSettings();
	}

	setAutoPlay(value: boolean): void {
		this.settings.autoPlay = value;
		this.emitSettings();
	}

	toggleReadCode(): void {
		this.settings.readCode = !this.settings.readCode;
		this.emitSettings();
	}

	toggleHighlight(): void {
		this.setHighlightEnabled(!this.settings.highlightEnabled);
	}

	setHighlightEnabled(value: boolean): void {
		this.settings.highlightEnabled = value;
		this.emitSettings();
	}

	setVoice(voice: string): void {
		const value = voice.trim();
		if (!value) return;
		this.settings.voice = value;
		this.emitSettings();
	}

	seek(seconds: number): void {
		if (this.status === "playing" || this.status === "paused")
			this.player?.seek(seconds);
	}

	replay(): void {
		if (this.latestResponse) void this.play(this.latestResponse);
	}

	private async runPlayback(
		job: number,
		speechText: string,
		signal: AbortSignal,
	): Promise<void> {
		const player = this.getPlayer();
		const window = this.synthesisWindow = new SpeechWindow();
		try {
			this.activePlayerJob = job;
			await player.start();
			this.ensureCurrentJob(job);
			player.setSpeed(this.settings.speed);
			player.setVolume(this.settings.muted ? 0 : this.settings.volume);
			player.setPaused(this.status === "paused");
			await synthesizeChunks({
				text: speechText,
				voice: this.settings.voice,
				signal,
				beforeChunk: (index, abort) => window.wait(index, abort),
				onPlan: (chunks) => {
					if (!this.isCurrentJob(job)) return;
					this.recordPlan(speechText, chunks);
					this.emit();
				},
				onChunk: (chunk) => this.queueChunk(job, chunk, player),
			});
			this.ensureCurrentJob(job);
			if (this.queuedFiles === 0)
				throw new Error("Edge Read Aloud returned no audio");
			this.synthesisFinished = true;
			this.emit();
			this.maybeFinish(job);
		} catch (error) {
			if (!this.isCurrentJob(job)) return;
			const message = error instanceof Error ? error.message : String(error);
			if (message === STOPPED_MESSAGE) return;
			this.abortController?.abort();
			this.status = "error";
			this.activePlayerJob = undefined;
			this.errorMessage = message;
			this.callbacks.onError?.(message);
			this.emit();
			try {
				await player.reset();
			} catch {
				// Ignore a player that failed with synthesis.
			}
		}
	}

	private recordPlan(speechText: string, chunks: readonly string[]): void {
		this.chunkTexts.push(...chunks);
		let searchFrom = 0;
		for (const chunk of chunks) {
			const found = speechText.indexOf(chunk, searchFrom);
			const start = found >= 0 ? found : searchFrom;
			this.chunkTextStarts.push(start);
			searchFrom = start + chunk.length;
		}
		this.totalChunks = chunks.length;
	}

	private async queueChunk(
		job: number,
		chunk: SynthesisChunk,
		player: AudioPlayer,
	): Promise<void> {
		this.ensureCurrentJob(job);
		const decodedDuration = await player.queueAudio(chunk.audio);
		this.ensureCurrentJob(job);
		this.chunkTexts[chunk.index] = chunk.text;
		this.chunkBoundaries[chunk.index] = locateBoundaries(
			chunk.text,
			chunk.boundaries,
		);
		this.chunkDurations[chunk.index] = Math.max(0.001, decodedDuration);
		this.totalChunks = chunk.total;
		this.queuedFiles += 1;
		if (this.currentChunk === 0) this.currentChunk = 1;
		this.status = this.status === "paused" ? "paused" : "playing";
		this.emit();
	}

	private maybeFinish(job: number): void {
		if (
			!this.isCurrentJob(job) ||
			!this.synthesisFinished ||
			this.queuedFiles === 0
		)
			return;
		if (this.player?.state.idleActive) void this.finish(job);
	}

	private async finish(job: number): Promise<void> {
		if (
			!this.isCurrentJob(job) ||
			!this.synthesisFinished ||
			this.queuedFiles === 0 ||
			this.status === "finished"
		)
			return;
		this.status = "finished";
		this.playbackCompleted = true;
		this.activePlayerJob = undefined;
		this.emit();
		this.clearFinishTimer();
		this.finishTimer = setTimeout(() => {
			if (this.isCurrentJob(job) && this.status === "finished") {
				this.status = "idle";
				this.emit();
			}
		}, 1500);
	}

	private getPlayer(): AudioPlayer {
		if (!this.player) {
			this.player = new AutomaticAudioPlayer({
				onUpdate: (state) => {
					if (this.activePlayerJob !== undefined && state.fileIndex !== undefined) this.synthesisWindow?.advance(state.fileIndex);
					this.timePos = state.audioTimePos ?? state.timePos;
					this.duration = state.duration;
					if (state.fileIndex !== undefined)
						this.currentChunk = clamp(
							state.fileIndex + 1,
							1,
							Math.max(1, this.totalChunks),
						);
					if (this.status === "playing" && state.paused)
						this.status = "paused";
					this.emit();
				},
				onIdle: () => {
					const job = this.activePlayerJob;
					if (job === undefined || this.queuedFiles === 0) return;
					if (this.synthesisFinished) {
						void this.finish(job);
					} else if (this.status === "playing") {
						this.status = "synthesizing";
						this.emit();
					}
				},
				onError: (error) => this.handlePlayerError(error, this.activePlayerJob),
			});
		}
		return this.player;
	}

	private ensureCurrentJob(job: number): void {
		if (!this.isCurrentJob(job)) throw new Error(STOPPED_MESSAGE);
	}

	private isCurrentJob(job: number): boolean {
		return this.isJobNumberCurrent(job) && !this.abortController?.signal.aborted;
	}

	private isJobNumberCurrent(job: number): boolean {
		return this.job === job;
	}

	private setError(message: string): void {
		this.status = "error";
		this.errorMessage = message;
		this.callbacks.onError?.(message);
		this.emit();
	}

	private emitSettings(): void {
		this.callbacks.onSettingsChange?.(this.settingsSnapshot);
		this.emit();
	}

	private emit(): void {
		const snapshot = this.makeSnapshot();
		this.callbacks.onSnapshot?.(snapshot);
		for (const listener of this.listeners) listener(snapshot);
	}

	private makeSnapshot(): ReaderSnapshot {
		const progress = this.calculateOverallProgress();
		const passage = this.calculateCurrentPassage();
		return {
			status: this.status,
			playbackId: this.job,
			sourceText: this.activeRawText || this.latestResponse,
			text: this.activeSpeechText || this.latestResponse,
			voice: this.settings.voice,
			speed: this.settings.speed,
			volume: this.settings.volume,
			muted: this.settings.muted,
			autoPlay: this.settings.autoPlay,
			readCode: this.settings.readCode,
			highlightEnabled: this.settings.highlightEnabled,
			currentChunk: this.currentChunk,
			synthesizedChunks: this.queuedFiles,
			totalChunks: this.totalChunks,
			timePos: this.timePos,
			duration: this.duration,
			overallTimePos: progress.elapsed,
			overallDuration: progress.total,
			overallProgress: progress.fraction,
			durationEstimated: progress.estimated,
			currentPassage: passage.text,
			highlightStart: passage.start,
			highlightEnd: passage.end,
			speechHighlightStart: passage.speechStart,
			speechHighlightEnd: passage.speechEnd,
			error: this.errorMessage,
		};
	}

	private calculateOverallProgress(): {
		elapsed: number;
		total?: number;
		fraction: number;
		estimated: boolean;
	} {
		if (this.totalChunks === 0)
			return { elapsed: 0, fraction: 0, estimated: true };

		const weights = this.chunkTexts.map(textWeight);
		let knownDuration = 0;
		let knownWeight = 0;
		for (let index = 0; index < this.totalChunks; index += 1) {
			const chunkDuration = this.chunkDurations[index];
			if (chunkDuration !== undefined) {
				knownDuration += chunkDuration;
				knownWeight += weights[index] ?? 1;
			}
		}
		const secondsPerCharacter =
			knownWeight > 0
				? knownDuration / knownWeight
				: FALLBACK_SECONDS_PER_CHARACTER;
		const estimated = Array.from(
			{ length: this.totalChunks },
			(_, index) => this.chunkDurations[index],
		).some((value) => value === undefined);
		const durations = Array.from({ length: this.totalChunks }, (_, index) =>
			this.chunkDurations[index] ??
			Math.max(0.25, (weights[index] ?? 1) * secondsPerCharacter),
		);
		const total = durations.reduce((sum, value) => sum + value, 0);
		if (this.playbackCompleted)
			return { elapsed: total, total, fraction: 1, estimated: false };

		const activeIndex = clamp(this.currentChunk - 1, 0, this.totalChunks - 1);
		const before = durations
			.slice(0, this.currentChunk > 0 ? activeIndex : 0)
			.reduce((sum, value) => sum + value, 0);
		const currentDuration = durations[activeIndex] ?? 0;
		const elapsed =
			this.currentChunk > 0
				? before + clamp(this.timePos, 0, currentDuration)
				: 0;
		const totalWeight = weights
			.slice(0, this.totalChunks)
			.reduce((sum, value) => sum + value, 0);
		const weightBefore = weights
			.slice(0, this.currentChunk > 0 ? activeIndex : 0)
			.reduce((sum, value) => sum + value, 0);
		const localFraction =
			this.currentChunk > 0 && currentDuration > 0
				? clamp(this.timePos / currentDuration, 0, 1)
				: 0;
		const weightedProgress =
			weightBefore + (weights[activeIndex] ?? 1) * localFraction;
		return {
			elapsed,
			total,
			fraction:
				totalWeight > 0 ? clamp(weightedProgress / totalWeight, 0, 1) : 0,
			estimated,
		};
	}

	private calculateCurrentPassage(): {
		text: string;
		start: number;
		end: number;
		speechStart: number;
		speechEnd: number;
	} {
		const index = this.currentChunk - 1;
		const text = index >= 0 ? (this.chunkTexts[index] ?? "") : "";
		const chunkStart = index >= 0 ? (this.chunkTextStarts[index] ?? 0) : 0;
		if (!text)
			return { text: "", start: 0, end: 0, speechStart: 0, speechEnd: 0 };
		if (!this.settings.highlightEnabled)
			return { text, start: 0, end: 0, speechStart: 0, speechEnd: 0 };

		const highlightTime = Math.max(0, this.timePos);
		const boundaries = this.chunkBoundaries[index] ?? [];
		if (boundaries.length > 0) {
			let active = boundaries[0];
			for (const boundary of boundaries) {
				if (boundary.offsetSeconds > highlightTime) break;
				active = boundary;
			}
			if (active)
				return {
					text,
					start: active.start,
					end: active.end,
					speechStart: chunkStart + active.start,
					speechEnd: chunkStart + active.end,
				};
		}

		const localProgress =
			this.duration && this.duration > 0
				? clamp(highlightTime / this.duration, 0, 1)
				: 0;
		const approximate = Math.floor(
			localProgress * Math.max(0, text.length - 1),
		);
		const start = findWordStart(text, approximate);
		const end = Math.max(start + 1, findWordEnd(text, approximate));
		return {
			text,
			start,
			end,
			speechStart: chunkStart + start,
			speechEnd: chunkStart + end,
		};
	}

	private clearPlaybackArrays(): void {
		this.chunkTexts.length = 0;
		this.chunkTextStarts.length = 0;
		this.chunkBoundaries.length = 0;
		this.chunkDurations.length = 0;
	}

	private resetCounters(): void {
		this.currentChunk = 0;
		this.totalChunks = 0;
		this.timePos = 0;
		this.duration = undefined;
		this.queuedFiles = 0;
		this.clearPlaybackArrays();
		this.synthesisFinished = false;
		this.playbackCompleted = false;
	}

	private resetPlaybackState(): void {
		this.activeRawText = "";
		this.activeSpeechText = "";
		this.status = "idle";
		this.errorMessage = undefined;
		this.resetCounters();
		this.activePlayerJob = undefined;
	}

	private clearFinishTimer(): void {
		if (this.finishTimer) clearTimeout(this.finishTimer);
		this.finishTimer = undefined;
	}

	private handlePlayerError(error: Error, playerJob: number | undefined): void {
		if (
			playerJob === undefined ||
			!this.isCurrentJob(playerJob) ||
			!this.isActive
		)
			return;
		this.job += 1;
		this.abortController?.abort();
		this.abortController = undefined;
		this.activePlayerJob = undefined;
		this.status = "error";
		this.errorMessage = error.message;
		this.callbacks.onError?.(error.message);
		this.emit();
	}
}

function locateBoundaries(
	text: string,
	boundaries: readonly SpeechBoundary[],
): LocatedBoundary[] {
	const result: LocatedBoundary[] = [];
	let cursor = 0;
	for (const boundary of boundaries) {
		const word = boundary.text.trim();
		if (!word) continue;
		let start = text.indexOf(word, cursor);
		if (start < 0) {
			start = text
				.toLocaleLowerCase()
				.indexOf(word.toLocaleLowerCase(), cursor);
		}
		if (start < 0) continue;
		const end = start + word.length;
		result.push({ ...boundary, text: word, start, end });
		cursor = end;
	}
	return result;
}

function textWeight(text: string): number {
	return Math.max(
		1,
		[...text].filter((character) => !/\s/u.test(character)).length,
	);
}

function findWordStart(text: string, position: number): number {
	let index = clamp(position, 0, Math.max(0, text.length - 1));
	while (index > 0 && !/\s/u.test(text[index - 1] ?? "")) index -= 1;
	return index;
}

function findWordEnd(text: string, position: number): number {
	let index = clamp(position, 0, text.length);
	while (index < text.length && !/\s/u.test(text[index] ?? "")) index += 1;
	return index;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
