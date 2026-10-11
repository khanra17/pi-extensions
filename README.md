# Read-aloud

`/tts` or Ctrl+Alt+V opens playback controls.

Commands: `play`, `pause`, `resume`, `stop`, `replay`, `previous`, `next`, `voice`, `speed`, `volume`, `mute`. `auto`, `code` and `highlight` accept `on|off|toggle`.

The first sentence starts playback without waiting for the rest. The next five sentences buffer ahead; playback advances that window. Long messages have no 12,000-character rejection. Oversized individual sentences are split at Edge's per-request byte limit.

The voice picker searches names, languages, regions, locales and genders. Auto-read queues working updates and final replies, excluding thinking and tools. Pause holds playback with bounded buffering; Stop cancels synthesis and clears it. Its panel contains only read-aloud settings.

Highlights prose, not fenced code. Closing the panel leaves playback running; `/tts stop` ends it. Mouse controls and fullscreen scrolling are supported.

Uses Edge Read Aloud without an account key. [Pi Web integration](https://github.com/khanra17/pi-extensions/tree/main/integration/pi-web) plays audio on the viewing device, with an in-page picker and controls. Browser highlighting targets assistant prose in the existing message view.

Terminal playback is native, with optional `mpv` fallback.

Preferences: `~/.pi/agent/pi-edge-tts.json`. See [third-party notices](THIRD_PARTY_NOTICES.md).
