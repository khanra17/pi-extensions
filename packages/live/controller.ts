import type { CodexVoiceAuth } from "../../shared/codex.ts";
import { isRecord, textContent } from "../../shared/messages.ts";
import { claimMicrophone } from "../../shared/microphone.ts";
import { loadLiveNative, type LiveAudioCapture, type LiveNativeBindings } from "./native.ts";
import {
	buildDelegationContextAppend,
	buildSessionClose,
	buildSessionContextAppend,
	chunkLiveContext,
	type LiveClientMessage,
	type LiveServerEvent,
} from "./protocol.ts";
import type { LiveTransportOptions } from "./transport.ts";
import { DEFAULT_LIVE_VOICE } from "./voices.ts";

const OUTPUT_ACTIVE_LEVEL = 0.015;
const MIN_BARGE_IN_LEVEL = 0.04;
const OUTPUT_ECHO_RATIO = 0.65;
const DIGITAL_SILENCE_SAMPLE_LIMIT = 32_000;

import { LIVE_INSTRUCTIONS } from "./instructions.ts";

export type LivePhase =
	| "standby"
	| "connecting"
	| "listening"
	| "working"
	| "speaking"
	| "muted"
	| "error";

export interface LiveTranscript {
	role: "user" | "assistant";
	text: string;
	turn: number;
	final: boolean;
}

export interface LiveSessionCallbacks {
	onPhase(phase: LivePhase): void;
	onLevels(input: number, output: number): void;
	onTranscript(transcript: LiveTranscript | undefined): void;
	onTerminal(error?: Error): void;
}

export interface LiveTransport {
	connect(): Promise<void>;
	send(message: LiveClientMessage): Promise<void>;
	pushAudio(samples: Float32Array): void;
	setMuted(muted: boolean): void;
	close(): Promise<void>;
}

export interface LiveSessionControllerOptions {
	sessionId: string;
	getAuth(signal?: AbortSignal): Promise<CodexVoiceAuth>;
	delegate(request: string): void;
	callbacks: LiveSessionCallbacks;
	voice?: string;
	startupContext?: string;
	signal?: AbortSignal;
	native?: LiveNativeBindings;
	createTransport?: (options: LiveTransportOptions) => LiveTransport | Promise<LiveTransport>;
	/** False when the browser owns microphone capture and WebRTC audio. */
	captureAudio?: boolean;
	createAudioCapture?: (
		native: LiveNativeBindings,
		onAudio: (error: Error | null, samples: Float32Array) => void,
	) => LiveAudioCapture;
}

type AssistantSnapshot = {
	text: string;
	stopReason: string | undefined;
	errorMessage: string | undefined;
};

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function clampLevel(level: number): number {
	if (!Number.isFinite(level) || level <= 0) return 0;
	return Math.min(1, level);
}

export function microphoneLevel(samples: Float32Array): number {
	if (samples.length === 0) return 0;
	let sumSquares = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const sample = samples[index] ?? 0;
		sumSquares += sample * sample;
	}
	return clampLevel(Math.sqrt(sumSquares / samples.length));
}

export function extractAssistantSnapshot(message: unknown): AssistantSnapshot | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) {
		return undefined;
	}
	const text = textContent(message.content);
	return {
		text,
		stopReason: typeof message.stopReason === "string" ? message.stopReason : undefined,
		errorMessage: typeof message.errorMessage === "string" ? message.errorMessage : undefined,
	};
}

export class LiveSessionController {
	private readonly options: LiveSessionControllerOptions;
	private readonly callbacks: LiveSessionCallbacks;
	private readonly voice: string;
	private readonly createTransport: (options: LiveTransportOptions) => LiveTransport | Promise<LiveTransport>;
	private readonly createAudioCapture: LiveSessionControllerOptions["createAudioCapture"];
	private native: LiveNativeBindings | undefined;
	private transport: LiveTransport | undefined;
	private recorder: LiveAudioCapture | undefined;
	private releaseInput?: () => void;
	private sendChain: Promise<void> = Promise.resolve();
	private stopPromise: Promise<void> | undefined;
	private started = false;
	private stopped = false;
	private terminalEmitted = false;
	private failure: Error | undefined;
	private mutedValue = false;
	private phaseValue: LivePhase = "connecting";
	private inputLevel = 0;
	private outputLevel = 0;
	private digitalSilenceSampleCount = 0;
	private microphoneSignalDetected = false;
	private activeDelegationIdValue: string | undefined;
	private pendingAgentFinal = "";
	private userTranscript = "";
	private assistantTranscript = "";
	private userTranscriptFinal = false;
	private assistantTranscriptFinal = false;
	private userTranscriptTurn = 0;
	private assistantTranscriptTurn = 0;
	private lastTranscript: LiveTranscript | undefined;

