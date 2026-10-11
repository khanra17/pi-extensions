// Loaded only by the isolated browser smoke test, never by published packages.
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBrowserFeature, requestBrowser, type BrowserAdapter } from "../shared/browser.ts";
import { BrowserDictation } from "../packages/dictation/browser.ts";
import { DEFAULT_SETTINGS } from "../packages/read-aloud/reader-settings.ts";
import { BrowserReadAloud } from "../packages/read-aloud/browser.ts";
import { synthesizeChunks } from "../packages/read-aloud/edge-read-aloud.ts";

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
    const reader = new BrowserReadAloud(ctx, () => settings, next => { settings = next; }, options => synthesizeChunks({ ...options,
      synthesizePart: async (text, index, total) => ({ index, total, text, audio: readFileSync(process.env.PI_VOICE_TEST_MP3!), boundaries: [{ text: "Browser", offsetSeconds: 0, durationSeconds: .4 }, { text: "voice", offsetSeconds: .4, durationSeconds: .4 }, { text: "test.", offsetSeconds: .8, durationSeconds: .3 }] }) }));
    const tts: BrowserAdapter = {
      handle: async call => {
        if (call.action === "voices") return [{ code: "en-US, AvaNeural", name: "Ava", friendlyName: "Ava", locale: "en-US", gender: "Female" }];
        return reader.handle(call);
      }, isActive: () => reader.isActive(), disconnect: client => reader.disconnect(client), dispose: () => reader.dispose(),
    };
    registerBrowserFeature(ctx, "tts", tts);
    registerBrowserFeature(ctx, "live", { handle: async call => { if (call.action === "start") throw new Error("Offline fixture does not call the Live service."); return {}; }, disconnect: async () => {}, dispose: async () => {} });
  });
}
