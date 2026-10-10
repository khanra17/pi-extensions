import {
	type AudioPlayer,
	type AudioPlayerCallbacks,
	NpmAudioPlayer,
	type PlayerSnapshot,
} from "./audio-player.ts";
import { MpvAudioPlayer } from "./mpv-player.ts";

const DEFAULT_SNAPSHOT: PlayerSnapshot = {
	timePos: 0,
	paused: false,
	idleActive: true,
};

/** Prefers system mpv, then falls back to bundled in-process Web Audio. */
export class AutomaticAudioPlayer implements AudioPlayer {
	private engine: AudioPlayer | undefined;
	private startPromise: Promise<void> | undefined;
	private speed = 1;
	private volume = 100;
	private paused = false;
	private disposed = false;

	constructor(private readonly callbacks: AudioPlayerCallbacks = {}) {}

	get state(): PlayerSnapshot {
		return this.engine?.state ?? { ...DEFAULT_SNAPSHOT, paused: this.paused };
	}

	async start(): Promise<void> {
		if (this.engine) return this.engine.start();
		if (this.startPromise) return this.startPromise;
		if (this.disposed) throw new Error("Audio player is disposed");
		const start = this.selectEngine();
		this.startPromise = start;
		try {
			await start;
		} finally {
			if (this.startPromise === start) this.startPromise = undefined;
		}
	}

	async reset(): Promise<void> {
		await this.engine?.reset();
	}

	async queueAudio(audio: Uint8Array): Promise<number> {
		await this.start();
		if (!this.engine) throw new Error("No audio playback engine is available");
		return this.engine.queueAudio(audio);
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
		this.engine?.setPaused(paused);
	}

	setSpeed(speed: number): void {
		this.speed = speed;
		this.engine?.setSpeed(speed);
	}

	setVolume(volume: number): void {
		this.volume = volume;
		this.engine?.setVolume(volume);
	}

	seek(seconds: number): void {
		this.engine?.seek(seconds);
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		if (this.startPromise) await this.startPromise.catch(() => undefined);
		await this.engine?.dispose();
		this.engine = undefined;
	}

	private async selectEngine(): Promise<void> {
		const preference = process.env.PI_TTS_PLAYER?.trim().toLocaleLowerCase();
		if (preference !== "web" && preference !== "npm") {
			let mpv!: MpvAudioPlayer;
			mpv = new MpvAudioPlayer(
				this.proxyCallbacks(() => this.engine === mpv),
			);
			try {
				await mpv.start();
				if (this.disposed) {
					await mpv.dispose();
					throw new Error("Audio player is disposed");
				}
				this.engine = mpv;
				this.applySettings(mpv);
				return;
			} catch (error) {
				await mpv.dispose().catch(() => undefined);
				if (preference === "mpv") throw error;
			}
		}

		let npm!: NpmAudioPlayer;
		npm = new NpmAudioPlayer(
			this.proxyCallbacks(() => this.engine === npm),
		);
		await npm.start();
		if (this.disposed) {
			await npm.dispose();
			throw new Error("Audio player is disposed");
		}
		this.engine = npm;
		this.applySettings(npm);
	}

	private proxyCallbacks(isSelected: () => boolean): AudioPlayerCallbacks {
		return {
			onUpdate: (snapshot) => {
				if (isSelected()) this.callbacks.onUpdate?.(snapshot);
			},
			onIdle: () => {
				if (isSelected()) this.callbacks.onIdle?.();
			},
			onError: (error) => {
				if (isSelected()) this.callbacks.onError?.(error);
			},
		};
	}

	private applySettings(engine: AudioPlayer): void {
		engine.setSpeed(this.speed);
		engine.setVolume(this.volume);
		engine.setPaused(this.paused);
		this.callbacks.onUpdate?.(engine.state);
	}
}
