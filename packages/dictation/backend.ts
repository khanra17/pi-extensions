import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveVoiceAuth, transcribeWithCodex, type CodexVoiceAuth } from "../../shared/codex.ts";
export type DictationAuth = CodexVoiceAuth;
export const resolveDictationAuth = (ctx: ExtensionContext): Promise<DictationAuth> => resolveVoiceAuth(ctx);
export const transcribeDictation = (audio: Uint8Array, auth: DictationAuth, signal: AbortSignal, _progress?: (message: string) => void): Promise<string> => transcribeWithCodex(audio, auth, signal);
