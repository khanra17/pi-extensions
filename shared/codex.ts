import { Buffer } from "node:buffer";
import { arch, platform, release } from "node:os";
import { VERSION, type ExtensionContext } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "openai-codex";
const DEFAULT_BASE_URL = "https://chatgpt.com/backend-api";
const REQUEST_TIMEOUT_MS = 60_000;
const CLIENT_VERSION = VERSION;
const MAX_ATTEMPTS = 3;
const AFFINITY_REFRESH_MS = 10 * 60_000;
const SESSION_COOKIE_TTL_MS = 60 * 60_000;
const COOKIE_ALLOWLIST = new Set(["__cf_bm", "__cflb", "__oailb", "_cfuvid"]);

interface CookieEntry {
	value: string;
	expiresAt: number;
}

const cookieJars = new Map<string, Map<string, CookieEntry>>();
const lastAffinityPrime = new Map<string, number>();

export class CodexTranscriptionBlocked extends Error {
	readonly code = "transcription_blocked";
	readonly retryable = false;
}

export interface CodexVoiceAuth {
	accessToken: string;
	accountId: string;
	baseUrl: string;
	/** OpenAI-compatible Cockpit route; omitted for the native Codex protocol. */
	route?: "openai";
	headers?: Record<string, string | null>;
}

/** Resolve an explicit voice provider, never the current chat model or a fallback account. */
export async function resolveVoiceAuth(ctx: ExtensionContext, providerId = PROVIDER_ID): Promise<CodexVoiceAuth> {
	if (providerId === PROVIDER_ID) return resolveCodexVoiceAuth(ctx);
	const provider = ctx.modelRegistry.getProvider(providerId);
	if (!provider) throw new Error(`Voice provider ${providerId} is not configured in Pi.`);
	const candidate = provider.getModels().find(model => ["openai-completions", "openai-responses", "openai-codex-responses"].includes(model.api));
	if (!candidate) throw new Error(`Voice provider ${providerId} needs an OpenAI-compatible API configuration.`);
	// Provider-level auth/headers/URL apply to voice. Chat model overrides do not.
	const model = { ...candidate, id: "pi-voice", name: "Voice", headers: undefined, baseUrl: provider.baseUrl ?? candidate.baseUrl };
	const resolved = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!resolved.ok) throw new Error(resolved.error);
	const baseUrl = normalizeBaseUrl(resolved.baseUrl ?? model.baseUrl);
	const url = new URL(baseUrl);
	const native = (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") && url.pathname.includes("/backend-api");
	if (native) {
		// Availability snapshots can be stale during startup; use request-time auth.
		if ((await ctx.modelRegistry.getProviderAuth(model.provider))?.source !== "OAuth") throw new Error("Direct Codex voice requires Pi's Codex login, not an API key.");
		const accountId = extractAccountId(resolved.apiKey ?? "");
		if (!resolved.apiKey || !accountId) throw new Error("The selected Codex OAuth credential has no ChatGPT account ID.");
		return { accessToken: resolved.apiKey, accountId, baseUrl, headers: resolved.headers };
	}
	if (url.hostname === "api.openai.com") throw new Error("Choose Cockpit Tools' voice-enabled endpoint or Pi's Codex login. The official paid Speech API is not a fallback.");
	if (!resolved.apiKey && !Object.values(resolved.headers ?? {}).some(Boolean)) throw new Error("The selected OpenAI-compatible endpoint has no configured authentication.");
	return { accessToken: resolved.apiKey ?? "", accountId: "", baseUrl, headers: resolved.headers, route: "openai" };
}

/** Resolve Pi's canonical Codex credential and reject every non-OAuth source. */
export async function resolveCodexVoiceAuth(ctx: ExtensionContext): Promise<CodexVoiceAuth> {
	const provider = ctx.modelRegistry.getProvider(PROVIDER_ID);
	if (!provider?.auth.oauth) {
		throw new Error("Pi's built-in OpenAI Codex OAuth provider is unavailable.");
	}

	const resolved = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
	if (!resolved || resolved.source !== "OAuth" || !resolved.auth.apiKey) {
		throw new Error("OpenAI Codex is not signed in. Run /login and choose OpenAI Codex first.");
	}

	const accountId = extractAccountId(resolved.auth.apiKey);
	if (!accountId) {
		throw new Error("The OpenAI Codex OAuth session has no ChatGPT account ID. Run /login to sign in again.");
	}

	return {
		accessToken: resolved.auth.apiKey,
		accountId,
		baseUrl: normalizeBaseUrl(resolved.auth.baseUrl ?? provider.baseUrl ?? DEFAULT_BASE_URL),
		headers: resolved.auth.headers,
	};
}

