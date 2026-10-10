# Dictation

`/voice` or Alt+M toggles recording. Ctrl+X stops; Esc cancels. Ctrl+Space also toggles; Kitty-encoded Space supports hold-to-talk on an empty composer.

Speech previews appear in the existing draft. Stop replaces the preview with the final transcript; nothing is submitted automatically. Editing a preview stops automatic replacement. Cancel restores the original draft only if the preview is untouched.

Previews upload growing WAV snapshots about every two seconds plus server latency. Set `PI_DICTATION_PREVIEW=0` for final-only transcription. Recordings stop after two minutes.

## Requirements

Terminal UI and Codex OAuth (`/login`). Windows uses native capture; macOS/Linux require `ffmpeg`. The Windows file-only fallback cannot preview.

- `PI_CODEX_VOICE_DEVICE`: capture device.
- `PI_CODEX_VOICE_RECORDER=ffmpeg`: use ffmpeg on Windows.

## Corrections

`/voice corrections` lists local corrections. Use `replace <heard> => <correct>` or `remove <heard>` to edit them. Stored in `~/.pi/agent/pi-codex-voice.json`; not sent as ASR hints.
