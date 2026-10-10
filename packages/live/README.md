# Live voice

`/live` or Ctrl+Shift+L toggles conversation. Space mutes; Esc ends it. `/live voice` selects a response voice; `/live enabled on|off` controls availability.

Uses `gpt-live-1-codex` for conversation and delegates coding tasks to the current Pi chat. Startup context includes recent visible messages, summaries, workspace, model and work status—not thinking or raw tool output.

Terminal focus/FIFO arbitration controls microphone ownership. Dictation and Live cannot hold input concurrently within one session.

Requires Codex OAuth. [Pi Web integration](https://github.com/khanra17/pi-extensions/tree/main/integration/pi-web) uses browser-owned microphone, WebRTC and playback over HTTPS. Use its Live button and mute/end controls.

The terminal requires native microphone/WebRTC bindings. Supported: Windows x64, Linux x64/arm64, macOS x64/arm64.

Preferences: `~/.pi/agent/pi-codex-voice-live.json`. See [third-party notices](THIRD_PARTY_NOTICES.md).
