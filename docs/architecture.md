# Architecture

OpenHands Side Panel drives a **signed-in `https://app.all-hands.dev` tab** from Chrome's side panel. It is
not an API client: there is no token, no server, no WebSocket. The panel types into the site's own composer
and clicks the site's own Send control exactly once, then reads the site's own DOM to capture the reply.
The idea and the three-context layout follow
[`Clyroas/arena-agent-auto-v2.8.0`](https://github.com/Clyroas/arena-agent-auto-v2.8.0); every selector and
state rule is verified against the OpenHands frontend source (`All-Hands-AI/OpenHands`, see
[selectors.md](selectors.md)).

## The three Chrome contexts

```
┌────────────────────────── extension page ──────────────────────────┐
│ panel.html → panel.js                                              │
│   ConversationView / LiveView / rich-view / live-status            │
│   ▲                                                                │
│   │ chrome.tabs.connect(tabId, {name: 'oh-side-panel-v1'})         │
│   │   DIRECT port, one transaction at a time                       │
└───┼────────────────────────────────────────────────────────────────┘
    │                                   ▲ one-shot chrome.runtime.sendMessage
    │                                   │  (ATTACH, STAGE_GRANT, LIST_TABS, FOCUS_TAB, OPEN_SITE …)
    │                                   │
┌───┴─────────────── tab: app.all-hands.dev ──────────────┐  ┌──────── worker.js (MV3 service worker) ────────┐
│ ISOLATED world:                                         │  │ injects + verifies the adapter (attachment.js) │
│   agent-content.js  (connection owner, scan loop)       │  │ relays single-use file-staging grants          │
│   agent-dom.js      (page adapter: read + drive)        │  │ lists/focuses/opens tabs                       │
│   attachment-policy.js (pure limits)                    │  │ no long-lived state, no relay                  │
│ MAIN world, once per staged-file send:                  │  └────────────────────────────────────────────────┘
│   stage-main.js (native FileList onto the site input)   │
└─────────────────────────────────────────────────────────┘
```

* **Panel → content script is a direct port.** The service worker is only used for one-shot requests, so
  Chrome suspending the idle worker can never drop a conversation. This is the single most important
  structural decision, inherited from the reference.
* **The content script owns the page.** It is the only code that reads or writes the OpenHands DOM. The
  panel never sees an element, only coded events.
* **The worker never relays chat.** It injects and verifies the adapter (`ATTACH`), holds single-use
  staging grants, and manages tabs.

## Wire protocol

Panel → content script: `PROBE`, `PING`, `SITE`, `SEND {requestId, prompt, url, attachments?}`,
`WATCH {requestId, prompt, url, hadAttachments, baseline}`, `CONFIRM {requestId, accept}`,
`CONTROL {control: 'stop' | 'resume'}`, `LOAD_HISTORY {requestId, url}`, `CANCEL {requestId}`.

Content script → panel (every event carries `documentId` and `adapterVersion`):
`READY`, `WAITING`, `PONG`, `SITE_INFO`, `SENDING`, `STAGED`, `ACCEPTED`, `SENT_WORKING`, `LIVE_UPDATE`,
`COMPLETE`, `CANCELLED`, `BLOCKED` (transient security hold), `SECURITY_CLEARED`, `PAUSED`, `RESUMED`,
`URL_BOUND`, `WATCHING`, `CONFIRM_SENT`, `CONFIRM_SEEN`, `CONFIRM_ERROR`, `CONTROL_SENT`, `CONTROL_ERROR`,
`HISTORY`, `HISTORY_ERROR`, `ERROR`.

## The send transaction

Exactly one at a time, identified by a `crypto.randomUUID()` request id that is **consumed on first
attempt** — a panel that retries after a timeout can never cause a second send.

1. `samePage()` + `checkBlocks()`: right origin, right route, not signed out, not archived, no rate-limit
   banner, no security verification. Bounded wait (2 min) for a *transient* verification before the click.
2. Snapshot the transcript signatures **before typing** (the baseline).
3. Refuse if the composer holds a draft (`DRAFT_EXISTS`) — the extension never overwrites a human's text.
4. Type through Chrome's editing pipeline (`execCommand('insertText')`), so OpenHands' own `input` handler
   enables Send. `innerHTML`/`textContent` assignment and simulated Enter are never used.
5. Stage files (optional): single-use worker grant → `stage-main.js` in the MAIN world → native `FileList`
   setter → `change` event. Verified by name and size afterwards.
6. Wait ≤ 4 s for the Send control to enable, re-verifying page, baseline and composer on every pass.
7. **One click.** No Enter fallback, no retry, ever.
8. Scan loop (MutationObserver + 300 ms timer + panel heartbeats, coalesced to ≤ 1 scan / 120 ms):
   locate the user row by content + baseline, stream `LIVE_UPDATE`, and declare `COMPLETE` only when the
   last agent text is non-empty, the site is not working, no confirmation card is open, **and** that state
   held for 1.2 s (OpenHands re-renders between tool calls and swaps its streaming bubble for the final
   row — a moment of quiet is not a finished reply).
9. If after 15 s the message is neither drawn nor visibly accepted, fail with `SEND_NOT_CONFIRMED` — unless
   there is positive evidence OpenHands took it (pending queue, Stop control, cleared composer, new
   conversation URL), in which case the panel waits with no time limit (`SENT_WORKING`).

## Turn attribution

Rows are matched by **content signature** (`u/a:<fnv-1a hash>`) plus the baseline of rows that preceded the
send — never by element identity or index. OpenHands streams into a growing bubble, swaps streaming rows
for final rows, and prepends older events when you scroll; all three move positions without changing what
your message said. A second user row after yours is `AMBIGUOUS_TURN`: capture stops rather than attribute
the wrong reply.

`article[data-testid="agent-message"]` rows only ever come from `MessageEvent`, `StreamingDeltaEvent` and
`FinishAction` in the OpenHands frontend — all *event-group breakers* — so a captured reply can never be
folded into a collapsed "N actions completed" group. Tool cards are read as **steps** (`turnSteps`), never
as reply rows, and collapsed groups are never expanded: their hidden detail is not read.

## Transient vs fatal

| Condition | Class | Behaviour |
| --- | --- | --- |
| Security verification (captcha, Cloudflare) | transient | turn holds (`BLOCKED`), resumes alone (`SECURITY_CLEARED`); budgets shift so the hold costs nothing |
| Agent paused/stopped | transient | turn holds (`PAUSED`), resumes on Resume (`RESUMED`); panel offers one-click Resume |
| Action confirmation card | blocking | Send refused (`CONFIRMATION_PENDING`); panel offers one-click Confirm/Reject, once, one direction |
| Sign-in wall, shared view, non-chat route | fatal | coded error, nothing typed or clicked |
| Rate limit / quota | fatal | coded error, never retried |
| Archived conversation | fatal | coded error |
| Site error state or in-turn error event | fatal | coded error with the visible label |
| Tab reload after acceptance | recoverable | panel reattaches and re-watches **read-only** (`WATCH`) |
| Tab reload before acceptance | fatal | `PAGE_RELOADED`; the user checks before resending |

## Attachments

Limits mirror the site (`frontend/src/utils/file-validation.ts`): **3 MB per file, 3 MB combined**,
`<input type="file" multiple accept="*/*">`. On top of that the panel only stages text/code/markup/image
types and refuses archives and binaries outright. Bytes travel panel → content script → MAIN world for one
call, are blanked afterwards, and are never stored. The MAIN-world helper re-checks everything (token,
expiry ≤ 30 s, marker uniqueness, types, sizes) because it must not trust the isolated world.

## Privacy

* No network requests from any extension context (`connect-src 'none'` in the extension CSP).
* No credential access: sign-in happens in the OpenHands tab; nothing is read from it.
* Nothing persisted except theme, text size and accent (`localStorage`, whitelisted keys, validated).
* Closing or disconnecting the panel clears its transcript. The OpenHands conversation is untouched.
* Copy buttons write to the clipboard on click; the clipboard is never read.
