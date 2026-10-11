import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCodexVoiceAuth, transcribeWithCodex, type CodexVoiceAuth } from "../../shared/codex.ts";
import { transcribeLocal } from "./local.ts";
export type DictationBackend = "codex" | "local";
export type DictationAuth = CodexVoiceAuth | { backend: "local" };
export async function dictationSettings(): Promise<{ backend: DictationBackend }> {
  try { const value = JSON.parse(await readFile(join(getAgentDir(), "pi-dictation.json"), "utf8")); return { backend: value.backend === "local" ? "local" : "codex" }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Cannot read pi-dictation.json.", { cause: error }); return { backend: "codex" }; }
}
export async function setDictationBackend(backend: unknown): Promise<{ backend: DictationBackend }> {
  if (backend !== "codex" && backend !== "local") throw new Error("Choose codex or local.");
  const directory = getAgentDir(); await mkdir(directory, { recursive: true });
  const path = join(directory, "pi-dictation.json"), temporary = path + "." + crypto.randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify({ backend }) + "\n", { mode: 0o600 }); await rename(temporary, path);
  return { backend };
}
export async function resolveDictationAuth(ctx: ExtensionContext): Promise<DictationAuth> {
  return (await dictationSettings()).backend === "local" ? { backend: "local" } : resolveCodexVoiceAuth(ctx);
}
export async function transcribeDictation(audio: Uint8Array, auth: DictationAuth, signal: AbortSignal, progress?: (message: string) => void): Promise<string> {
  if ("backend" in auth) return transcribeLocal(audio, signal, progress);
  return transcribeWithCodex(audio, auth, signal);
}
