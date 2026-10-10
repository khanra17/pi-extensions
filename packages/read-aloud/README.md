# Read-aloud

`/tts` or Ctrl+Alt+V opens playback controls.

Commands: `play`, `pause`, `resume`, `stop`, `replay`, `previous`, `next`, `voice`, `speed`, `volume`, `mute`. `auto`, `code` and `highlight` accept `on|off|toggle`.

The voice picker searches names, languages, regions, locales and genders. Auto-read queues working updates and final replies, excluding thinking and tools. Pause holds the queue; Stop clears it.

Highlights prose, not fenced code. Closing the panel leaves playback running; `/tts stop` ends it. Mouse controls and fullscreen scrolling are supported.

Requires the terminal UI. Uses Edge Read Aloud without an account key and native audio playback, with optional `mpv` fallback.

Preferences: `~/.pi/agent/pi-edge-tts.json`. See [third-party notices](THIRD_PARTY_NOTICES.md).
