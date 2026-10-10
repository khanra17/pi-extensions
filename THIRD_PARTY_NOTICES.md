# Third-party notices

## Edge Read Aloud protocol interoperability

The Edge transport in this package interoperates with Microsoft Edge's consumer Read
Aloud service. Its protocol implementation is informed by publicly observable client
behavior and by the open-source `rany2/edge-tts` project:

- Project: https://github.com/rany2/edge-tts
- Copyright: rany and the edge-tts contributors
- License: GNU Lesser General Public License, version 3

To the extent any transport implementation is considered derivative of that project,
it is distributed under the same LGPLv3-compatible terms as this package. The complete
TypeScript source is included in the package.

The static trusted-client token, extension origin, endpoint paths, Chromium version,
and request-header names in `edge-read-aloud.ts` are public protocol identifiers. They
are not an API key, account credential, session token, or secret belonging to the
package author or user.

Microsoft, Microsoft Edge, Bing, and Azure are trademarks of Microsoft Corporation.
This project is not affiliated with, endorsed by, or supported by Microsoft. The
consumer Read Aloud endpoint is unofficial and may change, reject third-party clients,
or be subject to terms not documented for third-party or commercial use.

## Runtime dependencies

| Package | License | Source |
| --- | --- | --- |
| `ws` | MIT | https://github.com/websockets/ws |
| `node-web-audio-api` | BSD-3-Clause | https://github.com/ircam-ismm/node-web-audio-api |
| `@soundtouchjs/audio-worklet` | MPL-2.0 | https://github.com/cutterbl/SoundTouchJS |
| `@soundtouchjs/core` | MPL-2.0 | https://github.com/cutterbl/SoundTouchJS |
| `@soundtouchjs/interpolation-strategy-lanczos` | MPL-2.0 | https://github.com/cutterbl/SoundTouchJS |
| `@soundtouchjs/worklet-base` | MPL-2.0 | https://github.com/cutterbl/SoundTouchJS |

These dependencies are installed from npm and are not copied into this package's
source files. Their distributions include their respective license texts and source.
Transitive dependencies are MIT or BSD licensed; see `package-lock.json` for the exact
resolved dependency graph.

`mpv` is detected as an optional external executable. It is not bundled, copied,
linked, or redistributed by this package.