/** Transcribe WAV bytes through the same ChatGPT backend route used by Codex. */
export async function transcribeWithCodex(
	audio: Uint8Array,
	auth: CodexVoiceAuth,
	signal: AbortSignal,
): Promise<string> {
	const timeout = new AbortController();
	const timeoutId = setTimeout(() => timeout.abort(new Error("Codex transcription timed out.")), REQUEST_TIMEOUT_MS);
	const linkedSignal = AbortSignal.any([signal, timeout.signal]);

	try {
		if (auth.route !== "openai") await primeCodexAffinityCookies(auth, linkedSignal, false);
		let challengeRetried = false;

		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
			let response: Response;
			try {
				response = await postAudio(audio, auth, linkedSignal);
			} catch (error) {
				if (linkedSignal.aborted) throw error;
				if (attempt + 1 >= MAX_ATTEMPTS) throw error;
				await delay(400 * 2 ** attempt, linkedSignal);
				continue;
			}

			if (auth.route !== "openai") captureCookies(auth, response.headers);
			if (auth.route !== "openai" && isCloudflareChallenge(response) && !challengeRetried) {
				challengeRetried = true;
				await response.arrayBuffer();
				await primeCodexAffinityCookies(auth, linkedSignal, true);
				continue;
			}
			if (isTransientStatus(response.status) && attempt + 1 < MAX_ATTEMPTS) {
				await response.arrayBuffer();
				await delay(retryDelay(response.headers, attempt), linkedSignal);
				continue;
			}
			return await parseTranscriptionResponse(response);
		}

		throw new Error("Codex transcription request failed after the retry limit.");
	} catch (error) {
		if (timeout.signal.aborted && !signal.aborted) {
			throw new Error("Codex transcription timed out after 60 seconds.");
		}
		throw error;
	} finally {
		clearTimeout(timeoutId);
	}
}

async function postAudio(audio: Uint8Array, auth: CodexVoiceAuth, signal: AbortSignal): Promise<Response> {
	const form = new FormData();
	form.append("file", new Blob([new Uint8Array(audio)], { type: "audio/wav" }), "audio.wav");
	if (auth.route === "openai") {
		form.append("model", "whisper-1");
		form.append("response_format", "json");
	}
	const headers = codexRequestHeaders(auth);
	const cookie = auth.route !== "openai" ? codexAffinityCookieHeader(auth) : undefined;
	if (cookie) headers.cookie = cookie;
	delete headers["content-type"]; // FormData owns the multipart boundary.
	return fetch(`${auth.baseUrl}/${auth.route === "openai" ? "audio/transcriptions" : "transcribe"}`, { method: "POST", redirect: "error", headers, body: form, signal });
}

async function parseTranscriptionResponse(response: Response): Promise<string> {
	if (!response.ok) {
		const detail = compact(await response.text().catch(() => ""));
		if (response.status === 403 && isCloudflareChallenge(response)) {
			const ray = response.headers.get("cf-ray");
			throw new CodexTranscriptionBlocked(
				`OpenAI's transcription route was blocked by a Cloudflare challenge${ray ? ` (${ray})` : ""}. ` +
					"This response does not establish whether your credentials are valid or which rule blocked the request. Your draft has not been sent as a message.",
			);
		}
		if (response.status === 401) {
			throw new Error("The transcription endpoint rejected the configured credential (401). Check this provider's authentication.");
		}
		if (response.status === 403) {
			throw new Error(`The transcription endpoint rejected the request (403)${detail ? `: ${detail}` : ""}`);
		}
		if (response.status === 413) throw new Error("The voice recording was too large for Codex to transcribe.");
		if (response.status === 429) throw new Error("Codex transcription is temporarily rate limited. Try again shortly.");
		throw new Error(`Codex transcription failed (${response.status})${detail ? `: ${detail}` : ""}`);
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new Error("Codex returned an invalid transcription response.");
	}
	const text = isRecord(body) && typeof body.text === "string" ? body.text.trim() : "";
	if (!text) throw new Error("No speech was recognized. Try speaking closer to the microphone.");
	return text;
}

/** Mirror Codex's process-local ChatGPT affinity-cookie behavior without persisting cookies. */
export async function primeCodexAffinityCookies(auth: CodexVoiceAuth, signal: AbortSignal, force = false): Promise<void> {
	const key = cookieKey(auth);
	const lastPrime = lastAffinityPrime.get(key) ?? 0;
	if (!force && lastPrime && Date.now() - lastPrime < AFFINITY_REFRESH_MS) return;
	if (force) {
		cookieJars.delete(key);
		lastAffinityPrime.delete(key);
	}

	const url = new URL(`${auth.baseUrl}/codex/models`);
	url.searchParams.set("client_version", CLIENT_VERSION);
	const headers = codexRequestHeaders(auth);
	const existing = codexAffinityCookieHeader(auth);
	if (existing) headers.Cookie = existing;

	const response = await fetch(url, { headers, signal });
	captureCookies(auth, response.headers);
	await response.arrayBuffer();
	if (response.ok || codexAffinityCookieHeader(auth)) lastAffinityPrime.set(key, Date.now());
}

