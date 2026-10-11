/** Voice-only shortcuts; do not take browser address-bar, clipboard or IME keys. */
export const VOICE_SHORTCUTS = { dictation: "ctrl+alt+m", live: "ctrl+alt+l", tts: "ctrl+alt+v" } as const;
export const VOICE_SHORTCUT_LABELS = { dictation: "Ctrl+Alt+M", live: "Ctrl+Alt+L", tts: "Ctrl+Alt+V" } as const;
export function voiceShortcut(event: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean; getModifierState?(key: string): boolean }): keyof typeof VOICE_SHORTCUTS | undefined {
  if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey || event.getModifierState?.("AltGraph")) return;
  return ({ KeyM: "dictation", KeyL: "live", KeyV: "tts" } as const)[event.code as "KeyM" | "KeyL" | "KeyV"];
}
