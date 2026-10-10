import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { SoundTouchNode } from "@soundtouchjs/audio-worklet";
import type {
	AudioBuffer,
	AudioBufferSourceNode,
	AudioContext,
	GainNode,
} from "node-web-audio-api";

export interface PlayerSnapshot {
	timePos: number;
	audioTimePos?: number;
	duration?: number;
	fileIndex?: number;
	paused: boolean;
	idleActive: boolean;
}

export interface AudioPlayerCallbacks {
	onUpdate?: (snapshot: PlayerSnapshot) => void;
	onIdle?: () => void;
	onError?: (error: Error) => void;
}

export interface AudioPlayer {
	readonly state: PlayerSnapshot;
	start(): Promise<void>;
	reset(): Promise<void>;
	queueAudio(audio: Uint8Array): Promise<number>;
	setPaused(paused: boolean): void;
	setSpeed(speed: number): void;
	setVolume(volume: number): void;
	seek(seconds: number): void;
	dispose(): Promise<void>;
}

interface QueueItem {
	buffer: AudioBuffer;
	duration: number;
	index: number;
}

interface ActiveItem {
	item: QueueItem;
	source: AudioBufferSourceNode;
	shifter: SoundTouchNode;
	id: number;
	anchorContextTime: number;
	anchorOffset: number;
	anchorSpeed: number;
}

// Enough input for SoundTouch to flush its short WSOLA tail without adding a
// noticeable half-second pause between independently decoded Edge parts.
const SOUNDTOUCH_FLUSH_SILENCE_SECONDS = 0.15;

const DEFAULT_SNAPSHOT: PlayerSnapshot = {
	timePos: 0,
	paused: false,
	idleActive: true,
};

/** In-process Web Audio player backed by node-web-audio-api's prebuilt native module. */
export class NpmAudioPlayer implements AudioPlayer {
	private readonly callbacks: AudioPlayerCallbacks;
	private context: AudioContext | undefined;
	private gain: GainNode | undefined;
	private soundTouchNodeClass: typeof SoundTouchNode | undefined;
	private startPromise: Promise<void> | undefined;
	private readonly queue: QueueItem[] = [];
	private active: ActiveItem | undefined;
	private snapshot: PlayerSnapshot = { ...DEFAULT_SNAPSHOT };
	private loadedItems = 0;
	private sourceId = 0;
	private speed = 1;
	private volume = 100;
	private updateTimer: ReturnType<typeof setInterval> | undefined;
	private disposed = false;

	constructor(callbacks: AudioPlayerCallbacks = {}) {
		this.callbacks = callbacks;
	}

	get state(): PlayerSnapshot {
		this.refreshPosition();
		return { ...this.snapshot };
	}

	async start(): Promise<void> {
		if (this.context && this.context.state !== "closed") return;
		if (this.startPromise) return this.startPromise;
		if (this.disposed) throw new Error("Audio player is disposed");

		const start = this.startContext();
		this.startPromise = start;
		try {
			await start;
		} finally {
			if (this.startPromise === start) this.startPromise = undefined;
		}
	}

	async reset(): Promise<void> {
		this.queue.length = 0;
		this.loadedItems = 0;
		this.stopActive();
		this.snapshot = { ...DEFAULT_SNAPSHOT };
		const context = this.context;
		if (context?.state === "suspended") await context.resume().catch(() => undefined);
		this.emitUpdate();
	}

	async queueAudio(audio: Uint8Array): Promise<number> {
		await this.start();
		const context = this.context;
		if (!context || context.state === "closed")
			throw new Error("Audio output is unavailable");
		const encoded = new Uint8Array(audio.byteLength);
		encoded.set(audio);
		const decoded = await context.decodeAudioData(encoded.buffer);
		if (!(decoded.duration > 0)) throw new Error("Decoded audio is empty");
		const item = {
			buffer: appendSilence(
				context,
				decoded,
				SOUNDTOUCH_FLUSH_SILENCE_SECONDS,
			),
			duration: decoded.duration,
			index: this.loadedItems++,
		};
		this.queue.push(item);
		this.snapshot.idleActive = false;
		this.snapshot.fileIndex ??= item.index;
		if (!this.active && !this.snapshot.paused) this.startNext();
		this.emitUpdate();
		return decoded.duration;
	}

	setPaused(paused: boolean): void {
		if (this.snapshot.paused === paused) return;
		this.refreshPosition();
		this.snapshot.paused = paused;
		const context = this.context;
		if (!context || context.state === "closed") {
			this.emitUpdate();
			return;
		}
		// Begin suspension before callbacks can invalidate and render a long
		// transcript. This keeps the Space key audibly responsive.
		const operation = paused ? context.suspend() : context.resume();
		this.emitUpdate();
		void operation
			.then(() => {
				if (!paused && !this.active) this.startNext();
			})
			.catch((error: unknown) => this.reportError(toError(error)));
	}

	setSpeed(speed: number): void {
		if (!Number.isFinite(speed) || speed <= 0) return;
		this.refreshPosition(true);
		this.speed = speed;
		const active = this.active;
		if (!active) return;
		active.anchorSpeed = speed;
		const now = this.context?.currentTime ?? 0;
		// Feed samples faster, then have SoundTouch compensate the pitch change.
		active.source.playbackRate.setValueAtTime(speed, now);
		active.shifter.playbackRate.setValueAtTime(speed, now);
	}

	setVolume(volume: number): void {
		if (!Number.isFinite(volume)) return;
		this.volume = Math.max(0, Math.min(100, volume));
		if (this.gain) this.gain.gain.value = this.volume / 100;
	}