	constructor(options: LiveSessionControllerOptions) {
		this.options = options;
		this.callbacks = options.callbacks;
		this.voice = options.voice?.trim() || DEFAULT_LIVE_VOICE;
		this.native = options.native;
		this.createTransport =
			options.createTransport ??
			(async (transportOptions) => {
				const { CodexLiveTransport } = await import("./transport.ts");
				return new CodexLiveTransport(transportOptions);
			});
		this.createAudioCapture = options.createAudioCapture;
	}

	get phase(): LivePhase {
		return this.phaseValue;
	}

	get currentPhase(): LivePhase {
		return this.phaseValue;
	}

	get muted(): boolean {
		return this.mutedValue;
	}

	get isMuted(): boolean {
		return this.mutedValue;
	}

	get activeDelegationId(): string | undefined {
		return this.activeDelegationIdValue;
	}

	get activeDelegation(): string | undefined {
		return this.activeDelegationIdValue;
	}

	async start(): Promise<void> {
		if (this.stopped) throw this.failure ?? new Error("This live session has already stopped.");
		if (this.started) return;
		this.started = true;
		this.emitPhase("connecting", true);
		this.emitTranscript(undefined);

		try {
			this.releaseInput = claimMicrophone(this.options.sessionId, "live");
			const native = this.options.captureAudio === false ? undefined : (this.native ?? loadLiveNative());
			this.native = native;
			const transport = await this.createTransport({
				getAuth: this.options.getAuth,
				sessionId: this.options.sessionId,
				instructions: [LIVE_INSTRUCTIONS, this.options.startupContext].filter(Boolean).join("\n\n"),
				voice: this.voice,
				signal: this.options.signal,
				native,
				callbacks: {
					onEvent: (event) => this.guardEvent(() => this.handleLiveEvent(event)),
					onOutputLevel: (level) => this.guardEvent(() => this.handleOutputLevel(level)),
				},
			});
			if (this.stopped) { await transport.close(); throw new Error("Live connection was cancelled."); }
			this.transport = transport;
			await transport.connect();
			if (this.stopped) throw this.failure ?? new Error("The live session stopped while connecting.");

			if (native) {
			const onAudio = (error: Error | null, samples: Float32Array) => {
				if (error) this.reportFailure(error);
				else this.handleMicrophoneAudio(samples);
			};
			const recorder = this.createAudioCapture
				? this.createAudioCapture(native, onAudio)
				: new native.AudioCapture(16_000, onAudio);
			if (this.stopped) {
				recorder.stop();
				throw this.failure ?? new Error("The live session stopped while recording began.");
			}
			this.recorder = recorder;
			}
			transport.setMuted(this.mutedValue);
			this.refreshAudioPhase();
		} catch (cause) {
			const error = errorFrom(cause);
			this.reportFailure(error);
			await this.stop();
			throw error;
		}
	}

	toggleMute(): void {
		if (this.stopped) return;
		this.mutedValue = !this.mutedValue;
		if (this.mutedValue) {
			this.inputLevel = 0;
			this.emitLevels();
		}
		this.refreshAudioPhase();
		try {
			this.transport?.setMuted(this.mutedValue);
		} catch (cause) {
			this.reportFailure(errorFrom(cause));
		}
	}

	handleAgentMessage(message: unknown): void {
		if (!this.activeDelegationIdValue || this.stopped) return;
		const snapshot = extractAssistantSnapshot(message);
		if (!snapshot) return;
		if (snapshot.stopReason === "toolUse") {
			if (!snapshot.text) return;
			for (const chunk of chunkLiveContext(snapshot.text)) {
				this.queueSend(buildDelegationContextAppend(this.activeDelegationIdValue, chunk, "commentary"));
			}
			return;
		}
		if (snapshot.text) this.pendingAgentFinal = snapshot.text;
		else if (snapshot.errorMessage) this.pendingAgentFinal = snapshot.errorMessage;
	}

