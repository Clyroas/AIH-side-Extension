# Testing

`npm test` runs `node --test` over `test/*.test.mjs` with **jsdom**; `npm run lint` runs ESLint 9 (flat
config). There is no framework, no build step and no browser requirement: every test loads the real
production file it exercises.

```
npm install        # devDeps only: eslint, jsdom
npm run check      # lint + test
npm test
npm run lint
```

## What each suite pins

| File | Covers |
| --- | --- |
| `core.test.mjs` | `samePage` (the `/panel` suffix, query/hash, different conversations), route kinds, status vocabulary, capability drift vs transient absence, bounded worker requests |
| `attachment-policy.test.mjs` | the 3 MB / 3 MB / 8-file caps, binary refusal, hostile names, base64 round-trip and re-validation of bytes crossing the port |
| `agent-dom.test.mjs` | row/turn/signature extraction, pending-row exclusion, markdown-tolerant prompt matching, accept/complete rules, every hard block, confirmation card, agent controls, composer and upload scoping, rich trees, history grouping, capability snapshot |
| `agent-content.test.mjs` | registration guard, `TAB_IN_USE` and dead-port takeover, `READY`, exactly-once Send (writes/clicks counted), `SEND_UNAVAILABLE` without a click, settle-window completion, one-direction confirmations, Stop/Resume single clicks, cancel, security hold + resume, read-only history |
| `stage-main.test.mjs` | expiry/malformed requests, marker uniqueness, type and size refusal inside the page, restricted `accept` honoured, happy path via the native `files` setter with the marker consumed before any event |
| `conversation-view.test.mjs` | transcript rendering, imported badges, honest "no reply" outcomes, live view + confirmation card wiring, node reuse on reorder |
| `live-status.test.mjs` | every status line (error, holds, reconnect, sending, confirmation, writing, steps, clocks) and the literal site-status mapping |
| `rich-view.test.mjs` | no `innerHTML` anywhere: unknown tags dropped with text kept, `javascript:`/`data:` links defanged, budget/depth refusal, Markdown round-trip |
| `panel-lifecycle.test.mjs` | the whole panel against the real `panel.html` markup and a fake worker + fake port: connect → send → live → complete, coded failure restoring the draft, dismissible stopped card, idle confirmation through the dialog, disconnect |
| `version-sync.test.mjs` | one version string across manifest, package, all five runtime copies, the panel title, the package allow-list and the manifest's own references |

## Harness conventions

* jsdom has no layout and no editing: `getClientRects` and `isContentEditable` are polyfilled where a test
  needs `visible()` / `composer()` to behave like Chrome. The polyfills are commented at the point of use.
* Cross-realm values (arrays/objects created inside `window.eval`) are spread into the Node realm before
  `assert.deepEqual`, because `deepStrictEqual` compares prototypes.
* `stage-main.test.mjs` provides a minimal `DataTransfer` and a prototype `files` setter, since jsdom has
  neither; the refusal paths — the security-relevant ones — need no stand-in.
* The panel test polyfills `HTMLDialogElement.showModal/close`, which jsdom lacks and Chrome has.
* Tests close what they open (`window.close()`, `dispose()`), so `node --test` exits instead of hanging on
  jsdom's animation loop.

## What is not covered here, on purpose

* A real signed-in OpenHands session. The dev preview (`npm run preview`) exercises the panel's motion with
  a scripted fake port; the adapter's rules are exercised against jsdom reconstructions of the site's
  markup. A Playwright suite against a fixture page (as in the reference repo) is the natural next step and
  would slot in beside these without changing them.
