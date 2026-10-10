import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const hostFiles = ["components/ChatInput.tsx", "components/ChatWindow.tsx", "hooks/useAgentSession.ts", "components/MessageView.tsx"];
function replace(source, before, after, count = 1) {
  const found = source.split(before).length - 1;
  if (found !== count) throw new Error(`Pi Web compatibility check failed at ${before.slice(0, 70)}: expected ${count} anchor(s), found ${found}. Nothing was installed. Update integration/pi-web/adapter.mjs for the new host version.`);
  return source.split(before).join(after);
}
/** Only this adapter knows upstream component names. Features use the versioned host contract. */
export function adaptSources(files) {
  const result = { ...files };
  let input = files[hostFiles[0]];
  input = replace(input, 'import { SelectorRow } from "./SelectorRow";', 'import { SelectorRow } from "./SelectorRow";\nimport { VoiceControls, type VoiceHost } from "./pi-voice/VoiceControls";\nimport { joinAtCursor } from "@/lib/pi-voice-composer";');
  input = replace(input, '  onAttachFiles?: (files: File[]) => void;\n}', '  onAttachFiles?: (files: File[]) => void;\n  voiceHost?: VoiceHost;\n}');
  input = replace(input, '  onAttachFiles,\n  compact = false,', '  onAttachFiles,\n  voiceHost,\n  compact = false,');
  input = replace(input, '  valueRef.current = value;\n  attachedImagesRef.current = attachedImages;', `  valueRef.current = value;
  attachedImagesRef.current = attachedImages;
  const [voiceBusy, setVoiceBusy] = useState(false);
  const voiceBusyRef = useRef(false);
  const setVoiceBusySafe = useCallback((busy: boolean) => { voiceBusyRef.current = busy; setVoiceBusy(busy); }, []);
  const voiceComposer = {
    getText: () => textareaRef.current?.value ?? valueRef.current,
    getCursorOffset: () => textareaRef.current?.selectionStart ?? valueRef.current.length,
    setText: (text: string) => { valueRef.current = text; setValue(text); },
    insertText: (text: string) => {
      const current = textareaRef.current?.value ?? valueRef.current;
      const at = textareaRef.current?.selectionStart ?? current.length;
      const next = joinAtCursor(current.slice(0, at), text, current.slice(at));
      valueRef.current = next; setValue(next);
    },
  };`);
  input = replace(input, '  const handleSend = useCallback(async () => {\n', '  const handleSend = useCallback(async () => {\n    if (voiceBusyRef.current) return;\n');
  input = replace(input, '  const sendQueued = useCallback((mode: "steer" | "followup") => {\n', '  const sendQueued = useCallback((mode: "steer" | "followup") => {\n    if (voiceBusyRef.current) return;\n');
  input = replace(input, 'disabled={!canQueueStreamingMessage}', 'disabled={voiceBusy || !canQueueStreamingMessage}', 2);
  input = replace(input, 'disabled={!value.trim() && !attachedImages.length}', 'disabled={voiceBusy || (!value.trim() && !attachedImages.length)}');
  input = replace(input, '            {isMobile && (\n              <button\n                type="button"\n                 title={controlsMenuOpen ? undefined : t("chat.moreControls")}', `            {voiceHost && <VoiceControls host={voiceHost} composer={voiceComposer} setBusy={setVoiceBusySafe} />}
            {isMobile && (
              <button
                type="button"
                 title={controlsMenuOpen ? undefined : t("chat.moreControls")}`);
  result[hostFiles[0]] = input;
  let window = files[hostFiles[1]];
  window = replace(window, '    loadContext, activeLeafId, scrollToBottom, scrollToMessage,', '    loadContext, activeLeafId, scrollToBottom, scrollToMessage, ensureVoiceSession,');
  window = replace(window, '      onAttachFiles={onAttachFiles}\n    />', `      onAttachFiles={onAttachFiles}
      voiceHost={{
        version: 1, key: session?.id ?? newSessionDraftKey ?? "new", isNew: !session,
        sessionId: session?.id ?? sessionIdRef.current, ensureSession: ensureVoiceSession,
        messages, entryIds,
        textElements: (id) => {
          const node = messageContentRef.current?.querySelector('[data-entry-id="' + CSS.escape(id) + '"]');
          return Array.from(node?.querySelectorAll<HTMLElement>("[data-pi-voice-text]") ?? []);
        },
      }}
    />`);
  result[hostFiles[1]] = window;
  let hook = files[hostFiles[2]];
  hook = replace(hook, '    // Actions\n    handleSend,', `    // Actions
    ensureVoiceSession: async () => {
      const sid = sessionIdRef.current ?? await ensureNewSession();
      if (sid) await ensureEventsConnected(sid);
      return sid;
    },
    handleSend,`);
  result[hostFiles[2]] = hook;
  let view = files[hostFiles[3]];
  view = replace(view, '  return <SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>;', '  return <div data-pi-voice-text style={{ display: "contents" }}><SafeMarkdownBody isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody></div>;');
  result[hostFiles[3]] = view;
  return result;
}
export function applyAdapter(upstream, kit) {
  const files = Object.fromEntries(hostFiles.map(path => [path, readFileSync(join(upstream, path), "utf8")]));
  const adapted = adaptSources(files); // Validate all anchors before writing anything.
  for (const [path, source] of Object.entries(adapted)) writeFileSync(join(upstream, path), source);
  const copy = (from, to) => { const destination = join(upstream, to); mkdirSync(dirname(destination), { recursive: true }); copyFileSync(join(kit, from), destination); };
  for (const file of ["VoiceControls.tsx", "media.ts", "voice.css"]) copy("integration/pi-web/client/" + file, "components/pi-voice/" + file);
  copy("integration/pi-web/client/pcm-worklet.js", "public/pi-voice/pcm-worklet.js");
  copy("integration/pi-web/server/route.ts", "app/api/pi-voice/v1/[id]/route.ts");
  copy("shared/browser.ts", "lib/pi-voice-bridge.ts");
  copy("shared/messages.ts", "lib/pi-voice-messages.ts");
  copy("packages/dictation/composer.ts", "lib/pi-voice-composer.ts");
}