	handleAgentSettled(): void {
		const delegationId = this.activeDelegationIdValue;
		if (!delegationId || this.stopped) return;
		const finalText =
			this.pendingAgentFinal || "The requested coding task ended without a final response.";
		const context = `"Agent Final Message":\n\n${finalText}`;
		for (const chunk of chunkLiveContext(context)) {
			this.queueSend(buildDelegationContextAppend(delegationId, chunk));
		}
		this.activeDelegationIdValue = undefined;
		this.pendingAgentFinal = "";
		this.refreshAudioPhase();
	}

	stop(): Promise<void> {
		if (!this.stopPromise) this.stopPromise = this.stopInternal();
		return this.stopPromise;
	}

	private async stopInternal(): Promise<void> {
		this.stopped = true;
		let cleanupError: Error | undefined;
		const recorder = this.recorder;
		this.recorder = undefined;
		if (recorder) {
			try {
				recorder.stop();
			} catch (cause) {
				cleanupError = errorFrom(cause);
			}
		}

		await this.sendChain;
		const transport = this.transport;
		this.transport = undefined;
		if (transport) {
			try {
				await transport.send(buildSessionClose());
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
			try {
				await transport.close();
			} catch (cause) {
				cleanupError ??= errorFrom(cause);
			}
		}
		this.releaseInput?.();
		this.releaseInput = undefined;
		if (cleanupError) this.emitPhaseSafely("error");
		this.emitTerminal(this.failure ?? cleanupError);
	}

	private guardEvent(handler: () => void): void {
		if (this.stopped) return;
		try {
			handler();
		} catch (cause) {
			this.reportFailure(errorFrom(cause));
		}
	}

	private handleLiveEvent(event: LiveServerEvent): void {
		switch (event.type) {
			case "session.started":
				this.emitPhase("listening");
				break;
			case "input_transcript.added":
				this.addTranscript("user", event.item.text);
				break;
			case "output_transcript.added":
				this.addTranscript("assistant", event.item.text);
				break;
			case "turn.done":
				this.finishTranscript(event.turn.role, event.turn.transcript);
				break;
			case "delegation.created":
				this.handleDelegation(event);
				break;
			case "error":
				this.reportFailure(new Error(event.message));
				break;
			case "session.updated":
			case "output_audio.delta":
			case "unknown":
				break;
		}
	}

	private handleDelegation(event: Extract<LiveServerEvent, { type: "delegation.created" }>): void {
		const request = event.item.content
			.filter((content) => content.type === "input_text")
			.map((content) => content.text)
			.join("\n")
			.trim();
		if (!request) return;
		if (this.activeDelegationIdValue) {
			this.queueSend(
				buildSessionContextAppend(
					"A coding request is already in progress. Continue the current request before starting another.",
					"commentary",
				),
			);
			return;
		}
		this.activeDelegationIdValue = event.item.id;
		this.pendingAgentFinal = "";
		this.emitPhase("working");
		try {
			this.options.delegate(request);
		} catch (cause) {
			this.reportFailure(errorFrom(cause));
		}
	}

	private handleOutputLevel(level: number): void {
		this.outputLevel = clampLevel(level);
		this.emitLevels();
		if (!this.activeDelegationIdValue) this.refreshAudioPhase();
	}

	private handleMicrophoneAudio(samples: Float32Array): void {
		if (this.stopped || !this.transport || this.mutedValue || samples.length === 0) return;
		if (!this.microphoneSignalDetected) {
			const hasSignal = samples.some((sample) => sample !== 0);
			if (hasSignal) {
				this.microphoneSignalDetected = true;
			} else {
				this.digitalSilenceSampleCount += samples.length;
				if (this.digitalSilenceSampleCount >= DIGITAL_SILENCE_SAMPLE_LIMIT) {
					const hint =
						process.platform === "darwin" && process.env.LOCALTERM
							? " Run `localterm install`, restart LocalTerm, and allow its microphone prompt."
							: " Check operating-system microphone permission and the selected input device.";
					this.reportFailure(new Error(`Microphone input contains only digital silence.${hint}`));
					return;
				}
			}
		}

		this.inputLevel = microphoneLevel(samples);
		this.emitLevels();
		const outputActive = this.outputLevel > OUTPUT_ACTIVE_LEVEL;
		const echoThreshold = Math.max(MIN_BARGE_IN_LEVEL, this.outputLevel * OUTPUT_ECHO_RATIO);
		if (outputActive && this.inputLevel < echoThreshold) return;
		try {
			this.transport.pushAudio(samples);
		} catch (cause) {
			this.reportFailure(errorFrom(cause));
		}
	}

	private addTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.userTranscript : this.assistantTranscript;
		const wasFinal = role === "user" ? this.userTranscriptFinal : this.assistantTranscriptFinal;
		let next: string;
		if (!current) {
			this.startTranscriptTurn(role);
			next = text;
		} else if (wasFinal) {
			if (text === current || current.endsWith(text)) return;
			this.startTranscriptTurn(role);
			next = text;
		} else if (text.startsWith(current)) {
			next = text;
		} else if (current.endsWith(text)) {
			next = current;
		} else {
			next = `${current}${text}`;
		}
		this.storeTranscript(role, next, false);
	}

