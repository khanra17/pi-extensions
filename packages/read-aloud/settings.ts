import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_SETTINGS,
	normalizeReaderSettings,
	type ReaderSettings,
} from "./reader-settings.ts";

export const EDGE_TTS_SETTINGS_PATH = join(getAgentDir(), "pi-edge-tts.json");
const OBSOLETE_EDGE_SETTINGS_PATH = join(getAgentDir(), "pi-edge-read-aloud.json");
const SHARED_PI_VOICE_SETTINGS_PATH = join(getAgentDir(), "pi-voice.json");

let writeTail = Promise.resolve();

interface SettingsCandidate {
	settings: ReaderSettings;
	modifiedAt: number;
}

/** Load the canonical settings, migrating an old filename/schema exactly once when needed. */
export async function loadEdgeTtsSettings(): Promise<ReaderSettings> {
	const canonical = await readSettingsCandidate(EDGE_TTS_SETTINGS_PATH, parseCurrentSettings);
	if (canonical) {
		await writeIfChanged(EDGE_TTS_SETTINGS_PATH, canonical.settings);
		await removeObsoletePackageSettings();
		return canonical.settings;
	}

	const migrations = (
		await Promise.all([
			readSettingsCandidate(OBSOLETE_EDGE_SETTINGS_PATH, parseCurrentSettings),
			readSettingsCandidate(SHARED_PI_VOICE_SETTINGS_PATH, parseSharedPiVoiceSettings),
		])
	)
		.filter((candidate): candidate is SettingsCandidate => candidate !== undefined)
		.sort((left, right) => right.modifiedAt - left.modifiedAt);
	const settings = migrations[0]?.settings ?? { ...DEFAULT_SETTINGS };
	if (migrations.length > 0) await writeSettingsAtomic(settings);
	await removeObsoletePackageSettings();
	return settings;
}

export function persistEdgeTtsSettings(settings: ReaderSettings): void {
	const normalized = normalizeReaderSettings(settings);
	writeTail = writeTail
		.then(() => writeSettingsAtomic(normalized))
		.catch(() => {
			// Settings are a convenience; playback should not fail when they cannot be saved.
		});
}

export async function flushEdgeTtsSettings(): Promise<void> {
	await writeTail;
}

async function readSettingsCandidate(
	path: string,
	parse: (content: string) => ReaderSettings | undefined,
): Promise<SettingsCandidate | undefined> {
	try {
		const [content, metadata] = await Promise.all([readFile(path, "utf8"), stat(path)]);
		const settings = parse(content);
		return settings ? { settings, modifiedAt: metadata.mtimeMs } : undefined;
	} catch {
		return undefined;
	}
}

function parseCurrentSettings(content: string): ReaderSettings | undefined {
	try {
		const parsed: unknown = JSON.parse(content);
		return isRecord(parsed) ? normalizeReaderSettings(parsed) : undefined;
	} catch {
		return undefined;
	}
}

function parseSharedPiVoiceSettings(content: string): ReaderSettings | undefined {
	try {
		const parsed: unknown = JSON.parse(content);
		if (!isRecord(parsed)) return undefined;
		const providerVoices = isRecord(parsed.providerVoices) ? parsed.providerVoices : undefined;
		return normalizeReaderSettings({
			...parsed,
			voice:
				typeof providerVoices?.edge === "string"
					? providerVoices.edge
					: DEFAULT_SETTINGS.voice,
		});
	} catch {
		return undefined;
	}
}

async function writeIfChanged(path: string, settings: ReaderSettings): Promise<void> {
	const expected = serializeSettings(settings);
	try {
		if ((await readFile(path, "utf8")) === expected) return;
	} catch {
		// Missing or unreadable canonical settings are replaced atomically below.
	}
	await writeSettingsAtomic(settings);
}

async function writeSettingsAtomic(settings: ReaderSettings): Promise<void> {
	await mkdir(dirname(EDGE_TTS_SETTINGS_PATH), { recursive: true });
	const temporaryPath = `${EDGE_TTS_SETTINGS_PATH}.${process.pid}.tmp`;
	try {
		await writeFile(temporaryPath, serializeSettings(settings), "utf8");
		await rename(temporaryPath, EDGE_TTS_SETTINGS_PATH);
	} finally {
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

async function removeObsoletePackageSettings(): Promise<void> {
	await rm(OBSOLETE_EDGE_SETTINGS_PATH, { force: true }).catch(() => undefined);
}

function serializeSettings(settings: ReaderSettings): string {
	return `${JSON.stringify(settings, null, 2)}\n`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
