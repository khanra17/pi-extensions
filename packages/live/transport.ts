import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import WebSocket, { type RawData } from "ws";
import type { CodexVoiceAuth } from "../../shared/codex.ts";
import { generateCodexAttestation } from "./attestation.ts";
import { loadLiveNative, type LiveNativeBindings, type LiveWebRtcPeerInstance } from "./native.ts";
import {
	buildLiveSessionPayload,
	parseLiveServerEvent,
	type LiveClientMessage,
	type LiveServerEvent,
} from "./protocol.ts";

const DEFAULT_SIGNALING_BASE_URL = "https://chatgpt.com/backend-api";
const CODEX_CLIENT_VERSION = "0.144.1";
const SIGNALING_PATH = "/codex/realtime/calls";
const SIGNALING_QUERY = "intent=quicksilver&architecture=avas";
const MAX_ERROR_BODY_LENGTH = 2_048;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const LIVE_ORIGINATOR = "Codex Desktop";
const LIVE_CALL_ID_PATTERN = /^rtc_[\w-]+$/u;

export interface LiveTransportCallbacks {
	onEvent(event: LiveServerEvent): void;
	onOutputLevel(level: number): void;
}

export interface LiveTransportOptions {
	getAuth(signal?: AbortSignal): Promise<CodexVoiceAuth>;
	sessionId: string;
	instructions: string;
	voice: string;
	callbacks: LiveTransportCallbacks;
	signal?: AbortSignal;
	native?: LiveNativeBindings;
	/** Browser owns the WebRTC peer and media tracks; Node only signals and handles sideband. */
	browserOffer?: string;
	onBrowserAnswer?: (answer: string) => void;
	/** Browser must apply the answer and establish WebRTC before sideband attachment. */
	waitForBrowserPeer?: () => Promise<void>;
}

type Lifecycle = "idle" | "connecting" | "connected" | "closing" | "closed";

type SignalingResult = {
	answer: string;
	callId: string;
	auth: CodexVoiceAuth;
	attestation?: string;
};

type LiveWebSocketOptions = {
	headers: Record<string, string>;
	agent?: unknown;
};

const WebSocketConstructor = WebSocket as unknown as new (
	url: string,
	options: LiveWebSocketOptions,
) => WebSocket;

function errorFrom(cause: unknown): Error {
	return cause instanceof Error ? cause : new Error(String(cause));
}

function abortReason(signal: AbortSignal | undefined): Error {
	if (signal?.reason instanceof Error) return signal.reason;
	return new Error("Live voice connection aborted.");
}

function boundedErrorBody(body: string, statusText: string): string {
	const normalized = body.trim().replaceAll(/\s+/gu, " ");
	if (!normalized) return statusText || "empty response body";
	return normalized.length <= MAX_ERROR_BODY_LENGTH
		? normalized
		: `${normalized.slice(0, MAX_ERROR_BODY_LENGTH)}…`;
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			signal?.removeEventListener("abort", onAbort);
			reject(abortReason(signal));
		};
		timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		timeout.unref?.();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function parseLiveCallId(location: string | null): string | undefined {
	if (!location) return undefined;
	return location
		.split("?", 1)[0]
		?.split("/")
		.find((segment) => LIVE_CALL_ID_PATTERN.test(segment));
}

export function buildLiveSignalingUrl(baseUrl = DEFAULT_SIGNALING_BASE_URL): string {
	const base = new URL(baseUrl);
	base.pathname = `${base.pathname.replace(/\/+$/u, "")}${SIGNALING_PATH}`;
	base.search = SIGNALING_QUERY;
	base.hash = "";
	return base.toString();
}

export function buildLiveSidebandUrl(callId: string): string {
	return `wss://api.openai.com/v1/live/${encodeURIComponent(callId)}`;
}

