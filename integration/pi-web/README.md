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

- Microphone: tap to toggle or hold to talk. Alt+M/Ctrl+Space toggle; Esc cancels. Drafts remain editable; recording/finalizing cannot submit them.
- Live: click its button or Ctrl+Shift+L; mute/end controls stay in the page. `/live voice` selects the response voice through Pi Web's extension dialog.
- Speaker: opens playback, adjacent-message controls and searchable voices. Pause holds the queue; Stop clears it. Auto-read speaks new visible assistant updates/finals, not thinking or tool data.
- Ctrl+Alt+V opens the panel. Closing it leaves speech playing; hiding the page stops media. Composer/session/tree changes are fenced against late results.

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

48 focused tests and the production build pass. Isolated Chromium desktop/mobile-layout smoke covers growing WAV previews, final replacement, user edits, no auto-send, real MP3 decoding, prose highlighting, voice search, browser-to-browser WebRTC and stopped microphone tracks. ASR/signaling use fixtures; an actual Edge MP3 was synthesized separately. Production dependencies audited with zero reported vulnerabilities; upstream development dependencies reported 13.

A physical phone, Safari media and a fresh Codex Live service handshake are not certified. Playwright's Windows WebKit build lacks the required media APIs and cannot provide that certification.
