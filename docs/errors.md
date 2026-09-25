# Coded errors

Every refusal is a code plus a sentence that says what was *not* done. The panel shows both, keeps the
draft when nothing was clicked, and never converts a failure into a manual paste box. Codes are stable;
messages may be reworded.

## Connection and attachment

| Code | Meaning | Nothing was… |
| --- | --- | --- |
| `INVALID_TAB` | no tab selected | typed / clicked |
| `EXTENSION_UPDATE_REQUIRED` | `chrome.scripting` unavailable | typed / clicked |
| `SITE_ACCESS_REQUIRED` | Chrome has not granted `https://app.all-hands.dev/*` | typed / clicked |
| `WRONG_ORIGIN` | selected tab is not on the site | typed / clicked |
| `TAB_NAVIGATED` | tab moved during attach | typed / clicked |
| `CONTENT_SCRIPT_INJECTION_FAILED` | Chrome refused the injection (policy, frame, tab type) | typed / clicked |
| `DOCUMENT_NOT_FOUND` / `DOCUMENT_CHANGED` | no documentId, or it died mid-attach | typed / clicked |
| `SCRIPT_REGISTRATION_FAILED` | the adapter did not register version 1.0.0 | typed / clicked |
| `ADAPTER_MISSING` | `agent-dom.js` did not load beside `agent-content.js` | typed / clicked |
| `TAB_IN_USE` | another panel holds this tab's port (transient during reconnect) | typed / clicked |
| `VERSION_MISMATCH` | tab adapter ≠ panel version | typed / clicked |
| `ADAPTER_HANDSHAKE_TIMEOUT` | no READY within 15 s (or 120 s while a transient notice is up) | typed / clicked |
| `CONNECTION_LOST` / `TAB_NOT_RESPONDING` | port closed / heartbeat silent | resent |

## Page state (hard stops, checked before typing)

| Code | Meaning |
| --- | --- |
| `WRONG_PAGE` | not a drivable route (settings, automations, MCP, skills, shared view) |
| `SIGN_IN_REQUIRED` | `/login`, or a banner asking to sign in again |
| `CONVERSATION_ARCHIVED` | read-only archived/workspace-error banner |
| `RATE_LIMIT` | quota / 429 banner or toast — follow the site's wait time |
| `OPENHANDS_ERROR` | site error banner, error status, or an in-turn error event (label quoted) |
| `SECURITY_CHECK` | captcha / human verification. Transient *during* a turn (hold + resume); fatal before a click |
| `SITE_DISCONNECTED` | OpenHands lost its workspace connection |
| `AGENT_BUSY` | Stop control or Running status: the site is working |
| `CONFIRMATION_PENDING` | an action confirmation is open — answer it, here or in the tab |
| `DRAFT_EXISTS` | the composer holds an unsent draft; the extension never overwrites it |
| `COMPOSER_NOT_FOUND` / `COMPOSER_UNAVAILABLE` / `COMPOSER_CHANGED` | no message box, not editable, or replaced mid-send |
| `SEND_BUTTON_NOT_FOUND` / `AMBIGUOUS_SEND_BUTTON` | no unique Send control for this composer |
| `SEND_UNAVAILABLE` | Send stayed disabled for 4 s — text may sit in the box, no click was attempted |
| `UPLOAD_UNAVAILABLE` / `UPLOAD_CHANGED` | no usable single file input for this composer |
| `RICH_EDITOR_UNSUPPORTED` | the browser cannot do a native rich-editor insertion (no `execCommand`) |

## Send and capture

| Code | Meaning |
| --- | --- |
| `INVALID_REQUEST` / `DUPLICATE_REQUEST` / `BUSY` | malformed id/prompt, second attempt at one id, or a transaction in flight |
| `INVALID_ATTACHMENT` | a staged file failed the policy (type, size, combined 3 MB, count) |
| `STAGE_*` (`STAGE_UNBOUND`, `STAGE_EXPIRED`, `STAGE_FAILED`, `STAGE_REJECTED`, `STAGE_MISMATCH`, `STAGE_TIMEOUT`) | the single-use staging grant was missing, expired, refused or disagreed with what landed |
| `CONVERSATION_CHANGED` | the page moved or the transcript changed under the transaction (baseline mismatch, different conversation id) |
| `SEND_NOT_CONFIRMED` | one click happened, but after 15 s there is no sign OpenHands took the message |
| `SENT_WORKING` *(not an error)* | positive evidence it was taken; the panel waits with no time limit |
| `PROMPT_MISMATCH` / `AMBIGUOUS_TURN` / `TURN_TOO_LARGE` / `REPLY_TOO_LARGE` | attribution or size guardrails; capture stops instead of guessing |
| `PAGE_RELOADED` | the document closed before acceptance |
| `WATCH_UNAVAILABLE` | after a reconnect the accepted message is no longer on the page |

## Confirmations and agent controls

| Code | Meaning |
| --- | --- |
| `INVALID_CHOICE` | `accept` was not a boolean |
| `CONFIRM_ALREADY_ANSWERED` / `CONFIRM_IN_FLIGHT` | exactly-once per card |
| `CONFIRM_UNAVAILABLE` | no card, or that direction's control is not usable right now |
| `CONFIRM_NOT_APPLIED` | clicked once; the card is still up after 10 s — answer it in the tab |
| `INVALID_CONTROL` / `STOP_UNAVAILABLE` / `RESUME_UNAVAILABLE` / `STOP_NOT_APPLIED` / `RESUME_NOT_APPLIED` | the Stop/Play passthrough, same exactly-once rules |

## History (read-only)

`URL_CHANGED`, `HISTORY_FAILED`, `HISTORY_TIMEOUT`, `HISTORY_EMPTY` — earlier messages never modify the page.

## Panel-side transport

`TIMEOUT` (a worker request outlived its 20 s budget), `<TYPE>_FAILED` (the panel could not apply an event;
the view is rebuilt from what it knows and the port listener stays alive).
