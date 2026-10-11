import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { emitBrowser } from "./browser.ts";
export type VoiceFeature = "dictation" | "live";
export const DEFAULT_VOICE_PROVIDER = "openai-codex";
export interface VoiceProviderInfo { provider: string; providers: Array<{ id: string; name: string }>; endpoint?: string }
export function voiceProviderPath(feature: VoiceFeature): string {
  return join(getAgentDir(), feature === "dictation" ? "pi-dictation.json" : "pi-live-provider.json");
}
export function normalizeVoiceProvider(value: unknown): string {
  if (value === "codex") return DEFAULT_VOICE_PROVIDER;
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value)) throw new Error("Choose a configured provider ID, such as openai or openai-codex.");
  return value;
}
async function stored(feature: VoiceFeature): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(voiceProviderPath(feature), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid voice provider preferences.");
    return value as Record<string, unknown>;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
}
export async function getVoiceProvider(feature: VoiceFeature): Promise<string> {
  const value = (await stored(feature)).provider;
  return value === undefined ? DEFAULT_VOICE_PROVIDER : normalizeVoiceProvider(value);
}
// Serial writes avoid lost settings and use an atomic rename; no tokens/URLs are stored here.
const writes = new Map<VoiceFeature, Promise<unknown>>();
export async function setVoiceProvider(feature: VoiceFeature, value: unknown): Promise<string> {
  const provider = normalizeVoiceProvider(value), path = voiceProviderPath(feature);
  const operation = (writes.get(feature) ?? Promise.resolve()).catch(() => {}).then(async () => {
    const previous = await stored(feature), temporary = `${path}.${crypto.randomUUID()}.tmp`;
    await mkdir(getAgentDir(), { recursive: true });
    try { await writeFile(temporary, JSON.stringify({ ...previous, provider }, null, 2) + "\n", { mode: 0o600 }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }).catch(() => {}); }
  });
  writes.set(feature, operation);
  try { await operation; return provider; } finally { if (writes.get(feature) === operation) writes.delete(feature); }
}
export function validateVoiceProvider(ctx: ExtensionContext, value: unknown): string {
  const id = normalizeVoiceProvider(value), registry = ctx.modelRegistry;
  if (!registry.getProvider(id)) throw new Error(`Provider ${id} is not configured in Pi.`);
  if (id !== DEFAULT_VOICE_PROVIDER && id !== "openai" && !registry.getAll().some(model => model.provider === id && ["openai-completions", "openai-responses", "openai-codex-responses"].includes(model.api))) throw new Error("Choose a configured OpenAI-compatible voice provider.");
  return id;
}
export async function voiceProviderInfo(ctx: ExtensionContext, feature: VoiceFeature): Promise<VoiceProviderInfo> {
  const provider = await getVoiceProvider(feature), registry = ctx.modelRegistry;
  const ids = new Set([DEFAULT_VOICE_PROVIDER, "openai", provider]);
  for (const model of registry?.getAll?.() ?? []) {
    if (["openai-completions", "openai-responses", "openai-codex-responses"].includes(model.api) && registry.hasConfiguredAuth(model)) ids.add(model.provider);
  }
  const endpoint = registry?.getProvider?.(provider)?.baseUrl;
  let publicEndpoint: string | undefined;
  if (endpoint) { try { const url = new URL(endpoint); publicEndpoint = url.origin + url.pathname; } catch {} }
  return { provider, endpoint: publicEndpoint, providers: [...ids].map(id => ({ id, name: id === DEFAULT_VOICE_PROVIDER ? "Codex OAuth" : id === "openai" ? "OpenAI · configured endpoint" : registry?.getProviderDisplayName?.(id) ?? id })) };
}
export async function configureVoiceProvider(ctx: ExtensionContext, feature: VoiceFeature, value: unknown): Promise<VoiceProviderInfo> {
  await setVoiceProvider(feature, validateVoiceProvider(ctx, value));
  const info = await voiceProviderInfo(ctx, feature);
  emitBrowser(ctx.sessionManager.getSessionId(), feature, "settings", info);
  return info;
}