export function codexRequestHeaders(auth: CodexVoiceAuth): Record<string, string> {
	const headers = new Headers({ Accept: "application/json" });
	if (auth.accessToken) headers.set("Authorization", `Bearer ${auth.accessToken}`);
	if (auth.route !== "openai") {
		headers.set("ChatGPT-Account-Id", auth.accountId);
		headers.set("originator", "pi");
		headers.set("User-Agent", `pi (${platform()} ${release()}; ${arch()})`);
	}
	for (const [name, value] of Object.entries(auth.headers ?? {})) {
		if (value === null) headers.delete(name); else headers.set(name, value);
	}
	const result: Record<string, string> = {}; headers.forEach((value, name) => { result[name] = value; });
	return result;
}

function captureCookies(auth: CodexVoiceAuth, headers: Headers): void {
	const key = cookieKey(auth);
	let jar = cookieJars.get(key);
	if (!jar) {
		jar = new Map();
		cookieJars.set(key, jar);
	}
	const values = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
	for (const setCookie of values) {
		const pair = setCookie.split(";", 1)[0];
		if (!pair) continue;
		const separator = pair.indexOf("=");
		if (separator <= 0) continue;
		const name = pair.slice(0, separator).trim();
		if (!COOKIE_ALLOWLIST.has(name)) continue;
		const value = pair.slice(separator + 1).trim();
		const expiresAt = cookieExpiry(setCookie);
		if (!value || expiresAt <= Date.now()) jar.delete(name);
		else jar.set(name, { value, expiresAt });
	}
}

export function codexAffinityCookieHeader(auth: CodexVoiceAuth): string | undefined {
	const jar = cookieJars.get(cookieKey(auth));
	if (!jar?.size) return undefined;
	const now = Date.now();
	for (const [name, entry] of jar) {
		if (entry.expiresAt <= now) jar.delete(name);
	}
	if (!jar.size) return undefined;
	return [...jar].map(([name, entry]) => `${name}=${entry.value}`).join("; ");
}

function cookieKey(auth: CodexVoiceAuth): string {
	return `${new URL(auth.baseUrl).origin}:${auth.accountId}`;
}

function cookieExpiry(setCookie: string): number {
	const maxAge = setCookie.match(/(?:^|;)\s*max-age=(\d+)/iu)?.[1];
	if (maxAge) return Date.now() + Number(maxAge) * 1_000;
	const expires = setCookie.match(/(?:^|;)\s*expires=([^;]+)/iu)?.[1];
	if (expires) {
		const timestamp = Date.parse(expires);
		if (Number.isFinite(timestamp)) return timestamp;
	}
	return Date.now() + SESSION_COOKIE_TTL_MS;
}

function isCloudflareChallenge(response: Response): boolean {
	return (
		response.status === 403 &&
		(response.headers.get("cf-mitigated")?.toLowerCase() === "challenge" ||
			(response.headers.get("server")?.toLowerCase() === "cloudflare" &&
				response.headers.get("content-type")?.toLowerCase().includes("text/html") === true))
	);
}

function isTransientStatus(status: number): boolean {
	return status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function retryDelay(headers: Headers, attempt: number): number {
	const value = headers.get("retry-after");
	if (value) {
		const seconds = Number(value);
		if (Number.isFinite(seconds)) return Math.min(5_000, Math.max(0, seconds * 1_000));
		const date = Date.parse(value);
		if (Number.isFinite(date)) return Math.min(5_000, Math.max(0, date - Date.now()));
	}
	return 400 * 2 ** attempt;
}

function normalizeBaseUrl(value: string): string {
	const url = new URL(value.trim());
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Invalid OpenAI Codex base URL.");
	url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/backend-api\/codex$/u, "/backend-api");
	url.search = "";
	url.hash = "";
	if ((url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com") && !url.pathname.includes("/backend-api")) {
		url.pathname += "/backend-api";
	}
	return url.toString().replace(/\/+$/u, "");
}

function extractAccountId(token: string): string | undefined {
	try {
		const payload = token.split(".")[1];
		if (!payload) return undefined;
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
		if (!isRecord(claims)) return undefined;
		const auth = claims["https://api.openai.com/auth"];
		if (!isRecord(auth)) return undefined;
		const accountId = auth.chatgpt_account_id;
		return typeof accountId === "string" && accountId.length > 0 ? accountId : undefined;
	} catch {
		return undefined;
	}
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const timer = setTimeout(finish, milliseconds);
		function finish(): void {
			signal.removeEventListener("abort", abort);
			resolve();
		}
		function abort(): void {
			clearTimeout(timer);
			reject(signal.reason);
		}
		signal.addEventListener("abort", abort, { once: true });
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function compact(value: string): string {
	return value.replace(/\s+/gu, " ").trim().slice(0, 300);
}
