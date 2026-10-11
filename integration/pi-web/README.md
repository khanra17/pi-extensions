# In-page Pi Web voice

A separate Pi Web build with dictation, Live and read-aloud in the existing chat page, including mobile layouts. Installed Pi/Pi Web and their launchers are not patched.

## Build and start

From this repository:

```sh
npm ci
npm run web:build
```

The build uses pinned Pi Web 0.11.1 and writes a new content-addressed directory under `.cache/pi-web-builds`. It does not replace a running build.

When all sessions are idle, stop the current Pi Web server normally. Then:

```sh
npm run web:start -- --update-extensions --hostname 0.0.0.0 --port 30141
```

`--update-extensions` refreshes all three GitHub-source voice packages through Pi's installer. Omit it to manage individual packages yourself. An occupied port stops the launcher before any package updates.

Keep the existing HTTPS proxy/password configuration and reload the page. Mobile microphone access requires HTTPS. Returning to stock Pi Web is simply stopping this server normally and running `pi-web` again.

## Controls

- Microphone: tap to toggle or hold to talk. Ctrl+Alt+M toggles; Esc cancels. Drafts remain editable; recording/finalizing cannot submit them.
- Live: click its button or Ctrl+Alt+L; mute/end controls stay in the page. `/live voice` selects the response voice through Pi Web's extension dialog.
- Speaker: the single playback/settings launcher; opening it does not start speech. Press Play inside. Adjacent-message controls and searchable voices are in the same panel. Pause holds the queue; Stop clears it. Auto-read speaks new visible assistant updates/finals, not thinking or tool data. The panel contains only read-aloud controls. Dictation and Live have their own panels; absent extensions have no launcher.
- Ctrl+Alt+V opens read-aloud controls. Closing it leaves speech playing; hiding the page stops media. Composer/session/tree changes are fenced against late results.

Voice shortcuts use Ctrl+Alt+M/L/V in CLI and web, leaving Ctrl+Space (IME), Ctrl+X (clipboard) and Ctrl+Shift+L (browser) alone. AltGraph input is ignored; OS/custom bindings and terminals can still differ, so buttons/slash commands remain the fallback.

Failures remain visible in a separate accessible alert, even with controls closed. Preview failures show their actual cause, not a generic delay. No local backend or model download is included.

Dictation and Live each have their own **Provider** selector in their own panel, independent of chat and each other. Both default to Codex OAuth. Right-click Mic/Live, or run `/voice provider` / `/live provider` (also on mobile), to open their controls without capturing/calling. Changes are blocked while that feature is running and do not change chat or read-aloud.

For Cockpit Tools: **Settings → Models → select the `openai` provider row (not a model) → Base URL `http://localhost:18080/v1` → Save**. Keep the existing key/catalog models. `localhost` refers to the Pi server, not the phone. Then run `/voice provider openai`; choose `/live provider openai` only if Live should also use Cockpit, otherwise leave `/live provider openai-codex`. Voice uses provider-level auth/headers/base URL, not chat model overrides. Transcription, Live bootstrap and sideband stay on that gateway; failures never switch accounts.

Current actual Cockpit probes reached this local service using the existing resolved key, without changing saved configuration: transcription returned an upstream Cloudflare challenge; Live signaling returned HTTP 404. Contract tests passing do not establish successful voice service operation. Neither failure triggers a local backend or paid Speech fallback.

Read-aloud starts with the first sentence and buffers the next five. Long replies are referenced by session entry ID, not uploaded as giant control requests or rejected at 12,000 characters. Pause preserves bounded buffering; Stop cancels it.

Slash commands open the browser controls; microphone/audio permission is granted with a viewing-device gesture. Terminal controls remain independent.

## Updating and repair

```sh
npm run web:check -- --ref vNEXT
npm run web:build -- --ref vNEXT
npm run test:browser
```

`web:check` checks anchors only. The build also typechecks and compiles; browser tests are separate. Start the new build only after those checks pass. Old build directories and dependency caches stay untouched; do not delete them while a process uses them.

`adapter.mjs` contains the four host-file adaptations: composer state/submission, session hookup, session preparation and assistant-text markers. If an upstream anchor changes, preparation fails before dependencies are installed. Repair that adapter, or `server/route.ts` if server exports changed. Frontend features otherwise consume `VoiceHost` version 1; packages communicate through the versioned `shared/browser.ts` registry and authenticated, origin-checked `/api/pi-voice/v1/:session` API. OAuth stays on the server; capture, WebRTC tracks and playback stay in the browser.

## Verification

70 focused tests and the production build pass. Isolated Chromium desktop/mobile-layout smoke covers growing WAV previews, final replacement, user edits, no auto-send, real MP3 decoding, prose highlighting, voice search, browser-to-browser WebRTC and stopped microphone tracks. ASR/signaling use fixtures, with gateway HTTP/WebSocket contract tests and long-reply/rolling-buffer tests; actual Edge synthesis also returned the first-sentence MP3 in about 1.5 seconds in one probe and prepared five following sentences. This is an observed network result, not a latency guarantee. Production dependencies audited with zero reported vulnerabilities; upstream development dependencies reported 13.

A separate browser probe completed a fresh real Codex Live signaling/WebRTC/data-channel/sideband handshake with a valid voice and test microphone, using Pi's Codex login. Those do not certify a physical phone, Safari media, or live real-microphone audio quality. Playwright's Windows WebKit build lacks the required media APIs and cannot provide that certification.
