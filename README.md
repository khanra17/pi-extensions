# Dictation

`/voice` or Ctrl+Alt+M toggles recording; Esc cancels. Kitty-encoded Space supports hold-to-talk on an empty composer. Clipboard/IME shortcuts are left alone.

Speech previews appear in the existing draft. Stop replaces the preview with the final transcript; nothing is submitted automatically. Editing a preview stops automatic replacement. Cancel restores the original draft only if the preview is untouched.

Codex previews upload growing WAV snapshots about every two seconds plus server latency; local previews process them on this machine. Set `PI_DICTATION_PREVIEW=0` for final-only transcription. Recordings stop after two minutes.

## Requirements

Codex OAuth (`/login`). [Pi Web integration](https://github.com/khanra17/pi-extensions/tree/main/integration/pi-web) captures the viewing device over HTTPS. Use the microphone button or Ctrl+Alt+M; hold the button to talk. It preserves the draft and never sends it.

In the terminal, Windows uses native capture; macOS/Linux require `ffmpeg`. The Windows file-only fallback cannot preview.

- `PI_CODEX_VOICE_DEVICE`: capture device.
- `PI_CODEX_VOICE_RECORDER=ffmpeg`: use ffmpeg on Windows.

## Transcription backend

Codex OAuth is the default, but its unofficial `/transcribe` route may be blocked by Cloudflare. That is not fixed by logging in again. Errors now remain visible; permanent preview failures stop repeated uploads while preserving the recording.

Choose **Local Whisper** in the web voice panel, or `/voice backend local` in CLI/web. First use downloads about 42 MiB of public, pinned Whisper-tiny model files into `<agent-dir>/voice-models`; subsequent inference is offline on server/CLI CPU. It never uses server media devices. English is the default; `PI_DICTATION_LANGUAGE` selects a supported Whisper language. Tiny is a lightweight fallback, not Codex-level accuracy. The optional `@huggingface/transformers` runtime must be installed (normal GitHub-source installs include it).

`/voice backend codex` switches back; `/voice backend` reports the choice. Preferences are in `<agent-dir>/pi-dictation.json`. No automatic backend switch, API-key fallback, or paid Speech API is used.

## Corrections

`/voice corrections` lists local corrections. Use `replace <heard> => <correct>` or `remove <heard>` to edit them. Stored in `~/.pi/agent/pi-codex-voice.json`; not sent as ASR hints.
