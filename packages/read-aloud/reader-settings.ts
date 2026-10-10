export interface ReaderSettings {
	voice: string;
	speed: number;
	volume: number;
	muted: boolean;
	autoPlay: boolean;
	readCode: boolean;
	highlightEnabled: boolean;
}

export const DEFAULT_SETTINGS: ReaderSettings = {
	voice: "en-US, AvaNeural",
	speed: 1,
	volume: 100,
	muted: false,
	autoPlay: false,
	readCode: false,
	highlightEnabled: true,
};

export function normalizeReaderSettings(
	value: Record<string, unknown> | ReaderSettings,
): ReaderSettings {
	return {
		voice:
			typeof value.voice === "string" && value.voice.trim()
				? value.voice.trim()
				: DEFAULT_SETTINGS.voice,
		speed: clamp(numberOr(value.speed, DEFAULT_SETTINGS.speed), 0.5, 2),
		volume: clamp(Math.round(numberOr(value.volume, DEFAULT_SETTINGS.volume)), 0, 100),
		muted: booleanOr(value.muted, DEFAULT_SETTINGS.muted),
		autoPlay: booleanOr(value.autoPlay, DEFAULT_SETTINGS.autoPlay),
		readCode: booleanOr(value.readCode, DEFAULT_SETTINGS.readCode),
		highlightEnabled: booleanOr(
			value.highlightEnabled,
			DEFAULT_SETTINGS.highlightEnabled,
		),
	};
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanOr(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}
