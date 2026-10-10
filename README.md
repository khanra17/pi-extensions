# pi-extensions

| Extension | Command | Purpose |
| --- | --- | --- |
| [Dictation](packages/dictation) | `/voice` | Speech previews in the editable composer |
| [Live voice](packages/live) | `/live` | Conversation and coding-task delegation |
| [Read-aloud](packages/read-aloud) | `/tts` | Edge voices and playback controls |

## Install

Requires Pi 1.1+, Node 22.19+, npm and Git. Install the extensions you want:

```sh
pi install npm:@khanra17/pi-dictation@github:khanra17/pi-extensions#dictation
pi install npm:@khanra17/pi-live-voice@github:khanra17/pi-extensions#live
pi install npm:@khanra17/pi-read-aloud@github:khanra17/pi-extensions#read-aloud
```

These use npm's GitHub source resolver, not the npm registry. No npm account is needed. Each package ref contains one extension and its required shared helpers.

Run `/reload` after installation. To update, repeat its install command; to remove, replace `install` with `remove`.

Use them in the terminal or with the [in-page Pi Web integration](integration/pi-web). In Pi Web, media uses the viewing device; stock Pi Web needs the integration build.

Dictation and Live require Codex OAuth (`/login`). Their ChatGPT endpoints and Edge Read Aloud are unofficial.

## Development

```sh
npm ci
npm run check
npm test
npm run package:git
git push origin main dictation live read-aloud
```

Package refs are generated from the committed canonical source on `main`.

## License

MIT, except read-aloud (LGPL-3.0-or-later). See the package licenses and third-party notices.
