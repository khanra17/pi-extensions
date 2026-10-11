# Live voice

`/live` or Ctrl+Alt+L toggles conversation. Space mutes; Esc ends it. `/live voice` selects a response voice; `/live enabled on|off` controls availability.

Uses `gpt-live-1-codex` for conversation and delegates coding tasks to the current Pi chat. Startup context includes recent visible messages, summaries, workspace, model and work status—not thinking or raw tool output.

Terminal focus/FIFO arbitration controls microphone ownership. Dictation and Live cannot hold input concurrently within one session.

Uses Pi's Codex login or the selected OpenAI-compatible endpoint and credentials. Cockpit Tools supports the Codex Live protocol through `/v1/realtime/calls` and `/v1/live/:call_id`; both connections stay on that gateway with the same scoped key, which must route Live to a Codex OAuth account. An ordinary chat-compatible server also needs this Live protocol—chat compatibility alone is not enough. No account/endpoint fallback. [Pi Web integration](https://github.com/khanra17/pi-extensions/tree/main/integration/pi-web) uses browser-owned microphone, WebRTC and playback over HTTPS. Use its Live button or Ctrl+Alt+L and mute/end controls. The browser receives SDP, establishes its peer/data channel, then acknowledges readiness before server-side sideband attachment. Update the integration and Live package together. Signaling/ICE/sideband failures are displayed in-page.

The terminal requires native microphone/WebRTC bindings. Supported: Windows x64, Linux x64/arm64, macOS x64/arm64.

Preferences: `~/.pi/agent/pi-codex-voice-live.json`. See [third-party notices](THIRD_PARTY_NOTICES.md).
