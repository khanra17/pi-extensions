import type { AutocompleteItem } from "@earendil-works/pi-tui";
import type { Voice } from "./edge-read-aloud.ts";

interface TtsActionCompletion {
	name: string;
	value: string;
	description: string;
}

const ACTIONS: readonly TtsActionCompletion[] = [
	{
		name: "play",
		value: "play",
		description: "Play the selected session message",
	},
	{ name: "pause", value: "pause", description: "Pause playback" },
	{ name: "resume", value: "resume", description: "Resume playback" },
	{ name: "stop", value: "stop", description: "Stop playback" },
	{
		name: "replay",
		value: "replay",
		description: "Restart the current message",
	},
	{
		name: "previous",
		value: "previous",
		description: "Play the previous session message",
	},
	{
		name: "next",
		value: "next",
		description: "Play the next session message",
	},
	{
		name: "speed",
		value: "speed ",
		description: "Set playback speed (0.5–2.0×)",
	},
	{
		name: "volume",
		value: "volume ",
		description: "Set volume (0–100)",
	},
	{ name: "mute", value: "mute", description: "Toggle mute" },
	{
		name: "voice",
		value: "voice ",
		description: "Open the voice picker or provide a voice name",
	},
	{
		name: "auto",
		value: "auto ",
		description: "Configure automatic reading",
	},
	{
		name: "code",
		value: "code ",
		description: "Configure fenced-code reading",
	},
	{
		name: "highlight",
		value: "highlight ",
		description: "Configure word highlighting",
	},
	{ name: "help", value: "help", description: "Show command help" },
];

export function getTtsArgumentCompletions(
	argumentPrefix: string,
	currentVoice: string,
	voiceCatalog?: readonly Voice[],
): AutocompleteItem[] | null {
	const prefix = argumentPrefix.trimStart();
	if (!/\s/u.test(prefix)) {
		const query = prefix.toLowerCase();
		const matches = ACTIONS.filter((action) =>
			action.name.startsWith(query),
		).map((action) => ({
			value: action.value,
			label: action.name,
			description: action.description,
		}));
		return matches.length > 0 ? matches : null;
	}

	const [action = ""] = prefix.split(/\s+/u);
	const valuePrefix = prefix.slice(action.length).trimStart();
	switch (action.toLowerCase()) {
		case "auto":
		case "code":
		case "highlight":
			return completeValues(action.toLowerCase(), valuePrefix, [
				["on", "Enable"],
				["off", "Disable"],
				["toggle", "Toggle current value"],
			]);
		case "speed":
			return completeValues("speed", valuePrefix, [
				["0.5", "0.5×"],
				["0.75", "0.75×"],
				["1", "Normal speed"],
				["1.25", "1.25×"],
				["1.5", "1.5×"],
				["1.75", "1.75×"],
				["2", "2×"],
			]);
		case "volume":
			return completeValues("volume", valuePrefix, [
				["0", "Silent"],
				["25", "25%"],
				["50", "50%"],
				["75", "75%"],
				["100", "100%"],
			]);
		case "voice":
			return completeVoices(valuePrefix, currentVoice, voiceCatalog);
		default:
			return null;
	}
}

function completeValues(
	action: string,
	valuePrefix: string,
	values: ReadonlyArray<readonly [value: string, description: string]>,
): AutocompleteItem[] | null {
	const query = valuePrefix.toLowerCase();
	const matches = values
		.filter(([value]) => value.toLowerCase().startsWith(query))
		.map(([value, description]) => ({
			value: `${action} ${value}`,
			label: value,
			description,
		}));
	return matches.length > 0 ? matches : null;
}

function completeVoices(
	valuePrefix: string,
	currentVoice: string,
	voiceCatalog: readonly Voice[] = [],
): AutocompleteItem[] | null {
	const query = valuePrefix.toLowerCase();
	const matches = voiceCatalog
		.filter((voice) =>
			`${voice.code} ${voice.name} ${voice.friendlyName} ${voice.locale}`
				.toLowerCase()
				.includes(query),
		)
		.slice(0, 40)
		.map((voice) => ({
			value: `voice ${voice.code}`,
			label: `${voice.name} · ${voice.locale}`,
			description: voice.friendlyName,
		}));
	if (matches.length > 0) return matches;
	if (!query || currentVoice.toLowerCase().includes(query)) {
		return [
			{
				value: `voice ${currentVoice}`,
				label: currentVoice,
				description: "Current voice; run /tts voice to open the full picker",
			},
		];
	}
	return null;
}
