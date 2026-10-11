import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveVoiceAuth, transcribeWithCodex, type CodexVoiceAuth } from "../../shared/codex.ts";
import { getVoiceProvider } from "../../shared/voice-provider.ts";
export type DictationAuth = CodexVoiceAuth;
export const resolveDictationAuth = async (ctx: ExtensionContext): Promise<DictationAuth> => resolveVoiceAuth(ctx, await getVoiceProvider("dictation"));
export const transcribeDictation = (audio: Uint8Array, auth: DictationAuth, signal: AbortSignal, _progress?: (message: string) => void): Promise<string> => transcribeWithCodex(audio, auth, signal);
