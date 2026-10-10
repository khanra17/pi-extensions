# Live voice

`/live` or Ctrl+Shift+L toggles conversation. Space mutes; Esc ends it. `/live voice` selects a response voice; `/live enabled on|off` controls availability.

Uses `gpt-live-1-codex` for conversation and delegates coding tasks to the current Pi chat. Startup context includes recent visible messages, summaries, workspace, model and work status—not thinking or raw tool output.

Terminal focus/FIFO arbitration controls microphone ownership. Dictation and Live cannot hold input concurrently within one session.

Requires the terminal UI, Codex OAuth and native microphone/WebRTC bindings. Supported: Windows x64, Linux x64/arm64, macOS x64/arm64.

Preferences: `~/.pi/agent/pi-codex-voice-live.json`. See [third-party notices](THIRD_PARTY_NOTICES.md).
