# Selector provenance

Every selector in `agent-dom.js` is pinned to a file in the OpenHands frontend
([`All-Hands-AI/OpenHands`](https://github.com/All-Hands-AI/OpenHands); the repository root *is* the
frontend app). They were verified by reading the source, not by guessing at rendered markup, and the live
DOM of `app.all-hands.dev` matches the same structure. `test/agent-dom.test.mjs` rebuilds each shape in
jsdom so a typo fails the build instead of a conversation.

## Composer (write path)

| Selector | Source | Notes |
| --- | --- | --- |
| `div[data-testid="chat-input"]` | `src/components/features/chat/components/chat-input-field.tsx` | contenteditable div; React renders `contenteditable="false"` while disabled — that is how a disabled composer is told from a missing one |
| `button[data-testid="submit-button"]` | `src/components/features/chat/chat-send-button.tsx` | `disabled={disabled \|\| !canSubmit}`; enabled from the composer's `input` handler (`custom-chat-input.tsx`) |
| `button[data-testid="stop-button"]` | `src/components/features/chat/chat-stop-button.tsx` | visible only while the agent runs |
| `button[data-testid="play-button"]` | `src/components/features/chat/chat-play-button.tsx` | visible when stopped/paused |
| `[data-testid="interactive-chat-box"]` | `src/components/features/chat/interactive-chat-box.tsx` | scopes the Send lookup to *this* composer |
| `input[data-testid="upload-image-input"]` | `src/components/features/chat/components/hidden-file-input.tsx` | `multiple`, `accept="*/*"`; the only upload path the extension uses |

Composer-disabled conditions (`isNewConversationPending`, `llmBlocked`, `AWAITING_USER_CONFIRMATION`,
`isTaskPolling`) are *not* read from React state; they are observed as "the composer exists but is not
editable" and reported as `COMPOSER_UNAVAILABLE`.

## Transcript (read path)

| Selector | Source | Notes |
| --- | --- | --- |
| `article[data-testid="agent-message"]` / `article[data-testid="user-message"]` | `src/components/features/chat/chat-message.tsx` (`data-testid={`${type}-message`}`) | one row per bubble |
| `data-pending-status="sending" \| "error"` | same file | the optimistic queue; evidence about a send, never a transcript row |
| `[data-testid="chat-message-error"]`, `-sending`, `-expand` | same file | "Failed to send" is a hard stop (`SEND_FAILED`) because the site offers Retry and this extension never resends |
| `[data-testid="chat-scroll-container"]`, `[data-testid="chat-interface"]` | `src/components/features/chat/chat-interface.tsx` | transcript scope |
| `[data-testid="markdown-renderer"]` | `src/features/markdown/markdown-renderer.tsx` | the formatted body of a bubble; the source of `richOf()` trees |
| `button[data-testid="markdown-file-path-link"]` | `src/components/features/chat/chat-markdown-path-code.tsx` | becomes inline code in the panel, never a control |

### Event grouping (why rows are safe)

`conversation-events/.../group-events.ts` decides which events fold into an `[data-testid="event-group"]`.
`MessageEvent`, `StreamingDeltaEvent` and `FinishAction` are **group breakers**: an agent message article is
never folded, and a collapsed group hides only action/observation cards
(`[data-testid="generic-event-message-title"]`). That is what makes "the last agent row after my message"
a sound definition of *the reply*, and why collapsed groups are read as **steps** (their toggle label, e.g.
"3 actions completed") and never expanded.

## Status and activity

| Selector | Source | Notes |
| --- | --- | --- |
| `span[title]` near the stop/play/error/loading control | `src/components/features/controls/agent-status.tsx` | the status label; vocabulary comes from the site's i18n table (`Running`, `Ready`, `Done`, `User needed`, `Stopped`, `Error`/`Agent error`, `Disconnected`, `Connecting`, `Starting`, `Waiting`, `Adding git hooks`, `Adding skills`). Anything else is `unknown`, never guessed |
| `[data-testid="agent-loading-spinner"]`, `[data-testid="circle-error-icon"]` | `agent-loading.tsx`, `agent-status.tsx` | icon half of the same component |
| `[data-testid="chat-status-indicator"]` | `src/components/features/chat/chat-status-indicator.tsx` | provisioning text while a workspace starts |
| `[data-testid="live-activity-chip"]` (`role="status"`) | `src/components/features/chat/typing-indicator.tsx` | "Reading …", "Running …" — mirrored verbatim |

## Confirmation and errors

| Selector | Source | Notes |
| --- | --- | --- |
| `[data-testid="action-confirm-button"]`, `[data-testid="action-reject-button"]` | `src/components/shared/buttons/conversation-confirmation-buttons.tsx` | "Confirm action" / "Reject action"; the card asks "Do you want to continue with this action?" and marks risky actions "High Risk" |
| `[data-testid="error-message-banner"]` + `-header` / `-content` | `src/components/features/chat/error-message-banner.tsx` | site-level banner; text is matched against rate-limit and re-auth vocabularies |
| (no test id) `.text-danger` label | `src/components/features/chat/error-message.tsx` | in-turn agent error events; only the visible label is read |
| `[data-testid="archived-conversation-banner"]` | `chat-interface.tsx` | read-only conversation → `CONVERSATION_ARCHIVED` |
| `[data-testid="conversation-name-title"]` | `src/components/features/conversation/*` | header name shown in the panel's agent bar |

## Routes

`src/routes.ts`: `/` (launcher with a composer), `/conversations` (list — *no* composer on the live site is
handled by `checkChat`), `/conversations/:id` and `/conversations/:id/panel` (same conversation; the `/panel`
suffix is stripped by `samePage()`), `/settings/*`, `/automations`, `/mcp`, `/skills` (no chat → `WRONG_PAGE`),
`/login`, `/oauth/device/verify` (→ `SIGN_IN_REQUIRED`), `/shared/conversations/:id` (read-only → `WRONG_PAGE`).

## Limits that come from the site

* Attachments: 3 MB per file and 3 MB combined (`src/utils/file-validation.ts`), `accept="*/*"`, `multiple`.
* Composer: 30,000 characters (the panel enforces the same budget and says so when a paste is cut).
* Enter submits, Shift+Enter breaks a line, IME composition is never interrupted
  (`src/hooks/chat/use-chat-input-events.ts`) — the panel's textarea uses identical rules.
