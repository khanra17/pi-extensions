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

Dictation and Live each select their own provider, independently of chat and of each other. Both default to Pi's Codex login. `/voice provider openai` uses the configured OpenAI-compatible endpoint/key for dictation; `/live provider openai` does the same for Live. `/voice provider openai-codex` and `/live provider openai-codex` restore Codex OAuth for that feature. They never fall back to a different account. Read-aloud stays independently on Edge.

For Cockpit Tools, set provider `openai`'s **Base URL** to `http://localhost:18080/v1` in Pi Web **Settings → Models → provider row → Save**, retaining your saved key/catalog models. `localhost` is the machine running Pi/Pi Web. The provider-level endpoint and authentication apply to voice; chat model overrides and chat model switching do not. The Codex voice protocol and Edge Read Aloud are unofficial.

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