export function buildLiveHeaders(
	auth: CodexVoiceAuth,
	sessionId: string,
	realtimeSessionId: string,
	attestation: string | undefined,
): Record<string, string> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${auth.accessToken}`,
		"OpenAI-Alpha": "quicksilver=v2",
		"User-Agent": `Codex Desktop/${CODEX_CLIENT_VERSION}`,
		"x-session-id": realtimeSessionId,
		originator: LIVE_ORIGINATOR,
		version: CODEX_CLIENT_VERSION,
		"session-id": sessionId,
		"thread-id": sessionId,
		"chatgpt-account-id": auth.accountId,
	};
	if (attestation) headers["x-oai-attestation"] = attestation;
	return headers;
}

/** WebRTC carries microphone/output audio; the sideband carries text and delegation events. */
export class CodexLiveTransport {
	private readonly options: LiveTransportOptions;
	private readonly native: LiveNativeBindings | undefined;
	private readonly realtimeSessionId = crypto.randomUUID();
	private readonly closeController = new AbortController();
	private readonly operationSignal: AbortSignal;
	private readonly abortListener: () => void;
	private peer: LiveWebRtcPeerInstance | undefined;
	private sideband: WebSocket | undefined;
	private state: Lifecycle = "idle";
	private connectPromise: Promise<void> | undefined;
	private closePromise: Promise<void> | undefined;
	private sendTail: Promise<void> = Promise.resolve();
	private muted = false;
	private unexpectedFailureReported = false;

	constructor(options: LiveTransportOptions) {
		this.options = options;
		this.native = options.native ?? (options.browserOffer ? undefined : loadLiveNative());
		this.operationSignal = options.signal
			? AbortSignal.any([options.signal, this.closeController.signal])
			: this.closeController.signal;
		this.abortListener = () => {
			void this.close();
		};
		if (!options.signal?.aborted) {
			options.signal?.addEventListener("abort", this.abortListener, { once: true });
		}
	}

	get connected(): boolean {
		return this.state === "connected";
	}

	connect(): Promise<void> {
		if (this.state === "connected") return Promise.resolve();
		if (this.connectPromise) return this.connectPromise;
		if (this.state === "closing" || this.state === "closed") {
			return Promise.reject(new Error("Live transport is closed."));
		}
		if (this.operationSignal.aborted) return Promise.reject(abortReason(this.operationSignal));
		this.state = "connecting";
		const operation = this.connectInternal().catch(async (cause) => {
			await this.close();
			throw cause;
		});
		this.connectPromise = operation;
		void operation.then(
			() => {
				if (this.connectPromise === operation) this.connectPromise = undefined;
			},
			() => {
				if (this.connectPromise === operation) this.connectPromise = undefined;
			},
		);
		return operation;
	}

	private async connectInternal(): Promise<void> {
		if (this.options.browserOffer) {
			const signaling = await this.signalOffer(this.options.browserOffer);
			if (this.state !== "connecting") throw abortReason(this.operationSignal);
			this.options.onBrowserAnswer?.(signaling.answer);
			await this.options.waitForBrowserPeer?.();
			if (this.state !== "connecting") throw abortReason(this.operationSignal);
			await this.connectSideband(signaling.callId, signaling.auth, signaling.attestation);
			if (this.state !== "connecting") throw abortReason(this.operationSignal);
			this.state = "connected";
			return;
		}
		if (!this.native) throw new Error("Native WebRTC is unavailable.");
		const peer = new this.native.LiveWebRtcPeer(
			(error, payload) => {
				if (error) this.reportFailure(error.message);
				else this.handlePeerEvent(payload);
			},
			(error, level) => {
				if (error) this.reportFailure(error.message);
				else this.handleOutputLevel(level);
			},
			(error, message) => this.reportFailure(error?.message ?? message),
		);
		this.peer = peer;
		const offer = await peer.createOffer();
		if (this.state !== "connecting") throw abortReason(this.operationSignal);
		const signaling = await this.signalOffer(offer);
		await peer.acceptAnswer(signaling.answer);
		peer.setMuted(this.muted);
		await peer.waitForOpen();
		if (this.state !== "connecting") throw abortReason(this.operationSignal);
		await this.connectSideband(signaling.callId, signaling.auth, signaling.attestation);
		if (this.state !== "connecting") throw abortReason(this.operationSignal);
		this.state = "connected";
	}

	private async signalOffer(offer: string): Promise<SignalingResult> {
		const auth = await this.options.getAuth(this.operationSignal);
		if (!auth.accessToken || !auth.accountId) {
			throw new Error("OpenAI Codex OAuth credentials are incomplete. Run /login and choose OpenAI Codex.");
		}
		const attestation = await generateCodexAttestation(this.native ?? {});
		const url = buildLiveSignalingUrl(auth.baseUrl);
		const headers = buildLiveHeaders(auth, this.options.sessionId, this.realtimeSessionId, attestation);
		const proxyUrl = getProxyForUrl(url);
		const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
		try {
			const response = await undiciFetch(url, {
				method: "POST",
				headers: { ...headers, Accept: "*/*", "Content-Type": "application/json" },
				body: JSON.stringify({
					sdp: offer,
					session: buildLiveSessionPayload(this.options.instructions, this.options.voice),
				}),
				signal: this.operationSignal,
				...(dispatcher ? { dispatcher } : {}),
			});
			const responseBody = await response.text();
			if (!response.ok) {
				throw new Error(
					`Codex live signaling failed (${response.status}): ${boundedErrorBody(responseBody, response.statusText)}`,
				);
			}
			if (!responseBody.trim()) throw new Error("Codex live signaling returned an empty SDP answer.");
			const callId = parseLiveCallId(response.headers.get("location"));
			if (!callId) throw new Error("Codex live signaling returned no valid call ID.");
			return { answer: responseBody, callId, auth, attestation };
		} finally {
			await dispatcher?.close();
		}
	}

	private async connectSideband(
		callId: string,
		auth: CodexVoiceAuth,
		attestation: string | undefined,
	): Promise<void> {
		let failure = new Error("Codex live sideband connection failed.");
		for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt += 1) {
			try {
				await this.openSideband(callId, auth, attestation);
				return;
			} catch (cause) {
				failure = errorFrom(cause);
				if (this.operationSignal.aborted) throw abortReason(this.operationSignal);
				if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) {
					await wait(200 * 2 ** attempt, this.operationSignal);
				}
			}
		}
		throw failure;
	}

	private openSideband(
		callId: string,
		auth: CodexVoiceAuth,
		attestation: string | undefined,
	): Promise<void> {
		const url = buildLiveSidebandUrl(callId);
		const proxyUrl = getProxyForUrl(url);
		const socket = new WebSocketConstructor(url, {
			headers: buildLiveHeaders(auth, this.options.sessionId, this.realtimeSessionId, attestation),
			...(proxyUrl ? { agent: new HttpsProxyAgent(proxyUrl) } : {}),
		});
		return new Promise((resolve, reject) => {
			let opened = false;
			let settled = false;
			let timeout: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeout) clearTimeout(timeout);
				timeout = undefined;
				this.operationSignal.removeEventListener("abort", onAbort);
			};
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const onAbort = () => {
				try {
					socket.close(1000, "aborted");
				} catch {
					socket.terminate();
				}
				finish(abortReason(this.operationSignal));
			};

			socket.once("open", () => {
				if (settled) {
					socket.close(1000, "stale");
					return;
				}
				opened = true;
				settled = true;
				cleanup();
				this.sideband = socket;
				resolve();
			});
			socket.on("message", (data: RawData, isBinary: boolean) => {
				if (isBinary) {
					this.reportFailure("Codex live sideband returned an unexpected binary frame.");
					return;
				}
				this.handleSidebandEvent(data.toString());
			});
			socket.on("error", (cause) => {
				const detail = cause.message ? `: ${cause.message}` : "";
				if (!opened) {
					finish(new Error(`Codex live sideband connection failed${detail}`));
					socket.terminate();
					return;
				}
				this.reportFailure(`Codex live sideband failed${detail}`);
			});
			socket.once("close", (code, reason) => {
				if (!opened) {
					finish(new Error(`Codex live sideband closed before connecting (${code}).`));
					return;
				}
				if (this.sideband !== socket) return;
				this.sideband = undefined;
				if (this.state === "connecting" || this.state === "connected") {
					const detail = reason.length > 0 ? `: ${reason.toString()}` : "";
					this.reportFailure(`Codex live sideband closed (${code})${detail}`);
				}
			});

			if (this.operationSignal.aborted) onAbort();
			else {
				this.operationSignal.addEventListener("abort", onAbort, { once: true });
				timeout = setTimeout(() => {
					socket.close(1000, "connect timeout");
					finish(new Error("Codex live sideband connection timed out."));
				}, SIDEBAND_CONNECT_TIMEOUT_MS);
				timeout.unref?.();
			}
		});
	}

	private handleSidebandEvent(payload: string): void {
		if (this.state === "closing" || this.state === "closed") return;
		const event = parseLiveServerEvent(payload);
		if (!event) return;
		try {
			this.options.callbacks.onEvent(event);
		} catch {
			// UI callbacks cannot corrupt the transport lifecycle.
		}
	}

	private handlePeerEvent(payload: string): void {
		if (this.state === "closing" || this.state === "closed") return;
		const event = parseLiveServerEvent(payload);
		if (!event || (this.sideband?.readyState === WebSocket.OPEN && event.type !== "error")) return;
		try {
			this.options.callbacks.onEvent(event);
		} catch {
			// Sideband is authoritative whenever it is available.
		}
	}

	private handleOutputLevel(level: number): void {
		if (this.state !== "connected" || !Number.isFinite(level)) return;
		try {
			this.options.callbacks.onOutputLevel(Math.min(1, Math.max(0, level)));
		} catch {
			// Level updates are best-effort UI notifications.
		}
	}

	private reportFailure(message: string): void {
		if (
			(this.state !== "connecting" && this.state !== "connected") ||
			this.unexpectedFailureReported
		) {
			return;
		}
		this.unexpectedFailureReported = true;
		try {
			this.options.callbacks.onEvent({ type: "error", message });
		} catch {
			// The session controller still owns cleanup if a callback fails.
		}
	}

	send(message: LiveClientMessage): Promise<void> {
		const operation = this.sendTail.then(() => {
			if (this.state !== "connected") throw new Error("Live transport is not connected.");
			const sideband = this.sideband;
			if (!sideband || sideband.readyState !== WebSocket.OPEN) {
				throw new Error("Codex live sideband is not connected.");
			}
			sideband.send(JSON.stringify(message));
		});
		this.sendTail = operation.catch(() => undefined);
		return operation;
	}

	pushAudio(samples: Float32Array): void {
		if (this.state !== "connected" || this.muted || samples.length === 0) return;
		this.peer?.pushAudio(samples);
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
		if (this.state === "connected") this.peer?.setMuted(muted);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.state = "closing";
		this.closeController.abort(new Error("Live transport closed."));
		const operation = this.closeInternal();
		this.closePromise = operation;
		return operation;
	}

	private async closeInternal(): Promise<void> {
		this.options.signal?.removeEventListener("abort", this.abortListener);
		const sideband = this.sideband;
		const peer = this.peer;
		this.sideband = undefined;
		this.peer = undefined;
		if (
			sideband &&
			(sideband.readyState === WebSocket.OPEN || sideband.readyState === WebSocket.CONNECTING)
		) {
			sideband.close(1000, "done");
		}
		if (peer) await peer.close().catch(() => undefined);
		this.state = "closed";
	}
}
