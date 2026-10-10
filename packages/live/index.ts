import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveCodexVoiceAuth } from "../../shared/codex.ts";
import { registerBrowserFeature, requestBrowser } from "../../shared/browser.ts";
import { BrowserLive } from "./browser.ts";
import { registerLiveVoice } from "./registration.ts";
import { currentLiveEnabled, currentLiveVoice, loadLiveSettings, setLiveEnabled, setLiveVoice, LIVE_SETTINGS_PATH } from "./settings.ts";
import { isLiveVoice, LIVE_VOICE_OPTIONS } from "./voices.ts";

export default function liveVoice(pi: ExtensionAPI): void {
	let voice = currentLiveVoice();
	let enabled = currentLiveEnabled();
	let ready: Promise<void> | undefined;
	let browser: BrowserLive | undefined;
	let closeBrowser: (() => Promise<void>) | undefined;
	const prepare = () => ready ??= loadLiveSettings().then((settings) => { voice = settings.voice; enabled = settings.enabled; });
	pi.on("session_start", async (_event, ctx) => {
		await closeBrowser?.(); await prepare();
		if (ctx.mode === "rpc") { browser = new BrowserLive(pi, ctx, () => voice, () => enabled); closeBrowser = registerBrowserFeature(ctx, "live", browser); }
	});
	const stopBrowser = async () => { await browser?.dispose(); };
	pi.on("session_before_switch", stopBrowser); pi.on("session_before_fork", stopBrowser); pi.on("session_before_tree", stopBrowser);
	pi.on("session_shutdown", async () => { await closeBrowser?.(); closeBrowser = undefined; browser = undefined; });
	pi.on("message_end", (event) => browser?.message(event.message));
	pi.on("agent_settled", () => browser?.settled());
	registerLiveVoice(pi, {
		getAuth: async (ctx, signal) => {
			if (signal?.aborted) throw signal.reason;
			const auth = await resolveCodexVoiceAuth(ctx);
			if (signal?.aborted) throw signal.reason;
			return auth;
		},
		getVoice: () => voice,
		isEnabled: () => enabled,
		prepare,
		getArgumentCompletions: (prefix) => {
			const values = ["start", "stop", "status", "voice", "enabled on", "enabled off", "help"].filter((value) => value.startsWith(prefix));
			return values.length ? values.map((value) => ({ value, label: value })) : null;
		},
		handleCommand: async (args, ctx, live) => {
			await prepare();
			const [action = "", ...parts] = args.trim().toLowerCase().split(/\s+/u);
			if (ctx.mode === "rpc" && ["", "toggle", "start", "stop", "cancel"].includes(action)) {
				requestBrowser(ctx, "live", action || "toggle"); return;
			}
			switch (action) {
				case "": case "toggle": await live.toggle(ctx); break;
				case "start": if (!live.isActive()) await live.toggle(ctx); break;
				case "stop": case "cancel": await live.stop(); break;
				case "status": ctx.ui.notify(`Live voice: ${browser?.isActive() || live.isActive() ? "active" : "idle"} · ${enabled ? "enabled" : "disabled"} · ${voice}`, "info"); break;
				case "voice": {
					let value = parts.join(" ");
					if (!value && ctx.hasUI) {
						const selected = await ctx.ui.select("Live response voice", LIVE_VOICE_OPTIONS.map((option) => `${option.label} (${option.value})`));
						value = selected?.match(/\(([^)]+)\)/u)?.[1] ?? "";
					}
					if (!isLiveVoice(value)) { ctx.ui.notify(`Choose ${LIVE_VOICE_OPTIONS.map((option) => option.value).join(", ")}`, "info"); return; }
					await setLiveVoice(value); voice = value;
					ctx.ui.notify(`Live voice set to ${voice}; applies on the next connection. ${LIVE_SETTINGS_PATH}`, "info");
					break;
				}
				case "enabled": {
					const value = parts[0];
					if (value !== "on" && value !== "off") { ctx.ui.notify("/live enabled on|off", "warning"); return; }
					await setLiveEnabled(value === "on"); enabled = value === "on";
					if (!enabled) { await live.stop(); await browser?.dispose(); }
					ctx.ui.notify(`Live voice ${enabled ? "enabled" : "disabled"}.`, "info");
					break;
				}
				default: ctx.ui.notify("/live [start|stop|status|voice [name]|enabled on|off|help] · Ctrl+Shift+L toggles · Space mutes · Esc ends. Conversational voice may delegate work to Pi; it is not dictation or literal TTS.", "info");
			}
		},
	});
}
