import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import { assistantText } from "../../shared/messages.ts";
import { BrowserReadAloud } from "./browser.ts";
import { registerBrowserFeature, requestBrowser } from "../../shared/browser.ts";
import { DEFAULT_SETTINGS, EdgeReadAloudController, type ReaderSnapshot } from "./read-aloud-controller.ts";
import { EdgeReadAloudPanel, type MessageNavigation, type PanelResult } from "./read-aloud-ui.ts";
import { fetchVoices, type Voice } from "./edge-read-aloud.ts";
import { buildSessionPlaylist, type PlayableSessionMessage } from "./session-playlist.ts";
import { getTtsArgumentCompletions } from "./tts-command.ts";
import { flushEdgeTtsSettings, loadEdgeTtsSettings, persistEdgeTtsSettings } from "./settings.ts";
import { VoicePicker } from "./voice-picker.ts";
import { highlightMarkdown, WordAlignment, type WordRange } from "./highlight.ts";

const STATUS = "pi-read-aloud";

export default function readAloud(pi: ExtensionAPI): void {
	let context: ExtensionContext | undefined;
	let closeBrowser: (() => Promise<void>) | undefined;
	let browser: BrowserReadAloud | undefined;
	let tui: TUI | undefined;
	let playlist: PlayableSessionMessage[] = [];
	let selected: string | undefined;
	let voices: Voice[] | undefined;
	let catalogTask: Promise<Voice[]> | undefined;
	let catalogAbort: AbortController | undefined;
	let disposed = false;
	let queue: string[] = [];
	let pumping = false;
	let renderTimer: ReturnType<typeof setTimeout> | undefined;
	let range: WordRange | undefined;
	const alignment = new WordAlignment();
	const reader = new EdgeReadAloudController(DEFAULT_SETTINGS, {
		onSnapshot: (snapshot) => {
			if (disposed) return;
			range = alignment.range(snapshot);
			if (context?.mode === "tui") {
				context.ui.setStatus(STATUS, statusText(snapshot));
				if (tui && !renderTimer) renderTimer = setTimeout(() => {
					renderTimer = undefined;
					tui?.invalidate(); tui?.requestRender();
				}, 180);
			}
			if (!reader.isActive) void pump();
		},
		onSettingsChange: (settings) => persistEdgeTtsSettings(settings),
		onError: (message) => context?.ui.notify(message, "error"),
	});

	pi.registerMarkdownTransformer((markdown, meta) => {
		if (context?.mode !== "tui" || meta.isStreaming || (meta.messageType !== "assistant" && meta.messageType !== "user")) return markdown;
		const role = playlist.find((item) => item.id === selected)?.role ?? "assistant";
		if (meta.messageType !== role) return markdown;
		return highlightMarkdown(markdown, range, (text) => context!.ui.theme.bg("selectedBg", context!.ui.theme.fg("accent", context!.ui.theme.bold(text))));
	});

	pi.on("session_start", async (_event, ctx) => {
		context = ctx;
		reader.setSettings(await loadEdgeTtsSettings());
		await closeBrowser?.();
		if (ctx.mode === "rpc") {
			browser = new BrowserReadAloud(ctx, () => reader.settingsSnapshot, (settings) => reader.setSettings(settings));
			closeBrowser = registerBrowserFeature(ctx, "tts", browser);
		}
		refresh(ctx);
		const branch = new Set(ctx.sessionManager.getBranch().map((entry) => entry.id));
		const latest = [...playlist].reverse().find((item) => branch.has(item.id) && item.role === "assistant");
		selected = latest?.id;
		reader.setLastResponse(latest?.text ?? "");
		if (ctx.mode === "tui") ctx.ui.setWidget(STATUS, (activeTui) => {
			tui = activeTui;
			return { render: () => [], invalidate: () => {}, dispose: () => { if (tui === activeTui) tui = undefined; } };
		}, { placement: "aboveEditor" });
	});
	pi.on("message_end", (event, ctx) => {
		const text = assistantText(event.message);
		if (!text) return;
		reader.setLastResponse(text);
		if (reader.settingsSnapshot.autoPlay && ctx.mode === "tui") {
			queue.push(text); if (queue.length > 100) queue.shift(); void pump();
		}
	});
	const stop = async () => { queue = []; await reader.stop(); await browser?.dispose(); };
	pi.on("session_before_switch", stop);
	pi.on("session_before_fork", stop);
	pi.on("session_before_tree", stop);
	pi.on("session_shutdown", async (_event, ctx) => {
		disposed = true; queue = []; range = undefined;
		if (renderTimer) clearTimeout(renderTimer);
		catalogAbort?.abort();
		await closeBrowser?.(); closeBrowser = undefined; browser = undefined;
		await reader.dispose(); await flushEdgeTtsSettings();
		if (ctx.mode === "tui") { ctx.ui.setStatus(STATUS, undefined); ctx.ui.setWidget(STATUS, undefined); }
		context = undefined; tui = undefined;
	});

	pi.registerCommand("tts", {
		description: "Read existing chat messages with Edge voices",
		getArgumentCompletions: (prefix) => getTtsArgumentCompletions(prefix, reader.settingsSnapshot.voice, voices),
		handler: async (args, ctx) => {
			if (ctx.mode === "rpc") { const [action = "controls", ...parts] = args.trim().split(/\s+/u); requestBrowser(ctx, "tts", action || "controls", parts.join(" ")); return; }
			if (ctx.mode !== "tui") { ctx.ui.notify("Read-aloud requires a terminal or the voice-enabled Pi Web integration.", "warning"); return; }
			const [action = "", ...parts] = args.trim().split(/\s+/u);
			const value = parts.join(" ");
			switch (action.toLowerCase()) {
				case "": await panel(ctx); break;
				case "play": queue = []; refresh(ctx); void reader.play(playlist.find((item) => item.id === selected)?.text || reader.lastResponse); break;
				case "previous": adjacent(ctx, -1); break;
				case "next": adjacent(ctx, 1); break;
				case "pause": if (reader.isActive) reader.togglePause(); break;
				case "resume": if (reader.snapshot.status === "paused") reader.togglePause(); break;
				case "stop": queue = []; await reader.stop(); break;
				case "replay": queue = []; reader.replay(); break;
				case "mute": reader.toggleMute(); break;
				case "voice": if (value) reader.setVoice(voices?.find((voice) => [voice.code, voice.name, voice.friendlyName].some((name) => name.toLowerCase() === value.toLowerCase()))?.code ?? value); else await chooseVoice(ctx); break;
				case "speed": if (value && Number.isFinite(Number(value))) reader.setSpeed(Number(value)); else ctx.ui.notify(`Speed ${reader.settingsSnapshot.speed}x · /tts speed 1.25`, "info"); break;
				case "volume": if (value && Number.isFinite(Number(value))) reader.setVolume(Number(value)); else ctx.ui.notify(`Volume ${reader.settingsSnapshot.volume}% · /tts volume 75`, "info"); break;
				case "auto": toggleSetting("auto", value, ctx); break;
				case "code": toggleSetting("code", value, ctx); break;
				case "highlight": toggleSetting("highlight", value, ctx); break;
				default: ctx.ui.notify("/tts [play|pause|resume|stop|previous|next|replay|voice|speed|volume|mute|auto|code|highlight|help] · Ctrl+Alt+V opens the player. Auto-read includes working updates and final replies, never thinking or tools.", "info");
			}
		},
	});
	pi.registerShortcut("ctrl+alt+v", { description: "Open read-aloud controls", handler: async (ctx) => { if (ctx.mode === "tui") await panel(ctx); } });

	async function pump(): Promise<void> {
		if (disposed || pumping || reader.isActive || !queue.length || !reader.settingsSnapshot.autoPlay) return;
		pumping = true;
		selected = undefined;
		try { await reader.play(queue.shift()!); }
		finally { pumping = false; if (!disposed && !reader.isActive && queue.length) setImmediate(() => { void pump(); }); }
	}
	function refresh(ctx: ExtensionContext): void { playlist = buildSessionPlaylist(ctx.sessionManager.getTree()); }
	function adjacent(ctx: ExtensionContext, direction: -1 | 1): void {
		queue = []; refresh(ctx);
		const current = playlist.findIndex((item) => item.id === selected);
		const item = playlist[current < 0 ? (direction === -1 ? playlist.length - 1 : 0) : current + direction];
		if (!item) { ctx.ui.notify("No more readable messages in that direction.", "info"); return; }
		selected = item.id; void reader.play(item.text);
	}
	async function panel(ctx: ExtensionContext): Promise<void> {
		refresh(ctx);
		let handle: { isFocused(): boolean } | undefined;
		const navigation: MessageNavigation = {
			getState: () => { const index = playlist.findIndex((item) => item.id === selected); return { index: index + 1, total: playlist.length, role: playlist[index]?.role, phase: playlist[index]?.phase }; },
			previous: () => adjacent(ctx, -1), next: () => adjacent(ctx, 1),
		};
		const result = await ctx.ui.custom<PanelResult>((panelTui, theme, _keys, done) => new EdgeReadAloudPanel(panelTui, theme, reader, done, navigation, () => handle?.isFocused() ?? false, () => { queue = []; }), {
			overlay: true, onHandle: (value) => { handle = value; },
			overlayOptions: { anchor: "bottom-center", width: 80, minWidth: 48, maxHeight: "82%", margin: 1 },
		});
		if (result === "voice") await chooseVoice(ctx);
	}
	async function chooseVoice(ctx: ExtensionContext): Promise<void> {
		try {
			if (!voices) {
				if (!catalogTask) {
					const abort = catalogAbort = new AbortController();
					catalogTask = fetchVoices(AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)])).then((value) => voices = value);
				}
				try { voices = await catalogTask; } finally { catalogTask = undefined; }
			}
			if (disposed || !voices.length) return;
			const voice = await ctx.ui.custom<Voice | undefined>((voiceTui, theme, keybindings, done) => new VoicePicker({ voices: voices!, currentVoice: reader.settingsSnapshot.voice, theme, keybindings, requestRender: () => voiceTui.requestRender(), onSelect: done }), {
				overlay: true, overlayOptions: { anchor: "center", width: "72%", minWidth: 48, maxHeight: "88%", margin: 1 },
			});
			if (voice) reader.setVoice(voice.code);
		} catch (error) { ctx.ui.notify(`Voice list unavailable: ${error instanceof Error ? error.message : error}`, "warning"); }
	}
	function toggleSetting(key: "auto" | "code" | "highlight", value: string, ctx: ExtensionContext): void {
		if (!["", "toggle", "on", "off"].includes(value)) { ctx.ui.notify(`/tts ${key} on|off|toggle`, "warning"); return; }
		const settings = reader.settingsSnapshot;
		const current = key === "auto" ? settings.autoPlay : key === "code" ? settings.readCode : settings.highlightEnabled;
		const next = value === "on" ? true : value === "off" ? false : !current;
		if (key === "auto") { reader.setAutoPlay(next); if (!next) queue = []; }
		else if (key === "highlight") reader.setHighlightEnabled(next);
		else if (next !== current) reader.toggleReadCode();
		ctx.ui.notify(`${key} ${next ? "on" : "off"}`, "info");
	}
}

function statusText(snapshot: ReaderSnapshot): string | undefined {
	return snapshot.status === "idle" ? undefined : `TTS · ${snapshot.status} · ${Math.round(snapshot.overallProgress * 100)}% · ${snapshot.speed.toFixed(1)}×`;
}
