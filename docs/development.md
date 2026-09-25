# Development

## Load the extension

1. `npm install` (dev tooling only — the extension itself has **no runtime dependencies and no build step**).
2. Chrome → `chrome://extensions` → enable *Developer mode* → **Load unpacked** → pick this repository root.
3. Open `https://app.all-hands.dev` and sign in **there**, normally.
4. Click the toolbar icon (or `chrome://extensions` → this extension → *Open side panel*), pick the tab,
   tick the two confirmations, **Connect & check controls**.

The connection line in Settings reports what was verified: adapter version, launcher vs conversation,
composer kind, upload kind, and a capability snapshot. If OpenHands' markup ever moves, that line names the
missing control and Send stays disabled (`drift`) instead of failing mid-send.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run check` | `lint` + `test` |
| `npm run lint` | ESLint 9 flat config over every shipped and dev file |
| `npm test` | `node --test test/*.test.mjs` (jsdom) |
| `npm run preview` | static server on `0.0.0.0:8080` → `/dev/preview.html`, the motion preview |
| `npm run icons` | regenerate `icons/*.png` from `scripts/make-icons.mjs` (pure Node, no deps) |
| `npm run package:extension` | copy the allow-list (`extension-files.json`) to `dist/openhands-side-panel-<version>/` |

## The dev preview

`dev/` is **not** in `manifest.json` and never ships. `preview.html` fetches the real `panel.html`, loads
the real `panel.css`/`panel.js`, and answers Chrome with a fake worker and a fake OpenHands port, so every
animation you see comes from production code paths. The bar on top drives scenarios: reply, action steps,
confirmation, paused agent, verification hold, coded error, staged file, history import — or the whole
tour in order. It needs `http://` (the server above); `file://` cannot fetch `panel.html`.

## Making a change safely

* **New selector?** Add it to the `T` table in `agent-dom.js` with its OpenHands source file, then extend
  `test/agent-dom.test.mjs` with that markup. Selector provenance lives in `docs/selectors.md`.
* **New refusal?** Throw `D.fail('CODE', 'sentence that says what was not done')`. Add the code to
  `docs/errors.md` and a test that asserts no click happened.
* **New event?** Give it `documentId` + `adapterVersion` like the others, handle it in `panel.js`
  `handleEvent`, and remember: an event that cannot be applied must report and re-render, never kill the
  port listener (`receive()` wraps `handleEvent`).
* **New page fact?** It belongs in `publicState()`/`inspectControls()` as labels only — never an element,
  never account data.

## Version handshake

One string, many copies: `manifest.json`, `package.json`, `core.js`, `agent-dom.js`, `agent-content.js`,
`agent-client.js`, `attachment-policy.js`, the panel title. `test/version-sync.test.mjs` fails the build if
any copy drifts. The worker verifies the content script's registration after injection, and the panel
verifies `adapterVersion` on `READY`; a mismatch is a coded error telling the user to reload, never a
silent half-connection.

## House rules (why the code looks like this)

* No `innerHTML` with site or user content, anywhere. Rich trees are rebuilt node by node (`rich-view.js`).
* No retry, no fallback click, no Enter simulation, no manual paste box. One click, one direction, once.
* Every worker request is bounded (`withTimeout`); every wait in the content script has a deadline or a
  documented "transient, waits for a human" rule.
* `localStorage` holds appearance only, under whitelisted validated keys.
* The service worker stays thin and stateless apart from single-use staging grants (20 s, consumed once).
