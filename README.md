# OpenHands Side Panel

Drive an [OpenHands Cloud](https://app.all-hands.dev) conversation from Chrome's side panel. The panel types
into the site's own composer, clicks the site's own Send control **exactly once**, and captures the matching
reply — live activity, action steps, confirmations and all — back into the panel. No API key, no server, no
credential access, and no "paste the reply here" fallback: when the page cannot be driven, the extension says
precisely why and stops.

Built on the architecture of [`Clyroas/arena-agent-auto-v2.8.0`](https://github.com/Clyroas/arena-agent-auto-v2.8.0)
(side panel → direct port → isolated-world page adapter), with every selector and state rule verified
against the OpenHands frontend source (`All-Hands-AI/OpenHands`).

```
panel (side panel)  ──direct port──▶  agent-content.js + agent-dom.js  (isolated world, app.all-hands.dev)
        │                                        │ one staged-file send
        └──one-shot messages──▶ worker.js        ▼
                              (inject, verify,  stage-main.js (main world: native FileList, single use)
                               grant, tabs)
```

## Install

1. Chrome → `chrome://extensions` → *Developer mode* → **Load unpacked** → this folder.
2. Sign in to OpenHands in a normal tab.
3. Open the side panel from the toolbar icon, choose that tab, tick the two confirmations, connect.

Requirements: Chrome 116+, site access for `https://app.all-hands.dev/*` only (never "all sites").

## What it does

- **Send once, capture fully.** Content + baseline signatures attribute the reply to your message even
  while OpenHands streams, swaps bubbles and re-groups tool cards. Completion requires the finished text
  *and* an idle site, held for a settle window — a pause between tool calls never ends a turn early.
- **Live view.** Streamed text (formatted like the site), action/thinking step labels, the site's own
  activity chip, and elapsed/quiet clocks. Previews are labelled as previews, never as the final answer.
- **Confirmations.** "Do you want to continue with this action?" appears in the panel with its High Risk
  badge; Confirm or Reject is one click in one direction, never automatic, never retried. Works for a
  confirmation you started in the tab, too.
- **Stop / Resume.** One click on OpenHands' own controls, offered only while the site shows them.
- **Attachments.** Pick, paste or drop files; they are placed into the OpenHands composer immediately before
  the one Send click, under the site's own limits (3 MB per file and combined).
- **Read-only extras.** Import earlier rendered turns; reconnect after a tab reload re-watches an accepted
  message without resending anything.
- **Fail-closed.** Rate limits, sign-in walls, archived conversations, drafts in the box, ambiguous turns,
  security verifications (paused, then resumed on their own) — each is a coded, explained stop. See
  [`docs/errors.md`](docs/errors.md).

## Documentation

| Doc | Contents |
| --- | --- |
| [`docs/architecture.md`](docs/architecture.md) | contexts, wire protocol, the send transaction, transient vs fatal, privacy |
| [`docs/selectors.md`](docs/selectors.md) | every `data-testid` pinned to its OpenHands source file |
| [`docs/errors.md`](docs/errors.md) | the coded error table |
| [`docs/testing.md`](docs/testing.md) | what each suite pins and the harness conventions |
| [`docs/development.md`](docs/development.md) | loading, scripts, dev preview, change checklist |

## Develop

```bash
npm install          # devDeps only: eslint + jsdom
npm run check        # lint + tests
npm run preview      # http://localhost:8080/dev/preview.html — the panel's motion, no OpenHands account
npm run icons        # regenerate icons/ from code
npm run package:extension
```

No build step: Chrome loads these files as written. The dev preview and the test suite are the only places
a fake OpenHands exists.

## Privacy

Chat stays in memory; closing or disconnecting clears it. Only theme, text size and accent are stored
(validated, whitelisted keys). The extension makes no network requests at all (`connect-src 'none'`), and
sign-in happens entirely in the OpenHands tab.

## Status

Experimental. Verified against OpenHands frontend v1.24 markup and structure; if the site's markup moves,
the capability line in Settings names the missing control and Send stays disabled rather than guessing.
