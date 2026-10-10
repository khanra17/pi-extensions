import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Local deterministic corrections. These are not sent to OpenAI as ASR hints. */
export interface VoiceDictionary {
	replacements: Record<string, string>;
}

function agentDirectory(): string {
	const configured = process.env.PI_CODING_AGENT_DIR?.trim();
	if (!configured) return join(homedir(), ".pi", "agent");
	if (configured === "~") return homedir();
	if (configured.startsWith("~/") || configured.startsWith("~\\")) {
		return join(homedir(), configured.slice(2));
	}
	return configured;
}

export const VOICE_DICTIONARY_PATH = join(agentDirectory(), "pi-codex-voice.json");
const OBSOLETE_VOICE_DICTIONARY_PATH = join(agentDirectory(), "pi-codex-speech.json");

/** Load canonical corrections, migrating the previous filename/schema exactly once. */
export async function loadVoiceDictionary(): Promise<VoiceDictionary> {
	for (const path of [VOICE_DICTIONARY_PATH, OBSOLETE_VOICE_DICTIONARY_PATH]) {
		let content: string;
		let raw: unknown;
		try {
			content = await readFile(path, "utf8");
			raw = JSON.parse(content) as unknown;
		} catch {
			// A missing or invalid candidate is skipped; dictation still works without corrections.
			continue;
		}
		const dictionary = normalizeDictionary(raw);
		try {
			if (path !== VOICE_DICTIONARY_PATH || content !== serializeDictionary(dictionary)) {
				await saveVoiceDictionary(dictionary);
			}
			await removePreviousDictionary();
		} catch {
			// A read-only config directory must not disable dictation.
		}
		return dictionary;
	}
	return { replacements: {} };
}

export async function setVoiceReplacement(from: string, to: string): Promise<VoiceDictionary> {
	const source = from.trim();
	if (!source) throw new Error("The replacement source phrase cannot be empty.");
	const dictionary = await loadVoiceDictionary();
	dictionary.replacements[source] = to;
	await saveVoiceDictionary(dictionary);
	return dictionary;
}

export async function removeVoiceReplacement(from: string): Promise<VoiceDictionary> {
	const source = from.trim().toLocaleLowerCase();
	const dictionary = await loadVoiceDictionary();
	for (const existing of Object.keys(dictionary.replacements)) {
		if (existing.toLocaleLowerCase() === source) delete dictionary.replacements[existing];
	}
	await saveVoiceDictionary(dictionary);
	return dictionary;
}

/** Apply only explicit user-configured replacements after ASR completes. */
export function applyVoiceDictionary(text: string, dictionary: VoiceDictionary): string {
	let result = text;
	const entries = Object.entries(dictionary.replacements).sort(([left], [right]) => right.length - left.length);
	for (const [from, to] of entries) {
		if (!from) continue;
		result = result.replace(new RegExp(escapeRegExp(from), "giu"), () => to);
	}
	return result;
}

function normalizeDictionary(value: unknown): VoiceDictionary {
	const replacements: Record<string, string> = {};
	if (isRecord(value) && isRecord(value.replacements)) {
		for (const [from, to] of Object.entries(value.replacements)) {
			if (from.trim() && typeof to === "string") replacements[from.trim()] = to;
		}
	}
	return { replacements };
}

async function saveVoiceDictionary(dictionary: VoiceDictionary): Promise<void> {
	await mkdir(dirname(VOICE_DICTIONARY_PATH), { recursive: true });
	const temporary = `${VOICE_DICTIONARY_PATH}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, serializeDictionary(dictionary), "utf8");
		await rename(temporary, VOICE_DICTIONARY_PATH);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function removePreviousDictionary(): Promise<void> {
	await rm(OBSOLETE_VOICE_DICTIONARY_PATH, { force: true }).catch(() => undefined);
}

function serializeDictionary(dictionary: VoiceDictionary): string {
	return `${JSON.stringify(dictionary, null, 2)}\n`;
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
