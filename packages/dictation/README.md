# Dictation

`/voice` or Ctrl+Alt+M toggles recording; Esc cancels. Kitty-encoded Space supports hold-to-talk on an empty composer. Clipboard/IME shortcuts are left alone.

Speech previews appear in the existing draft. Stop replaces the preview with the final transcript; nothing is submitted automatically. Editing a preview stops automatic replacement. Cancel restores the original draft only if the preview is untouched.

Previews upload growing WAV snapshots about every two seconds plus service latency. Set `PI_DICTATION_PREVIEW=0` for final-only transcription. Recordings stop after two minutes.

## Requirements

Pi's Codex login (`/login`), or the selected OpenAI-compatible endpoint's existing credentials. Cockpit Tools uses its `/v1` base URL and account-scoped key; dictation calls `/audio/transcriptions` on that endpoint. A gateway failure never switches accounts or endpoints. [Pi Web integration](https://github.com/khanra17/pi-extensions/tree/main/integration/pi-web) captures the viewing device over HTTPS. Use the microphone button or Ctrl+Alt+M; hold the button to talk. It preserves the draft and never sends it.

In the terminal, Windows uses native capture; macOS/Linux require `ffmpeg`. The Windows file-only fallback cannot preview.

- `PI_CODEX_VOICE_DEVICE`: capture device.
- `PI_CODEX_VOICE_RECORDER=ffmpeg`: use ffmpeg on Windows.

## Errors

The actual endpoint error stays visible in-page, even with controls closed. A permanent preview failure stops repeated uploads while preserving the recording and editable draft. A Cloudflare challenge does not establish credential validity or the blocking rule. There is no local transcription backend, automatic fallback, or model download.

## Corrections

`/voice corrections` lists local corrections. Use `replace <heard> => <correct>` or `remove <heard>` to edit them. Stored in `~/.pi/agent/pi-codex-voice.json`; not sent as ASR hints.
