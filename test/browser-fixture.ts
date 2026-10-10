// Loaded only by the isolated browser smoke test, never by published packages.
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBrowserFeature, requestBrowser, browserStream, type BrowserAdapter } from "../shared/browser.ts";
import { BrowserDictation } from "../packages/dictation/browser.ts";
import { DEFAULT_SETTINGS, normalizeReaderSettings } from "../packages/read-aloud/reader-settings.ts";

export default function fixture(pi: ExtensionAPI) {
  for (const [name, feature] of [["voice", "dictation"], ["live", "live"], ["tts", "tts"]] as const) pi.registerCommand(name, { description: "Offline voice fixture", handler: async (args, ctx) => { requestBrowser(ctx, feature, args || "toggle"); } });
  pi.on("session_start", async (_, ctx) => {
    let calls = 0;
    registerBrowserFeature(ctx, "dictation", new BrowserDictation(ctx, {
      auth: async () => ({ accessToken: "fixture", accountId: "fixture", baseUrl: "https://invalid.example" }),
      dictionary: async () => ({ replacements: {} }),
      transcribe: async () => ++calls % 2 === 1 ? "spoken preview" : "spoken final",
    }));
    let settings = { ...DEFAULT_SETTINGS };
    const tts: BrowserAdapter = {
      handle: async call => {
        if (call.action === "settings") return settings;
        if (call.action === "configure") return settings = normalizeReaderSettings({ ...settings, ...call.body });
        if (call.action === "voices") return [{ code: "en-US, AvaNeural", name: "Ava", friendlyName: "Ava", locale: "en-US", gender: "Female" }];
        if (call.action === "stop") return {};
        if (call.action === "speak") return browserStream(async emit => { await emit({ index: 0, total: 1, text: "Browser voice test.", audio: readFileSync(process.env.PI_VOICE_TEST_MP3!).toString("base64"), boundaries: [{ text: "Browser", offsetSeconds: 0, durationSeconds: .4 }, { text: "voice", offsetSeconds: .4, durationSeconds: .4 }, { text: "test.", offsetSeconds: .8, durationSeconds: .3 }] }); }, call.signal);
        throw new Error("Unknown fixture action");
      }, disconnect: async () => {}, dispose: async () => {},
    };
    registerBrowserFeature(ctx, "tts", tts);
    registerBrowserFeature(ctx, "live", { handle: async call => { if (call.action === "start") throw new Error("Offline fixture does not call the Live service."); return {}; }, disconnect: async () => {}, dispose: async () => {} });
  });
}