	private finishTranscript(role: LiveTranscript["role"], text: string): void {
		if (!text) return;
		const current = role === "user" ? this.userTranscript : this.assistantTranscript;
		const wasFinal = role === "user" ? this.userTranscriptFinal : this.assistantTranscriptFinal;
		if (!current) this.startTranscriptTurn(role);
		else if (wasFinal) {
			if (text === current) return;
			this.startTranscriptTurn(role);
		}
		const next = !wasFinal && current.startsWith(text) && current.length > text.length ? current : text;
		this.storeTranscript(role, next, true);
	}

	private startTranscriptTurn(role: LiveTranscript["role"]): void {
		if (role === "user") this.userTranscriptTurn += 1;
		else this.assistantTranscriptTurn += 1;
	}

	private storeTranscript(role: LiveTranscript["role"], text: string, final: boolean): void {
		const normalized = text.trim();
		if (!normalized) return;
		const turn = role === "user" ? this.userTranscriptTurn : this.assistantTranscriptTurn;
		if (role === "user") {
			this.userTranscript = normalized;
			this.userTranscriptFinal = final;
		} else {
			this.assistantTranscript = normalized;
			this.assistantTranscriptFinal = final;
		}
		if (
			this.lastTranscript?.role === role &&
			this.lastTranscript.turn === turn &&
			this.lastTranscript.text === normalized &&
			this.lastTranscript.final === final
		) {
			return;
		}
		this.emitTranscript({ role, turn, text: normalized, final });
	}

	private queueSend(message: LiveClientMessage): void {
		const transport = this.transport;
		if (!transport || this.stopped) return;
		this.sendChain = this.sendChain
			.then(async () => {
				if (!this.stopped) await transport.send(message);
			})
			.catch((cause) => this.reportFailure(errorFrom(cause)));
	}

	private refreshAudioPhase(): void {
		if (this.stopped) return;
		if (this.mutedValue) this.emitPhase("muted");
		else if (this.activeDelegationIdValue) this.emitPhase("working");
		else if (this.outputLevel > OUTPUT_ACTIVE_LEVEL) this.emitPhase("speaking");
		else this.emitPhase("listening");
	}

	private emitPhase(phase: LivePhase, force = false): void {
		if (!force && this.phaseValue === phase) return;
		this.phaseValue = phase;
		try {
			this.callbacks.onPhase(phase);
		} catch (cause) {
			this.reportFailure(errorFrom(cause));
		}
	}

	private emitPhaseSafely(phase: LivePhase): void {
		this.phaseValue = phase;
		try {
			this.callbacks.onPhase(phase);
		} catch {
			// Terminal cleanup must continue even when rendering is unavailable.
		}
	}

	private emitLevels(): void {
		try {
			this.callbacks.onLevels(this.inputLevel, this.outputLevel);
		} catch {
			// A visualizer update is never allowed to terminate a live call.
		}
	}

	private emitTranscript(transcript: LiveTranscript | undefined): void {
		this.lastTranscript = transcript;
		try {
			this.callbacks.onTranscript(transcript);
		} catch {
			// Transcript rendering is best-effort.
		}
	}

	private reportFailure(error: Error): void {
		if (this.terminalEmitted) return;
		this.failure = error;
		this.emitPhaseSafely("error");
		this.emitTerminal(error);
		void this.stop();
	}

	private emitTerminal(error?: Error): void {
		if (this.terminalEmitted) return;
		this.terminalEmitted = true;
		try {
			this.callbacks.onTerminal(error);
		} catch {
			// Nothing remains above the terminal callback to receive this error.
		}
	}
}
