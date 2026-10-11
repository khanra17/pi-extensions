import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";

export interface Voice {
	/** Edge voice identifier in `locale, Name` form. */
	code: string;
	locale: string;
	name: string;
	friendlyName: string;
	gender?: string;
}

export interface SpeechBoundary {
	offsetSeconds: number;
	durationSeconds: number;
	text: string;
}

const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WSS_URL = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const VOICE_LIST_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TRUSTED_CLIENT_TOKEN}`;
const CHROMIUM_VERSION = "143.0.3650.75";
const CHROMIUM_MAJOR_VERSION = "143";
const MAX_TEXT_BYTES = 4096;
// Split only oversized sentences to respect Edge's per-turn XML byte limit.
const TARGET_TEXT_BYTES = 3600;
const PLAYBACK_OUTPUT_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
const EDGE_ORIGIN = "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold";
const SYNTHESIS_TIMEOUT_MS = 30_000;
/** Start the first sentence alone, then prepare the next five. */
const SYNTHESIS_CONCURRENCY = 5;
const PUNCTUATION_MARKS = [
	"\n",
	".",
	"!",
	"?",
	",",
	"。",
	"！",
	"？",
	"，",
	"、",
	"；",
	"：",
	"…",
].map((mark) => Buffer.from(mark, "utf8"));

export const DEFAULT_VOICE = "en-US, AvaNeural";

export interface SynthesisChunk {
	index: number;
	total: number;
	text: string;
	audio: Uint8Array;
	boundaries: SpeechBoundary[];
}

export interface SynthesisOptions {
	text: string;
	voice: string;
	signal?: AbortSignal;
	onPlan?: (chunks: readonly string[]) => void;
	/** Gate synthesis on the playback window; abort also releases pending gates. */
	beforeChunk?: (index: number, signal: AbortSignal) => Promise<void>;
	onChunk: (chunk: SynthesisChunk) => Promise<void> | void;
	/** Injectable service boundary for deterministic scheduling tests. */
	synthesizePart?: typeof synthesizePart;
}

export async function fetchVoices(signal?: AbortSignal): Promise<Voice[]> {
	const response = await fetch(VOICE_LIST_URL, { signal });
	if (!response.ok) {
		throw new Error(`Voice list request failed (${response.status})`);
	}

	const payload: unknown = await response.json();
	if (!Array.isArray(payload)) return [];

	const voices: Voice[] = [];
	for (const item of payload) {
		if (!isRecord(item)) continue;
		const shortName = typeof item.ShortName === "string" ? item.ShortName : "";
		const nameField = typeof item.Name === "string" ? item.Name : "";
		const nameMatch = nameField.match(/\(([^,]+),\s*([^)]+)\)/);
		const locale =
			(typeof item.Locale === "string" ? item.Locale : "") ||
			nameMatch?.[1] ||
			"";
		const prefix = locale ? `${locale}-` : "";
		const name =
			(prefix && shortName.startsWith(prefix)
				? shortName.slice(prefix.length)
				: "") ||
			nameMatch?.[2] ||
			"";
		if (!locale || !name) continue;

		voices.push({
			code: `${locale}, ${name}`,
			locale,
			name,
			friendlyName:
				typeof item.FriendlyName === "string"
					? item.FriendlyName
					: `${name} (${locale})`,
			gender: typeof item.Gender === "string" ? item.Gender : undefined,
		});
	}

	return voices.sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));
}

export function prepareSpeechText(text: string, readCode: boolean): string {
	let result = text.replaceAll("\r", "");

	if (readCode) {
		result = result.replace(/```(?:[^\n`]*)\n?([\s\S]*?)```/g, "$1");
	} else {
		result = result.replace(
			/```(?:[^\n`]*)\n?[\s\S]*?```/g,
			" Code block omitted. ",
		);
	}

	result = result
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
		.replace(/https?:\/\/\S+/g, "link")
		.replace(/^\s{0,3}#{1,6}\s*/gm, "")
		.replace(/^\s*>\s?/gm, "")
		.replace(/^\s*[-*+]\s+/gm, "")
		.replace(/^\s*\d+[.)]\s+/gm, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/__([^_]+)__/g, "$1")
		.replace(/~~([^~]+)~~/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/[ \t]+/g, " ")
		.replace(/[ \t]*\n[ \t]*/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return result;
}

export async function synthesizeChunks(
	options: SynthesisOptions,
): Promise<void> {
	const parts = planSpeechSentences(options.text).map(escapeXml);
	if (parts.length === 0) throw new Error("Text is empty");
	options.onPlan?.(parts.map(decodeXml));

	// Edge's turn protocol is serial on a single socket. Use a small pool of
	// independent sockets so the next parts are ready while the current part is
	// being decoded and played. Results are still delivered in source order.
	const cancellation = new AbortController();
	const propagateAbort = () => cancellation.abort();
	if (options.signal?.aborted) throw new Error("Stopped");
	options.signal?.addEventListener("abort", propagateAbort, { once: true });

	let nextPart = 0;
	let nextToEmit = 0;
	let failure: unknown;
	const ready = new Array<boolean>(parts.length).fill(false);
	const results: Array<SynthesisChunk | undefined> = new Array(parts.length);
	const capacityWaiters = new Set<() => void>();
	let emitTail = Promise.resolve();

	const wakeCapacityWaiters = (): void => {
		for (const wake of capacityWaiters) wake();
		capacityWaiters.clear();
	};

	const waitForCapacity = async (): Promise<void> => {
		while (nextPart - nextToEmit >= SYNTHESIS_CONCURRENCY) {
			if (cancellation.signal.aborted) throw new Error("Stopped");
			await new Promise<void>((resolve) => {
				const wake = (): void => {
					capacityWaiters.delete(wake);
					resolve();
				};
				capacityWaiters.add(wake);
				if (cancellation.signal.aborted) wake();
			});
		}
	};

	const abortAll = (error?: unknown): void => {
		if (
			error !== undefined &&
			(failure === undefined || isStoppedError(failure))
		)
			failure = error;
		cancellation.abort();
		wakeCapacityWaiters();
	};

	const publishReady = (): Promise<void> => {
		const operation = emitTail.then(async () => {
			if (failure !== undefined) throw toError(failure);
			while (ready[nextToEmit]) {
				const emittedIndex = nextToEmit;
				ready[emittedIndex] = false;
				const chunk = results[emittedIndex];
				results[emittedIndex] = undefined;
				if (chunk) await options.onChunk(chunk);
				nextToEmit = emittedIndex + 1;
				wakeCapacityWaiters();
			}
		});
		emitTail = operation.catch((error: unknown) => abortAll(error));
		return operation;
	};

	const worker = async (): Promise<void> => {
		try {
			while (true) {
				await waitForCapacity();
				if (cancellation.signal.aborted) throw new Error("Stopped");
				const index = nextPart++;
				if (index >= parts.length) return;
				await options.beforeChunk?.(index, cancellation.signal);
				const chunk = await (options.synthesizePart ?? synthesizePart)(
					parts[index] ?? "",
					index,
					parts.length,
					options.voice,
					cancellation.signal,
				);
				if (!chunk) throw new Error(`Edge Read Aloud returned no audio for sentence ${index + 1}.`);
				results[index] = chunk;
				ready[index] = true;
				await publishReady();
			}
		} catch (error) {
			abortAll(error);
			throw error;
		}
	};

	try {
		// Never put the first audible sentence behind look-ahead work.
		await options.beforeChunk?.(0, cancellation.signal);
		const first = await (options.synthesizePart ?? synthesizePart)(parts[0]!, 0, parts.length, options.voice, cancellation.signal);
		if (cancellation.signal.aborted) throw new Error("Stopped");
		if (!first) throw new Error("Edge Read Aloud returned no audio for the first sentence.");
		await options.onChunk(first);
		nextPart = nextToEmit = 1;
		const workerCount = Math.min(SYNTHESIS_CONCURRENCY, parts.length - 1);
		const workers = Array.from({ length: workerCount }, () => worker());
		const settled = await Promise.allSettled(workers);
		await emitTail.catch((error: unknown) => abortAll(error));
		if (failure !== undefined) throw toError(failure);
		const rejected = settled.find(
			(result): result is PromiseRejectedResult => result.status === "rejected",
		);
		if (rejected) throw toError(rejected.reason);
	} finally {
		options.signal?.removeEventListener("abort", propagateAbort);
		cancellation.abort();
		wakeCapacityWaiters();
	}
}

async function synthesizePart(
	part: string,
	index: number,
	total: number,
	voice: string,
	signal: AbortSignal,
): Promise<SynthesisChunk | undefined> {
	if (signal.aborted) throw new Error("Stopped");
	const connectionId = compactUuid();
	const url = `${WSS_URL}&Sec-MS-GEC=${generateSecMsGec()}&Sec-MS-GEC-Version=1-${CHROMIUM_VERSION}&ConnectionId=${connectionId}`;
	const socket = new WebSocket(url, {
		handshakeTimeout: SYNTHESIS_TIMEOUT_MS,
		headers: {
			Pragma: "no-cache",
			"Cache-Control": "no-cache",
			Origin: EDGE_ORIGIN,
			"Accept-Encoding": "gzip, deflate, br, zstd",
			"Accept-Language": "en-US,en;q=0.9",
			"User-Agent": userAgent(),
			Cookie: `muid=${connectionId.toUpperCase()};`,
		},
	});

	return new Promise<SynthesisChunk | undefined>((resolve, reject) => {
		let settled = false;
		let downloading = false;
		let audioParts: Buffer[] = [];
		let boundaries: SpeechBoundary[] = [];
		let abortHandler: (() => void) | undefined;
		let watchdog: ReturnType<typeof setTimeout> | undefined;

		const finish = (error?: Error, chunk?: SynthesisChunk): void => {
			if (settled) return;
			settled = true;
			if (watchdog) clearTimeout(watchdog);
			if (abortHandler) signal.removeEventListener("abort", abortHandler);
			if (
				socket.readyState === WebSocket.OPEN ||
				socket.readyState === WebSocket.CONNECTING
			)
				socket.terminate();
			if (error) reject(error);
			else resolve(chunk);
		};

		const fail = (error: unknown): void => {
			if (settled) return;
			finish(error instanceof Error ? error : new Error(String(error)));
		};
		const resetWatchdog = (): void => {
			if (watchdog) clearTimeout(watchdog);
			watchdog = setTimeout(
				() => fail(new Error("Edge TTS timed out while waiting for audio")),
				SYNTHESIS_TIMEOUT_MS,
			);
		};
		const abortHandlerImpl = (): void => fail(new Error("Stopped"));
		abortHandler = abortHandlerImpl;
		signal.addEventListener("abort", abortHandler, { once: true });

		resetWatchdog();
		socket.once("open", () => {
			try {
				if (signal.aborted) throw new Error("Stopped");
				sendTextPart(socket, part, voice);
			} catch (error) {
				fail(error);
			}
		});
		socket.once("error", fail);
		socket.once("close", () => {
			if (!settled)
				fail(new Error("Edge TTS connection closed before synthesis finished"));
		});
		socket.on("message", (data: RawData, isBinary: boolean) => {
			if (settled) return;
			try {
				if (signal.aborted) throw new Error("Stopped");
				resetWatchdog();
				if (isBinary) {
					if (!downloading)
						throw new Error("Received audio outside a synthesis turn");
					const payload = rawDataToBuffer(data);
					if (payload.length < 2)
						throw new Error("Audio message is missing its header");
					const headerLength = ((payload[0] ?? 0) << 8) | (payload[1] ?? 0);
					if (payload.length < headerLength + 2)
						throw new Error("Audio message is incomplete");
					const audio = payload.subarray(headerLength + 2);
					if (audio.length > 0) audioParts.push(Buffer.from(audio));
					return;
				}

				const message = rawDataToBuffer(data).toString("utf8");
				const { headers, body } = parseMessage(message);
				switch (headers.get("path")) {
					case "turn.start":
						downloading = true;
						break;
					case "turn.end": {
						downloading = false;
						const audio = trimTrailingZeros(Buffer.concat(audioParts));
						const chunk =
							audio.length > 0
								? {
										index,
										total,
										text: decodeXml(part),
										audio,
										boundaries,
									}
								: undefined;
						finish(undefined, chunk);
						break;
					}
					case "audio.metadata":
						boundaries.push(...parseSpeechBoundaries(body));
						break;
					case "response":
						break;
					default:
						throw new Error(
							`Unrecognized Edge TTS response (${headers.get("path") ?? "unknown"})`,
						);
				}
			} catch (error) {
				fail(error);
			}
		});
		if (signal.aborted) fail(new Error("Stopped"));
	});
}

function sendTextPart(socket: WebSocket, text: string, voice: string): void {
	const date = dateToString();
	const locale = voice.split(",", 1)[0]?.trim() || "en-US";
	const config =
		`X-Timestamp:${date}\r\n` +
		"Content-Type:application/json; charset=utf-8\r\n" +
		"Path:speech.config\r\n\r\n" +
		`{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"${PLAYBACK_OUTPUT_FORMAT}"}}}}\r\n`;
	socket.send(config);

	const ssml =
		`X-RequestId:${compactUuid()}\r\n` +
		"Content-Type:application/ssml+xml\r\n" +
		`X-Timestamp:${date}Z\r\n` +
		"Path:ssml\r\n\r\n" +
		`<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='${escapeXml(locale)}'><voice name='Microsoft Server Speech Text to Speech Voice (${escapeXml(voice)})'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${text}</prosody></voice></speak>`;
	socket.send(ssml);
}

function parseMessage(message: string): {
	headers: Map<string, string>;
	body: string;
} {
	const separator = message.indexOf("\r\n\r\n");
	const headerText = separator >= 0 ? message.slice(0, separator) : message;
	const body = separator >= 0 ? message.slice(separator + 4) : "";
	const headers = new Map<string, string>();
	for (const line of headerText.split("\r\n")) {
		const colon = line.indexOf(":");
		if (colon > 0)
			headers.set(
				line.slice(0, colon).trim().toLowerCase(),
				line.slice(colon + 1).trim(),
			);
	}
	return { headers, body };
}

function parseSpeechBoundaries(body: string): SpeechBoundary[] {
	if (!body.trim()) return [];
	let payload: unknown;
	try {
		payload = JSON.parse(body);
	} catch {
		return [];
	}
	if (!isRecord(payload) || !Array.isArray(payload.Metadata)) return [];

	const result: SpeechBoundary[] = [];
	for (const item of payload.Metadata) {
		if (!isRecord(item) || item.Type !== "WordBoundary") continue;
		const data = item.Data;
		if (!isRecord(data)) continue;
		const textData = data.text;
		if (!isRecord(textData) || typeof textData.Text !== "string") continue;
		if (typeof data.Offset !== "number" || typeof data.Duration !== "number")
			continue;
		result.push({
			offsetSeconds: Math.max(0, data.Offset / 10_000_000),
			durationSeconds: Math.max(0, data.Duration / 10_000_000),
			text: decodeXml(textData.Text),
		});
	}
	return result;
}

function rawDataToBuffer(data: RawData): Buffer {
	if (Array.isArray(data))
		return Buffer.concat(data.map((part) => Buffer.from(part)));
	if (data instanceof ArrayBuffer) return Buffer.from(data);
	return Buffer.from(data);
}

function removeIncompatibleCharacters(text: string): string {
	return [...text]
		.map((character) => {
			const code = character.codePointAt(0) ?? 32;
			return code <= 8 ||
				(code >= 11 && code <= 12) ||
				(code >= 14 && code <= 31)
				? " "
				: character;
		})
		.join("");
}

function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function decodeXml(text: string): string {
	return text
		.replaceAll("&apos;", "'")
		.replaceAll("&quot;", '"')
		.replaceAll("&gt;", ">")
		.replaceAll("&lt;", "<")
		.replaceAll("&amp;", "&");
}

/** Sentence boundaries include Unicode punctuation and do not split decimals. */
export function planSpeechSentences(text: string): string[] {
	const parts: string[] = [];
	const clean = removeIncompatibleCharacters(text);
	for (const { segment } of new Intl.Segmenter(undefined, { granularity: "sentence" }).segment(clean)) {
		parts.push(...splitOversizedSentence(escapeXml(segment)).map(decodeXml));
	}
	return parts;
}

function splitOversizedSentence(text: string): string[] {
	let remaining = Buffer.from(text, "utf8");
	const parts: string[] = [];
	const safeMaximum = Math.min(TARGET_TEXT_BYTES, MAX_TEXT_BYTES);
	const limit = safeMaximum;

	while (remaining.length > 0) {
		if (remaining.length <= limit) {
			pushTrimmed(parts, remaining);
			break;
		}

		let splitAt =
			findLastPunctuation(remaining, limit) ??
			findFirstPunctuation(remaining, limit, safeMaximum) ??
			safeUtf8Split(remaining, Math.min(safeMaximum, remaining.length));
		splitAt = adjustXmlEntity(remaining, splitAt);
		if (splitAt === 0)
			splitAt = safeUtf8Split(remaining, Math.min(limit, remaining.length));

		pushTrimmed(parts, remaining.subarray(0, splitAt));
		remaining = remaining.subarray(splitAt);
	}

	return parts;
}

function punctuationMarks(): readonly Buffer[] {
	return PUNCTUATION_MARKS;
}

function findLastPunctuation(text: Buffer, limit: number): number | undefined {
	const safeLimit = Math.min(limit, text.length);
	let result: number | undefined;
	for (const mark of punctuationMarks()) {
		const position = text.subarray(0, safeLimit).lastIndexOf(mark);
		if (position >= 0) result = Math.max(result ?? 0, position + mark.length);
	}
	return result;
}

function findFirstPunctuation(
	text: Buffer,
	start: number,
	hardLimit: number,
): number | undefined {
	const safeStart = Math.min(start, text.length);
	const safeLimit = Math.min(hardLimit, text.length);
	let result: number | undefined;
	for (const mark of punctuationMarks()) {
		const position = text.subarray(safeStart, safeLimit).indexOf(mark);
		if (position >= 0) {
			const absolute = safeStart + position + mark.length;
			result = Math.min(result ?? absolute, absolute);
		}
	}
	return result;
}

function safeUtf8Split(text: Buffer, limit: number): number {
	let splitAt = Math.min(limit, text.length);
	while (
		splitAt > 0 &&
		splitAt < text.length &&
		((text[splitAt] ?? 0) & 0xc0) === 0x80
	)
		splitAt -= 1;
	return splitAt;
}

function adjustXmlEntity(text: Buffer, splitAt: number): number {
	let adjusted = splitAt;
	while (adjusted > 0) {
		const ampersand = text.subarray(0, adjusted).lastIndexOf(0x26);
		if (ampersand < 0) break;
		const semicolon = text.subarray(ampersand + 1).indexOf(0x3b);
		if (semicolon >= 0 && ampersand + 1 + semicolon < adjusted) break;
		adjusted = ampersand;
	}
	return adjusted;
}

function pushTrimmed(parts: string[], bytes: Buffer): void {
	const text = bytes.toString("utf8").trim();
	if (text) parts.push(text);
}

function trimTrailingZeros(bytes: Buffer): Buffer {
	let end = bytes.length;
	while (end > 0 && bytes[end - 1] === 0) end -= 1;
	return end === bytes.length ? bytes : bytes.subarray(0, end);
}

function compactUuid(): string {
	return randomUUID().replaceAll("-", "");
}

function generateSecMsGec(): string {
	const seconds = BigInt(Math.floor(Date.now() / 1000));
	let ticks = (seconds + 11644473600n) * 10000000n;
	ticks -= ticks % 3000000000n;
	return createHash("sha256")
		.update(`${ticks}${TRUSTED_CLIENT_TOKEN}`)
		.digest("hex")
		.toUpperCase();
}

function dateToString(): string {
	const date = new Date();
	const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
	const months = [
		"Jan",
		"Feb",
		"Mar",
		"Apr",
		"May",
		"Jun",
		"Jul",
		"Aug",
		"Sep",
		"Oct",
		"Nov",
		"Dec",
	];
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${days[date.getUTCDay()]} ${months[date.getUTCMonth()]} ${pad(date.getUTCDate())} ${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} GMT+0000 (Coordinated Universal Time)`;
}

function userAgent(): string {
	return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM_MAJOR_VERSION}.0.0.0 Safari/537.36 Edg/${CHROMIUM_MAJOR_VERSION}.0.0.0`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isStoppedError(value: unknown): boolean {
	return value instanceof Error && value.message === "Stopped";
}

function toError(value: unknown): Error {
	return value instanceof Error ? value : new Error(String(value));
}