	seek(seconds: number): void {
		const active = this.active;
		if (!active || !Number.isFinite(seconds)) return;
		this.refreshPosition();
		const target = Math.max(
			0,
			Math.min(active.item.duration, this.snapshot.timePos + seconds),
		);
		const item = active.item;
		this.stopActive();
		if (target >= item.duration - 0.001) this.startNext();
		else this.startItem(item, target);
		this.emitUpdate();
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.queue.length = 0;
		this.stopActive();
		if (this.updateTimer) clearInterval(this.updateTimer);
		this.updateTimer = undefined;
		const context = this.context;
		this.context = undefined;
		this.gain = undefined;
		this.soundTouchNodeClass = undefined;
		if (context && context.state !== "closed")
			await context.close().catch(() => undefined);
		this.snapshot = { ...DEFAULT_SNAPSHOT };
	}

	private async startContext(): Promise<void> {
		const webAudio = await import("node-web-audio-api");
		if (this.disposed) throw new Error("Audio player is disposed");
		if (!(globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode) {
			Object.defineProperty(globalThis, "AudioWorkletNode", {
				configurable: true,
				value: webAudio.AudioWorkletNode,
				writable: true,
			});
		}
		const { SoundTouchNode: SoundTouch } = await import(
			"@soundtouchjs/audio-worklet"
		);
		const context = new webAudio.AudioContext({ latencyHint: "interactive" });
		try {
			const processorPath = fileURLToPath(
				import.meta.resolve("@soundtouchjs/audio-worklet/processor"),
			);
			const processorCode = await readFile(processorPath, "utf8");
			const processorUrl = URL.createObjectURL(
				new Blob([processorCode], { type: "text/javascript" }),
			);
			try {
				await SoundTouch.register(context, processorUrl);
			} finally {
				URL.revokeObjectURL(processorUrl);
			}
			const gain = context.createGain();
			gain.gain.value = this.volume / 100;
			gain.connect(context.destination);
			this.context = context;
			this.gain = gain;
			this.soundTouchNodeClass = SoundTouch;
		} catch (error) {
			await context.close().catch(() => undefined);
			throw error;
		}
		this.updateTimer = setInterval(() => {
			if (!this.active) return;
			this.refreshPosition();
			this.emitUpdate();
		}, 100);
		this.updateTimer.unref?.();
	}

	private startNext(): void {
		if (this.active || this.snapshot.paused) return;
		const next = this.queue.shift();
		if (!next) {
			if (!this.snapshot.idleActive) {
				this.snapshot.idleActive = true;
				this.emitUpdate();
				this.callbacks.onIdle?.();
			}
			return;
		}
		this.startItem(next, 0);
	}

	private startItem(item: QueueItem, offset: number): void {
		const context = this.context;
		const gain = this.gain;
		const SoundTouch = this.soundTouchNodeClass;
		if (!context || !gain || !SoundTouch || context.state === "closed") {
			this.reportError(new Error("Audio output is unavailable"));
			return;
		}
		try {
			const id = ++this.sourceId;
			const source = context.createBufferSource();
			const shifter = new SoundTouch({ context });
			source.buffer = item.buffer;
			source.playbackRate.value = this.speed;
			shifter.pitch.value = 1;
			shifter.playbackRate.value = this.speed;
			source.connect(shifter);
			shifter.connect(gain);
			this.active = {
				item,
				source,
				shifter,
				id,
				anchorContextTime: context.currentTime,
				anchorOffset: offset,
				anchorSpeed: this.speed,
			};
			this.snapshot = {
				timePos: offset,
				audioTimePos: offset,
				duration: item.duration,
				fileIndex: item.index,
				paused: this.snapshot.paused,
				idleActive: false,
			};
			source.onended = () => this.handleEnded(id);
			source.start(0, offset);
			this.emitUpdate();
		} catch (error) {
			this.reportError(toError(error));
		}
	}

	private handleEnded(id: number): void {
		const active = this.active;
		if (!active || active.id !== id) return;
		this.snapshot.timePos = active.item.duration;
		this.snapshot.audioTimePos = active.item.duration;
		this.releaseActive(active);
		this.active = undefined;
		this.startNext();
	}

	private stopActive(): void {
		const active = this.active;
		this.active = undefined;
		if (!active) return;
		this.releaseActive(active);
	}

	private refreshPosition(reanchor = false): void {
		const active = this.active;
		const context = this.context;
		if (!active || !context) return;
		const elapsed = Math.max(0, context.currentTime - active.anchorContextTime);
		const position = Math.min(
			active.item.duration,
			active.anchorOffset + elapsed * active.anchorSpeed,
		);
		this.snapshot.timePos = position;
		this.snapshot.audioTimePos = position;
		if (reanchor) {
			active.anchorOffset = position;
			active.anchorContextTime = context.currentTime;
		}
	}

	private releaseActive(active: ActiveItem): void {
		active.source.onended = null;
		try {
			active.source.stop();
		} catch {
			// The source may already have ended naturally.
		}
		active.source.disconnect();
		active.shifter.disconnect();
		active.shifter.port.close();
	}

	private emitUpdate(): void {
		this.callbacks.onUpdate?.({ ...this.snapshot });
	}

	private reportError(error: Error): void {
		this.callbacks.onError?.(error);
	}
}

function appendSilence(
	context: AudioContext,
	input: AudioBuffer,
	seconds: number,
): AudioBuffer {
	const silenceFrames = Math.ceil(input.sampleRate * seconds);
	const output = context.createBuffer(
		input.numberOfChannels,
		input.length + silenceFrames,
		input.sampleRate,
	);
	for (let channel = 0; channel < input.numberOfChannels; channel += 1) {
		const samples = new Float32Array(input.length);
		input.copyFromChannel(samples, channel);
		output.copyToChannel(samples, channel);
	}
	return output;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
