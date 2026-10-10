import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_LIVE_VOICE, isLiveVoice, type LiveVoice } from "./voices.ts";

export interface LiveSettings {
	voice: LiveVoice;
	enabled: boolean;
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

export const LIVE_SETTINGS_PATH = join(agentDirectory(), "pi-codex-voice-live.json");
const OBSOLETE_SPEECH_SETTINGS_PATH = join(agentDirectory(), "pi-codex-speech-live.json");
const OBSOLETE_LIVE_SETTINGS_PATH = join(agentDirectory(), "pi-codex-live.json");
const UPSTREAM_SETTINGS_PATH = join(agentDirectory(), "extensions", "pi-better-openai.json");

let cached: LiveSettings | undefined;
let loadPromise: Promise<LiveSettings> | undefined;
let writeTail = Promise.resolve();

export async function loadLiveSettings(): Promise<LiveSettings> {
	if (cached) return { ...cached };
	if (loadPromise) return loadPromise;
	loadPromise = (async () => {
		const stored = await loadOrMigrateStoredSettings();
		const envVoice = process.env.PI_CODEX_VOICE_LIVE_VOICE?.trim().toLowerCase();
		const envDisabled = process.env.PI_CODEX_VOICE_LIVE_MODE?.trim() === "0";
		cached = {
			voice: isLiveVoice(envVoice) ? envVoice : stored.voice,
			enabled: envDisabled ? false : stored.enabled,
		};
		return { ...cached };
	})();
	try {
		return await loadPromise;
	} finally {
		loadPromise = undefined;
	}
}

export async function setLiveVoice(voice: LiveVoice): Promise<LiveSettings> {
	return saveLiveSettings({ voice, enabled: cached?.enabled ?? true });
}

export async function setLiveEnabled(enabled: boolean): Promise<LiveSettings> {
	return saveLiveSettings({ voice: cached?.voice ?? DEFAULT_LIVE_VOICE, enabled });
}

async function saveLiveSettings(next: LiveSettings): Promise<LiveSettings> {
	cached = { ...next };
	const operation = writeTail.then(() => writeSettingsAtomic(next));
	writeTail = operation.catch(() => undefined);
	await operation;
	return { ...next };
}

async function loadOrMigrateStoredSettings(): Promise<LiveSettings> {
	const canonical = await readJson(LIVE_SETTINGS_PATH);
	if (canonical !== undefined) {
		const settings = normalizeSettings(canonical.value);
		try {
			if (serializeSettings(settings) !== canonical.content) await writeSettingsAtomic(settings);
			await removeObsoleteSettings();
		} catch {
			// Read-only configuration still remains usable for this process.
		}
		return settings;
	}

	const speech = await readJson(OBSOLETE_SPEECH_SETTINGS_PATH);
	const previous = speech ?? (await readJson(OBSOLETE_LIVE_SETTINGS_PATH));
	let raw = previous?.value;
	if (raw === undefined) {
		const upstream = await readJson(UPSTREAM_SETTINGS_PATH);
		raw = isRecord(upstream?.value) ? upstream.value.live : undefined;
	}
	const settings = normalizeSettings(raw);
	try {
		if (previous || raw !== undefined) await writeSettingsAtomic(settings);
		await removeObsoleteSettings();
	} catch {
		// Migration failure must not disable live mode for the current process.
	}
	return settings;
}

async function readJson(
	path: string,
): Promise<{ content: string; value: unknown } | undefined> {
	try {
		const content = await readFile(path, "utf8");
		return { content, value: JSON.parse(content) as unknown };
	} catch {
		return undefined;
	}
}

function normalizeSettings(value: unknown): LiveSettings {
	return {
		voice: isRecord(value) && isLiveVoice(value.voice) ? value.voice : DEFAULT_LIVE_VOICE,
		enabled: isRecord(value) && typeof value.enabled === "boolean" ? value.enabled : true,
	};
}

async function writeSettingsAtomic(settings: LiveSettings): Promise<void> {
	await mkdir(dirname(LIVE_SETTINGS_PATH), { recursive: true });
	const temporary = `${LIVE_SETTINGS_PATH}.${process.pid}.tmp`;
	try {
		await writeFile(temporary, serializeSettings(settings), "utf8");
		await rename(temporary, LIVE_SETTINGS_PATH);
	} finally {
		await rm(temporary, { force: true }).catch(() => undefined);
	}
}

async function removeObsoleteSettings(): Promise<void> {
	await Promise.all([
		rm(OBSOLETE_SPEECH_SETTINGS_PATH, { force: true }).catch(() => undefined),
		rm(OBSOLETE_LIVE_SETTINGS_PATH, { force: true }).catch(() => undefined),
	]);
}

function serializeSettings(settings: LiveSettings): string {
	return `${JSON.stringify(settings, null, 2)}\n`;
}

export function currentLiveVoice(): LiveVoice {
	return cached?.voice ?? DEFAULT_LIVE_VOICE;
}

export function currentLiveEnabled(): boolean {
	return cached?.enabled ?? process.env.PI_CODEX_VOICE_LIVE_MODE?.trim() !== "0";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
