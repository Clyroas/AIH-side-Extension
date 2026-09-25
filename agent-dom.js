// The OpenHands page adapter. Runs ONLY in Chrome's isolated extension world on
// https://app.all-hands.dev — no site APIs, no auth access, no network. Every read is bounded and
// every uncertain state is a coded DomError instead of a guess.
//
// Selector provenance (OpenHands frontend v1.24, `All-Hands-AI/OpenHands`):
//   chat-interface / chat-scroll-container   features/chat/chat-interface.tsx
//   agent-message / user-message             features/chat/chat-message.tsx  (`data-testid="${type}-message"`)
//   data-pending-status                      features/chat/chat-message.tsx  ("sending" | "error")
//   chat-message-error / -sending / -expand  features/chat/chat-message.tsx
//   chat-input                               features/chat/components/chat-input-field.tsx (contenteditable)
//   submit-button                            features/chat/chat-send-button.tsx
//   stop-button / play-button                features/chat/chat-stop-button.tsx, chat-play-button.tsx
//   circle-error-icon / agent-loading-spinner features/controls/agent-status.tsx, agent-loading.tsx
//   status label (span[title])               features/controls/agent-status.tsx (getStatusCode)
//   chat-status-indicator                    features/chat/chat-status-indicator.tsx (provisioning)
//   live-activity-chip                       features/chat/typing-indicator.tsx
//   action-confirm-button / action-reject-button  shared/buttons/conversation-confirmation-buttons.tsx
//   error-message-banner(-header/-content)   features/chat/error-message-banner.tsx
//   archived-conversation-banner             features/chat/chat-interface.tsx
//   event-group(-toggle/-content)            conversation-events/chat/event-message-components/event-group.tsx
//   generic-event-message-title              features/chat/generic-event-message.tsx
//   collapsible-thinking(-toggle/-content)   …/event-message-components/collapsible-thinking.tsx
//   markdown-renderer                        features/markdown/markdown-renderer.tsx
//   markdown-file-path-link                  features/chat/chat-markdown-path-code.tsx
//   upload-image-input                       features/chat/components/hidden-file-input.tsx
//   conversation-name-title                  features/conversation/*
(() => {
  'use strict';

  const VERSION = '1.0.0';
  const ORIGIN = 'https://app.all-hands.dev';

  const T = Object.freeze({
    interface: '[data-testid="chat-interface"]',
    scroll: '[data-testid="chat-scroll-container"]',
    agentRow: 'article[data-testid="agent-message"]',
    userRow: 'article[data-testid="user-message"]',
    markdown: '[data-testid="markdown-renderer"]',
    composer: '[data-testid="chat-input"]',
    submit: 'button[data-testid="submit-button"]',
    stop: 'button[data-testid="stop-button"]',
    play: 'button[data-testid="play-button"]',
    errorIcon: '[data-testid="circle-error-icon"]',
    spinner: '[data-testid="agent-loading-spinner"]',
    provisioning: '[data-testid="chat-status-indicator"]',
    activity: '[data-testid="live-activity-chip"]',
    confirm: '[data-testid="action-confirm-button"]',
    reject: '[data-testid="action-reject-button"]',
    banner: '[data-testid="error-message-banner"]',
    bannerHeader: '[data-testid="error-message-banner-header"]',
    bannerContent: '[data-testid="error-message-banner-content"]',
    archived: '[data-testid="archived-conversation-banner"]',
    chatBox: '[data-testid="interactive-chat-box"]',
    fileInput: 'input[data-testid="upload-image-input"]',
    group: '[data-testid="event-group"]',
    groupToggle: '[data-testid="event-group-toggle"]',
    groupSpinner: '[data-testid="spinner-icon"]',
    eventTitle: '[data-testid="generic-event-message-title"]',
    thinking: '[data-testid="collapsible-thinking"]',
    thinkingToggle: '[data-testid="collapsible-thinking-toggle"]',
    conversationName: '[data-testid="conversation-name-title"]',
    sendFailed: '[data-testid="chat-message-error"]',
    sending: '[data-testid="chat-message-sending"]',
    expand: '[data-testid="chat-message-expand"]',
    pathLink: 'button[data-testid="markdown-file-path-link"]',
    scrollBottom: '[data-testid="scroll-to-bottom"]'
  });

  // Agent error events are the one row kind OpenHands renders without a test id
  // (features/chat/error-message.tsx): a bold danger-coloured label plus an expand toggle.
  const DANGER = '.text-danger, .fill-danger';

  const normalize = text => String(text ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // Whitespace-insensitive form, for comparing what the site shows with what the panel typed.
  const squash = text => normalize(text).replace(/\s+/g, ' ');
  const textOf = el => normalize(el ? (el.innerText ?? el.textContent ?? '') : '');

  class DomError extends Error {
    constructor(code, message) { super(message); this.code = code; this.name = 'DomError'; }
  }
  const fail = (code, message) => { throw new DomError(code, message); };

  function hash(text) {
    let h = 0x811c9dc5;
    const value = String(text || '');
    for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  }

  // Layout-aware visibility. `opacity: 0` counts as hidden because OpenHands fades its transient
  // "Done" status out before removing it, and a faded control is not a control you can read.
  function visible(el) {
    if (!el || !el.isConnected) return false;
    if (el.nodeType === 1 && el.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    const win = el.ownerDocument?.defaultView || globalThis;
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
      const style = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(node) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) return false;
    }
    return typeof el.getClientRects !== 'function' || el.getClientRects().length > 0;
  }
  const anyVisible = (selector, doc = document) => [...doc.querySelectorAll(selector)].some(visible);
  const firstVisible = (selector, doc = document) => [...doc.querySelectorAll(selector)].find(visible) || null;

  // ---- page identity -------------------------------------------------------------------------
  const loc = (doc = document) => (doc.defaultView || globalThis).location;

  function pageKind(doc = document) {
    const path = loc(doc).pathname;
    if (/^\/(?:login|oauth\/device\/verify)/.test(path)) return 'login';
    if (/^\/shared\//.test(path)) return 'shared';
    if (/^\/conversations\/[^/?#]+/.test(path)) return 'conversation';
    if (/^\/(?:conversations\/?)?$/.test(path)) return 'home';
    return 'other';
  }
  function conversationId(doc = document) {
    const match = /^\/conversations\/([^/?#]+)/.exec(loc(doc).pathname);
    return match ? decodeURIComponent(match[1]) : '';
  }
  function conversationName(doc = document) {
    const el = firstVisible(T.conversationName, doc);
    return el ? textOf(el).slice(0, 160) : '';
  }
  // Same conversation, ignoring the `/panel` suffix OpenHands adds when you open its right-hand panel
  // and any query/hash. Mirrors core.js samePage() exactly; test/parity.test.mjs pins the two.
  function samePage(a, b) {
    if (a === b) return true;
    try {
      const x = new URL(a), y = new URL(b);
      if (x.origin !== y.origin) return false;
      const key = u => u.pathname.replace(/\/+$/, '').replace(/\/panel$/, '') || '/';
      return key(x) === key(y);
    } catch { return false; }
  }

  // ---- agent status --------------------------------------------------------------------------
  // The site prints one localized word next to its Stop/Play control. The vocabulary is its own
  // translation table (Running, Ready, Done, User needed, Stopped, Error, Agent error, Disconnected,
  // Connecting, Starting, Waiting, Adding git hooks, Adding skills); anything else is `unknown`.
  const STATUS_KINDS = [
    [/^running$/i, 'running'],
    [/^ready$/i, 'ready'],
    [/^done$/i, 'done'],
    [/^user needed$/i, 'user-needed'],
    [/^stopped$/i, 'stopped'],
    [/^(?:error|agent error)$/i, 'error'],
    [/^disconnected$/i, 'disconnected'],
    [/^connecting$/i, 'connecting'],
    [/^(?:starting|starting conversation|waiting|waiting for sandbox|adding git hooks|adding skills)$/i, 'starting']
  ];
  function statusKind(label) {
    const text = String(label || '').trim();
    if (!text) return 'none';
    for (const [pattern, kind] of STATUS_KINDS) if (pattern.test(text)) return kind;
    return 'unknown';
  }
  function isBusyKind(kind) { return kind === 'running' || kind === 'starting'; }

  // AgentStatus renders `<div><span title="STATUS">STATUS</span><div>icon</div></div>`; the icon is
  // the only part with a test id, so the label is found by climbing from it. The whole component
  // unmounts ~1.5 s after "Done"/"Ready", so an empty label is normal on an idle conversation.
  function statusText(doc = document) {
    for (const selector of [T.stop, T.play, T.errorIcon, T.spinner]) {
      const icon = firstVisible(selector, doc);
      if (!icon) continue;
      for (let node = icon, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
        const span = [...node.querySelectorAll('span[title]')].find(visible);
        if (span) return normalize(span.getAttribute('title') || span.textContent).slice(0, 80);
      }
    }
    const chip = firstVisible(T.provisioning, doc);
    return chip ? textOf(chip).slice(0, 80) : '';
  }

  // ---- transcript rows -----------------------------------------------------------------------
  function transcript(doc = document) {
    return doc.querySelector(T.scroll) || doc.querySelector(T.interface) || doc.body;
  }
  // One row = one chat bubble. `agent-message` articles are only produced by message, streaming-delta
  // and finish events — all of which are event-group breakers — so a rendered row never disappears
  // into a collapsed "N actions completed" group. Tool cards do, which is why they are read as steps
  // (turnSteps) and never as reply rows.
  function messageRows(doc = document, { pending = false } = {}) {
    const scope = transcript(doc);
    if (!scope) return [];
    return [...scope.querySelectorAll(`${T.agentRow},${T.userRow}`)].filter(el => {
      if (!visible(el)) return false;
      const status = el.getAttribute('data-pending-status');
      return pending ? !!status : !status;
    });
  }
  function rowText(row) {
    const blocks = [...row.querySelectorAll(T.markdown)].filter(el => visible(el) && !el.closest('button'));
    if (blocks.length) return normalize(blocks.map(el => textOf(el)).join('\n\n'));
    // A bubble without a markdown renderer (older layouts, plain text) still has exactly one text body.
    const clone = row.cloneNode(true);
    clone.querySelectorAll('button,svg,[aria-hidden="true"]').forEach(node => node.remove());
    return normalize(clone.textContent);
  }
  // Rows are identified by content + turn position, never by element identity or absolute index:
  // OpenHands streams text into a growing bubble, swaps a streaming row for the final message row,
  // and prepends older events when you scroll up. All three move positions; none change what your
  // message said or what came before it.
  function rows(doc = document) {
    const list = messageRows(doc);
    let turn = 0, index = -1; // agent rows are numbered from 0 within their turn
    return list.map(el => {
      const user = el.matches(T.userRow);
      if (user) { turn++; index = -1; } else index++;
      const text = rowText(el);
      return { el, user, text, turn, id: user ? `u${turn}-${hash(text)}` : `a${turn}-${index}` };
    });
  }
  function signature(row) { return `${row.user ? 'u' : 'a'}:${hash(row.text.slice(0, 4000))}`; }

  // The optimistic queue the site draws before the server echoes your message back. It is evidence
  // about a send ("Sending…", "Failed to send"), never a transcript row.
  function pendingRows(doc = document) {
    return messageRows(doc, { pending: true }).map(el => ({
      el,
      user: el.matches(T.userRow),
      status: el.getAttribute('data-pending-status'),
      text: rowText(el),
      failed: !!el.parentElement?.querySelector(T.sendFailed) || el.getAttribute('data-pending-status') === 'error'
    }));
  }

  // Turn region: the top-level blocks OpenHands rendered after your message. Used for steps, agent
  // error events and the confirmation card, all of which are siblings of the bubbles rather than
  // children of one.
  function topAncestor(el, container) {
    for (let node = el; node && node !== container; node = node.parentElement)
      if (node.parentElement === container) return node;
    return null;
  }
  function turnRegion(userEl, doc = document) {
    const container = transcript(doc);
    if (!container || !userEl?.isConnected) return [];
    const kids = [...container.children];
    const anchor = topAncestor(userEl, container);
    const at = anchor ? kids.indexOf(anchor) : kids.findIndex(kid => kid.contains(userEl));
    return at < 0 ? [] : kids.slice(at + 1);
  }

  // ---- live activity -------------------------------------------------------------------------
  const STEP_CAP = 80;
  function turnSteps(region) {
    const steps = [];
    for (const node of region) {
      const owners = node.matches(`${T.group},${T.thinking}`) ? [node] : [...node.querySelectorAll(`${T.group},${T.thinking}`)];
      // A standalone action title (not folded into a group) is its own step.
      for (const el of node.matches(T.eventTitle) ? [node] : node.querySelectorAll(T.eventTitle)) {
        if (el.closest(`${T.group},${T.thinking}`)) continue;
        const label = textOf(el.querySelector('span') || el).slice(0, 200);
        if (label) steps.push({ kind: 'action', label, state: 'activity' });
      }
      for (const owner of owners) {
        if (!visible(owner)) continue;
        if (owner.matches(T.thinking)) {
          steps.push({ kind: 'thinking', label: 'Thinking', state: 'activity', expanded: owner.querySelector(T.thinkingToggle)?.getAttribute('aria-expanded') === 'true' });
          continue;
        }
        const toggle = owner.querySelector(T.groupToggle);
        const label = textOf(toggle || owner).slice(0, 200);
        if (!label) continue;
        steps.push({
          kind: 'group',
          label,
          state: owner.querySelector(T.groupSpinner) ? 'activity' : 'done',
          expanded: toggle?.getAttribute('aria-expanded') === 'true'
        });
      }
    }
    return steps.slice(-STEP_CAP);
  }
  // The chip above the composer names what the agent is doing right now ("Reading …", "Running …").
  function liveActivity(doc = document) {
    const chip = firstVisible(T.activity, doc);
    return chip ? textOf(chip).slice(0, 200) : '';
  }
  // Agent error events (features/chat/error-message.tsx). Only the visible label is read; the details
  // stay collapsed and are never expanded by this extension.
  function errorEvents(region) {
    const found = [];
    for (const node of region) {
      for (const el of node.querySelectorAll(DANGER)) {
        if (!visible(el) || el.closest('button,svg')) continue;
        const label = textOf(el).slice(0, 300);
        if (label) found.push(label);
      }
      if (node.matches(DANGER) && visible(node)) found.push(textOf(node).slice(0, 300));
    }
    return [...new Set(found)].slice(0, 8);
  }

  // ---- blocks --------------------------------------------------------------------------------
  // A security verification (captcha / "verify you are human") is transient: the user clears it in the
  // tab and the page returns to normal. It is therefore observable separately from the hard blocks in
  // checkBlocks(), so the capture loop can pause and resume instead of stopping the turn.
  const SECURITY_TEXT = /captcha|verify (?:that )?you(?: are|'re) human|are you a robot|verification required|security (?:check|verification)|unusual traffic|checking your browser|attention required|cloudflare/i;
  const SECURITY_FRAME = /recaptcha.*\/bframe|hcaptcha.*challenge|challenges\.cloudflare\.com|turnstile/i;
  function securityNotice(doc = document) {
    for (const el of doc.querySelectorAll('[role="alert"],[role="dialog"],h1,h2,[data-sonner-toast]')) {
      if (!visible(el)) continue;
      if (SECURITY_TEXT.test(textOf(el).slice(0, 2000))) return 'OpenHands is showing a security verification.';
    }
    for (const frame of doc.querySelectorAll('iframe')) {
      const src = frame.getAttribute('src') || '';
      if (SECURITY_FRAME.test(src) && visible(frame)) return 'OpenHands is showing a security verification.';
    }
    return ''; // a signed-out /login page is a hard block in checkBlocks(), not a transient hold
  }
  function bannerText(doc = document) {
    const banner = firstVisible(T.banner, doc);
    if (!banner) return null;
    const header = textOf(banner.querySelector(T.bannerHeader)).slice(0, 200);
    const body = textOf(banner.querySelector(T.bannerContent)).slice(0, 600);
    return { el: banner, header, body, text: [header, body].filter(Boolean).join(' — ') };
  }
  const RATE_LIMIT = /rate limit|too many requests|quota|usage limit|limit reached|credits? (?:exhausted|run out)|insufficient (?:credits|balance)|429/i;
  const AUTH_TEXT = /sign in|log in|login required|unauthorized|authentication|credentials|session expired|re-?authenticate/i;
  // Hard stops: checked before anything is typed or clicked. A security verification is NOT here — it
  // is transient and handled by securityNotice()/holdForSecurity() in agent-content.js.
  function checkBlocks(doc = document) {
    if (loc(doc).origin !== ORIGIN) fail('WRONG_PAGE', 'Only https://app.all-hands.dev is supported.');
    const kind = pageKind(doc);
    if (kind === 'login')
      fail('SIGN_IN_REQUIRED', 'OpenHands is asking you to sign in. Sign in normally in the OpenHands tab (GitHub, GitLab or Bitbucket), then reconnect. Credentials are never entered or read by this extension.');
    if (kind === 'shared')
      fail('WRONG_PAGE', 'This is a shared, read-only conversation view. Open your own conversation in OpenHands and reconnect.');
    if (kind === 'other')
      fail('WRONG_PAGE', 'This OpenHands page has no chat to drive. Open the launcher or a conversation, then reconnect.');
    if (firstVisible(T.archived, doc))
      fail('CONVERSATION_ARCHIVED', 'OpenHands replaced the message box with a read-only notice for this conversation (archived, or its workspace errored). Start or open another conversation; nothing was typed or clicked.');
    const banner = bannerText(doc);
    if (banner) {
      if (RATE_LIMIT.test(banner.text))
        fail('RATE_LIMIT', `OpenHands is limiting requests: “${banner.text.slice(0, 200)}”. Follow the wait time in the OpenHands tab. No automatic retry was attempted.`);
      if (AUTH_TEXT.test(banner.text))
        fail('SIGN_IN_REQUIRED', `OpenHands needs you to sign in again: “${banner.text.slice(0, 200)}”. Fix it in the OpenHands tab, then reconnect. Nothing was sent.`);
      fail('OPENHANDS_ERROR', `OpenHands displayed an error: “${banner.text.slice(0, 300)}”. Inspect the OpenHands tab before deciding whether to send again. Nothing was retried.`);
    }
    for (const frame of doc.querySelectorAll('iframe')) {
      const src = frame.getAttribute('src') || '';
      if (SECURITY_FRAME.test(src) && visible(frame))
        fail('SECURITY_CHECK', 'A security verification is visible in the OpenHands tab. Complete it yourself there. No retry or bypass was attempted.');
    }
    for (const el of doc.querySelectorAll('[role="alert"],[data-sonner-toast]')) {
      if (!visible(el)) continue;
      const text = textOf(el).slice(0, 1000);
      if (SECURITY_TEXT.test(text))
        fail('SECURITY_CHECK', 'Complete the security verification in the OpenHands tab yourself. No retry or bypass was attempted. Check whether OpenHands accepted your message before sending again.');
      if (RATE_LIMIT.test(text))
        fail('RATE_LIMIT', 'OpenHands is limiting requests. Follow the wait time in the OpenHands tab. No automatic retry was attempted.');
    }
  }
  // The page must be a drivable chat page with a message box before any control is inspected.
  function checkChat(doc = document) {
    checkBlocks(doc);
    const kind = pageKind(doc);
    if (kind !== 'conversation' && kind !== 'home')
      fail('WRONG_PAGE', 'Open the OpenHands launcher or a conversation. This page has no chat to drive.');
  }

  // ---- composer ------------------------------------------------------------------------------
  // The message box is a contenteditable div (features/chat/components/chat-input-field.tsx). React
  // renders `contenteditable="false"` while it is disabled, which is how a disabled composer is told
  // apart from a missing one — the difference matters to the user, so it is reported separately.
  function composer(doc = document) {
    const all = [...doc.querySelectorAll(T.composer)].filter(el => el.isConnected && visible(el));
    const editable = all.filter(el => el.isContentEditable && el.getAttribute('contenteditable') !== 'false' && !el.closest('[inert]'));
    if (!editable.length) {
      if (all.length)
        fail('COMPOSER_UNAVAILABLE', 'OpenHands is showing its message box but it is not editable right now — the agent is waiting for a confirmation, the workspace is still starting, or no model is configured. Resolve it in the OpenHands tab; nothing was typed or clicked.');
      fail('COMPOSER_NOT_FOUND', `No OpenHands message box is ready on this page (${summary(doc)}). Reload the OpenHands tab once it has finished loading, then reconnect.`);
    }
    if (editable.length > 1)
      fail('AMBIGUOUS_COMPOSER', `Found ${editable.length} visible OpenHands message boxes (a modal or a second launcher may be open). Close the extra one in the OpenHands tab; this extension will not guess which to type into.`);
    return editable[0];
  }
  function composerText(field) { return field ? (field.innerText ?? field.textContent ?? '') : ''; }
  // Ancestor that contains the given selector, bounded so a page-wide search can never tie the
  // composer to an unrelated control.
  function ancestorWith(field, selector, depth = 8) {
    for (let node = field.parentElement, step = 0; node && step < depth; node = node.parentElement, step++) {
      if (node.matches?.(selector) || node.querySelector(selector)) return node;
      if (node === field.ownerDocument.body) break;
    }
    return null;
  }
  function sendButton(doc = document, field = composer(doc)) {
    const scope = field.closest(T.chatBox) || ancestorWith(field, T.submit);
    const buttons = scope ? [...scope.querySelectorAll(T.submit)].filter(visible) : [];
    if (buttons.length === 1) return buttons[0];
    if (buttons.length > 1)
      fail('AMBIGUOUS_SEND_BUTTON', `Found ${buttons.length} Send controls around the OpenHands message box. No Send click was attempted.`);
    fail('SEND_BUTTON_NOT_FOUND', `No Send control is associated with the OpenHands message box (${summary(doc)}). No Send click was attempted.`);
  }
  function stopButton(doc = document) { return firstVisible(T.stop, doc); }
  function resumeButton(doc = document) { return firstVisible(T.play, doc); }
  // Which agent-level controls the page currently exposes (Stop while running, Play/Resume while paused).
  // Read-only and non-throwing: the panel decides what to offer, the adapter decides what it may click.
  function agentControls(doc = document) {
    const stop = stopButton(doc), play = resumeButton(doc);
    return { canStop: enabled(stop), canResume: enabled(play), stopVisible: !!stop, resumeVisible: !!play };
  }
  function enabled(button) {
    if (!button || !button.isConnected) return false;
    if (button.disabled || button.getAttribute('aria-disabled') === 'true' || button.closest('[inert]')) return false;
    const win = button.ownerDocument?.defaultView || globalThis;
    const style = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(button) : null;
    return !style || style.pointerEvents !== 'none';
  }
  // OpenHands reads `innerText` of the contenteditable on submit, and enables Send from an `input`
  // event handler. So the text is inserted through Chrome's own editing pipeline (which fires
  // beforeinput/input) and then verified. innerHTML/textContent are never assigned and Enter is never
  // simulated: a site that ignores the insertion must fail loudly instead of sending something else.
  function writeComposer(field, text) {
    if (squash(composerText(field))) fail('DRAFT_EXISTS', 'The OpenHands message box already holds an unsent draft. Send or clear it yourself; the extension will not overwrite it.');
    const doc = field.ownerDocument;
    if (!field.isContentEditable) fail('COMPOSER_UNAVAILABLE', 'The OpenHands message box is not editable. Nothing was typed or clicked.');
    field.focus();
    const selection = doc.getSelection?.();
    if (!selection || typeof doc.execCommand !== 'function')
      fail('RICH_EDITOR_UNSUPPORTED', 'This browser cannot perform a native rich-editor insertion. No Send click was attempted.');
    const range = doc.createRange();
    range.selectNodeContents(field);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = doc.execCommand('insertText', false, text);
    if (!inserted || squash(composerText(field)) !== squash(text))
      fail('RICH_EDITOR_REJECTED', 'The OpenHands message box did not accept the requested text. No Send click was attempted, and no second insertion was tried. Inspect the OpenHands tab.');
  }
  function fileInput(doc = document, field = null) {
    const scope = field ? (field.closest(T.chatBox) || ancestorWith(field, 'input[type="file"]')) : doc;
    const inputs = [...(scope || doc).querySelectorAll(`input[type="file"]${field ? '' : T.fileInput}`)].filter(el => el.isConnected);
    if (!inputs.length) return null;
    // A picker input is routinely display:none on itself; what must not be hidden is its region.
    const laidOut = el => {
      for (let node = el.parentElement; node && node.nodeType === 1; node = node.parentElement) {
        const win = node.ownerDocument?.defaultView || globalThis;
        const style = typeof win.getComputedStyle === 'function' ? win.getComputedStyle(node) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
      }
      return true;
    };
    const usable = inputs.filter(laidOut);
    return usable.length === 1 ? usable[0] : usable.length > 1 ? null : null;
  }
  function uploadsFor(field, doc = document) {
    const input = fileInput(doc, field);
    return { kind: input ? 'input' : anyVisible('button[aria-label*="file" i],button[aria-label*="attach" i]', doc) ? 'button-only' : 'none', input };
  }
  // Marks exactly one verified composer input for the page-context staging helper. The marker is
  // consumed by that helper (or removed on cancel/timeout), so a delayed helper can never reuse it.
  function stageRequestFor(field, doc = document, files = []) {
    const input = fileInput(doc, field);
    if (!input) fail('UPLOAD_UNAVAILABLE', 'OpenHands has no file input tied to its message box that this version can use. Attach the files in the OpenHands tab and send there; nothing was inserted.');
    if (files.length > 1 && !input.multiple) fail('UPLOAD_UNAVAILABLE', 'The OpenHands file input accepts only one file at a time. Send one file, or attach them in the OpenHands tab.');
    const accept = String(input.accept || '');
    if (accept && !accept.split(/[,;\s]+/).filter(Boolean).every(token => /^(?:\*\/\*|file|image\/\*|text\/\*|\.[a-z0-9]+|[a-z0-9.+-]+\/[a-z0-9.+-]+)$/i.test(token)))
      fail('UPLOAD_UNAVAILABLE', `The OpenHands file input has restrictions this version does not recognize (${accept}). Attach the files in the OpenHands tab instead.`);
    const token = crypto.randomUUID();
    input.setAttribute('data-oh-side-stage', token);
    return { token, accept, multiple: !!input.multiple };
  }

  // ---- page state ----------------------------------------------------------------------------
  // "Busy" is deliberately over-inclusive: a Send while the site is starting, reconnecting or running
  // would land in an unknown place, so it is refused instead of attempted.
  function running(doc = document) {
    if (anyVisible(T.stop, doc) || anyVisible(T.spinner, doc) || anyVisible(T.activity, doc)) return true;
    return isBusyKind(statusKind(statusText(doc)));
  }
  function confirmationCard(doc = document) {
    const confirm = firstVisible(T.confirm, doc), reject = firstVisible(T.reject, doc);
    if (!confirm && !reject) return null;
    const holder = (confirm || reject).closest('div.flex, div')?.parentElement || doc.body;
    const prompt = textOf(holder.querySelector('p')) || 'Do you want to continue with this action?';
    return {
      confirm, reject,
      prompt: prompt.slice(0, 300),
      highRisk: /high risk/i.test(textOf(holder).slice(0, 400)),
      ready: !!confirm && !!reject
    };
  }
  function awaitingConfirmation(doc = document) { return !!confirmationCard(doc); }
  function siteState(doc = document) {
    const status = statusText(doc);
    const pending = pendingRows(doc);
    return {
      status,
      kind: statusKind(status),
      running: running(doc),
      confirmation: confirmationCard(doc),
      pending,
      sending: pending.some(row => row.status === 'sending'),
      sendFailed: pending.find(row => row.failed) || null,
      banner: bannerText(doc),
      activity: liveActivity(doc),
      controls: agentControls(doc),
      name: conversationName(doc),
      pageKind: pageKind(doc),
      conversationId: conversationId(doc)
    };
  }
  function summary(doc = document) {
    let upload = 'no file input';
    try {
      const field = composer(doc);
      upload = { input: 'one composer file input', 'button-only': 'an upload button but no usable file input', none: 'no recognizable upload control' }[uploadsFor(field, doc).kind];
    } catch { /* the composer itself is unavailable; report the rest */ }
    return `page ${loc(doc).pathname}, ${messageRows(doc).length} rendered message row(s), ${[...doc.querySelectorAll(T.composer)].length} message box node(s), upload: ${upload}`;
  }
  // Refuse to send into a busy or unresolved conversation. Returns the transcript so the caller can
  // snapshot the baseline in the same instant it verified the page.
  function conversationReady(doc = document) {
    checkChat(doc);
    const state = siteState(doc);
    if (state.kind === 'disconnected')
      fail('SITE_DISCONNECTED', 'OpenHands has lost its connection to the workspace. Let it reconnect in the OpenHands tab, then send again. Nothing was typed or clicked.');
    if (state.confirmation)
      fail('CONFIRMATION_PENDING', 'OpenHands is asking you to confirm or reject an action. Answer it in the panel or in the OpenHands tab first; nothing was typed or clicked.');
    if (state.sendFailed)
      fail('SEND_FAILED', `OpenHands still shows a message that failed to send${state.sendFailed.text ? ` (“${state.sendFailed.text.slice(0, 120)}”)` : ''}. Retry or dismiss it in the OpenHands tab; this extension never resends.`);
    if (state.running)
      fail('AGENT_BUSY', `OpenHands is already working (${state.status || 'agent running'}). Wait for it to finish before sending another message; nothing was typed or clicked.`);
    if (state.kind === 'error')
      fail('OPENHANDS_ERROR', `OpenHands reported an error state (${state.status}). Inspect the OpenHands tab before sending again.`);
    return rows(doc);
  }
  function inspectControls(doc = document) {
    checkChat(doc);
    const field = composer(doc);
    const state = siteState(doc);
    return {
      field,
      button: sendButton(doc, field),
      inputKind: 'contenteditable',
      uploadKind: uploadsFor(field, doc).kind,
      fileInputCount: [...doc.querySelectorAll('input[type="file"]')].filter(el => el.matches(T.fileInput)).length,
      status: state.status,
      statusKind: state.kind,
      busy: state.running,
      confirmationPending: !!state.confirmation,
      controls: agentControls(doc),
      conversationId: state.conversationId,
      conversationName: state.name,
      pageKind: state.pageKind === 'conversation' ? 'conversation' : 'home'
    };
  }
  function preflight(doc = document) {
    const list = conversationReady(doc);
    const field = composer(doc);
    if (squash(composerText(field))) fail('DRAFT_EXISTS', 'OpenHands already has an unsent draft in its message box. Send or clear it yourself; the extension will not overwrite it.');
    sendButton(doc, field); // existence only: an empty message box normally has a disabled Send
    return { list, field };
  }
  // Semantic capability snapshot: which named controls this page currently exposes, using the same
  // primitives the adapter drives. Pure and non-throwing — a diagnostic must never break a usable
  // connection.
  function capabilities(doc = document) {
    const safe = fn => { try { return fn(); } catch { return null; } };
    const field = safe(() => composer(doc));
    return {
      pageKind: safe(() => pageKind(doc)) || 'other',
      conversationId: safe(() => conversationId(doc)) || '',
      status: safe(() => statusText(doc)) || '',
      checks: {
        composer: !!field,
        send: field ? safe(() => !!sendButton(doc, field)) === true : false,
        scrollContainer: !!doc.querySelector(T.scroll),
        transcript: messageRows(doc).length > 0,
        status: !!(safe(() => statusText(doc)) || firstVisible(T.stop, doc) || firstVisible(T.play, doc)),
        confirmation: anyVisible(T.confirm, doc),
        upload: field ? safe(() => uploadsFor(field, doc).kind) === 'input' : false,
        liveActivity: anyVisible(T.activity, doc)
      }
    };
  }

  // ---- prompt attribution --------------------------------------------------------------------
  // OpenHands renders your message as Markdown, so **bold**, list markers, link URLs, code fences and
  // raw HTML-looking tags can disappear or change shape on screen. Compare letters and digits of the
  // raw prompt against those rendered forms; any other wording fails closed.
  const letters = text => String(text).normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
  function promptForms(prompt) {
    const raw = String(prompt).normalize('NFKC');
    const rendered = raw
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/^\s*(?:```|~~~)[^\n]*$/gm, '')
      .replace(/^\s{0,3}(?:[-*+_]|\d{1,9}[.)])\s+/gm, '')
      .replace(/^\s{0,3}(?:#{1,6}|>)\s*/gm, '')
      .replace(/(\*\*|__|\*|_|`)/g, '');
    const untagged = raw.replace(/<\/?[a-zA-Z][\w-]*(?:\s[^<>]*)?\/?>/g, ' ');
    return [...new Set([letters(raw), letters(rendered), letters(untagged)])].filter(Boolean);
  }
  function promptMatches(tx, text) {
    const shown = squash(text), expected = squash(tx.prompt);
    if (!shown) return false;
    if (shown === expected) return true;
    const shownLetters = letters(shown), forms = promptForms(tx.prompt);
    if (forms.includes(shownLetters)) return true;
    // With staged files OpenHands prints its own attachment chip text next to the prompt. Only that
    // short suffix/prefix is tolerated, and only when files were actually staged for this send.
    if (tx.attachmentLabels)
      return forms.some(form => (shownLetters.startsWith(form) || shownLetters.endsWith(form)) && shownLetters.length - form.length <= 200) &&
        shown.length - expected.length <= 200;
    return false;
  }
  function promptDiff(prompt, shown) {
    const a = squash(prompt).slice(0, 160), b = squash(shown).slice(0, 160);
    return ` [Sent: “${a}${squash(prompt).length > 160 ? '…' : ''}”; shown: “${b}${squash(shown).length > 160 ? '…' : ''}”]`;
  }

  // ---- rich text -----------------------------------------------------------------------------
  const RICH_MAX_NODES = 4000, RICH_MAX_CHARS = 200000, RICH_MAX_DEPTH = 30;
  const RICH_TAGS = {
    p: 'p', div: 'div', h1: 'h1', h2: 'h2', h3: 'h3', h4: 'h4', h5: 'h5', h6: 'h6',
    ul: 'ul', ol: 'ol', li: 'li', blockquote: 'blockquote', pre: 'pre', code: 'code',
    strong: 'strong', b: 'strong', em: 'em', i: 'em', del: 'del', s: 'del', a: 'a', hr: 'hr', br: 'br',
    table: 'table', thead: 'thead', tbody: 'tbody', tr: 'tr', th: 'th', td: 'td', figure: 'div', figcaption: 'p'
  };
  const RICH_SKIP = 'script,style,svg,textarea,input,select,canvas,video,audio,iframe,noscript,[aria-hidden="true"],.sr-only';
  function safeHref(value) {
    try {
      const url = new URL(value, ORIGIN + '/');
      return /^(?:https?:|mailto:)$/.test(url.protocol) && !url.username && !url.password ? url.href : '';
    } catch { return ''; }
  }
  function languageOf(el) {
    const name = String(el?.className || '').match(/(?:^|\s)(?:language|lang)-([\w+#.-]{1,30})/);
    return name ? name[1] : (el?.getAttribute?.('data-language') || '');
  }
  function richOf(row) {
    const budget = { nodes: 0, chars: 0 };
    const over = () => budget.nodes > RICH_MAX_NODES || budget.chars > RICH_MAX_CHARS;
    const codeBlock = (el, lang) => {
      const clone = el.cloneNode(true);
      // Copy buttons, line-number gutters and syntax-highlighter chrome are not code.
      clone.querySelectorAll('button,[aria-hidden="true"],.linenumber,.line-number,[data-line-number],.react-syntax-highlighter-line-number').forEach(node => node.remove());
      const text = normalize(clone.textContent).replace(/\n$/, '');
      budget.nodes++; budget.chars += text.length;
      return ['pre', lang ? { lang: lang.slice(0, 30) } : {}, text];
    };
    const walk = (node, depth) => {
      if (over() || depth > RICH_MAX_DEPTH) return [];
      if (node.nodeType === 3) {
        const text = node.nodeValue;
        if (!text) return [];
        budget.nodes++; budget.chars += text.length;
        return [text];
      }
      if (node.nodeType !== 1) return [];
      const el = node, tag = el.tagName.toLowerCase();
      // OpenHands turns workspace file paths into buttons; keep the path as inline code, drop the click.
      if (el.matches(T.pathLink)) { const text = textOf(el); return text ? [['code', {}, text]] : []; }
      if (el.matches(RICH_SKIP)) return [];
      const win = el.ownerDocument?.defaultView;
      const style = win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle(el) : null;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return [];
      if (tag === 'img') { const alt = normalize(el.getAttribute('alt') || ''); return alt ? [`[image: ${alt.slice(0, 200)}]`] : []; }
      if (tag === 'input') return [el.checked ? '☑ ' : '☐ '];
      if (tag === 'pre') return [codeBlock(el, languageOf(el.querySelector('code')) || languageOf(el))];
      if (tag === 'code' && languageOf(el) && !el.closest('pre')) return [codeBlock(el, languageOf(el))];
      const children = [...el.childNodes].flatMap(child => walk(child, depth + 1));
      const mapped = RICH_TAGS[tag];
      if (!mapped) return children; // spans and other inline wrappers are transparent
      budget.nodes++;
      const attrs = {};
      if (mapped === 'a') { const href = safeHref(el.getAttribute('href') || ''); if (!href) return children; attrs.href = href; }
      if (mapped === 'ol') { const start = parseInt(el.getAttribute('start') || '', 10); if (start > 1 && start < 1e6) attrs.start = start; }
      if (mapped === 'code' && !children.length) return [];
      return [[mapped, attrs, ...children]];
    };
    const bodies = [...row.querySelectorAll(T.markdown)].filter(el => visible(el) && !el.closest('button'));
    const sources = bodies.length ? bodies : [row];
    // One `div` node per rendered body, so a row with several markdown renderers stays a valid tree
    // instead of concatenating two roots into one malformed node.
    const blocks = sources.map(el => ['div', {}, ...[...el.childNodes].flatMap(child => walk(child, 1))]);
    return over() || !blocks.some(block => block.length > 2) ? null : blocks;
  }

  // ---- turn matching -------------------------------------------------------------------------
  const LIVE_RICH_MS = 500;
  const MAX_TURN_ROWS = 400, MAX_LIVE_CHARS = 200000;

  function baselineMatches(tx, before) {
    const want = Array.isArray(tx.baseline) ? tx.baseline : [];
    if (!want.length) return true;
    if (before.length < want.length) return false;
    const tail = before.slice(before.length - want.length);
    return tail.every((row, index) => signature(row) === want[index]);
  }
  function rowSummary(list, total) {
    const kinds = list.slice(0, 8).map(row => (row.user ? 'you' : `agent(${row.text.length} chars)`));
    return ` [Seen: ${kinds.join(' · ') || 'nothing'}${list.length > 8 ? ' …' : ''}; ${total} row(s) rendered]`;
  }
  // Locate the row OpenHands drew for this prompt. Content + preceding-context matching (not element
  // identity, not absolute position) survives streaming re-renders, the streaming→final row swap and
  // older events being prepended when you scroll up.
  function locateTurn(tx, doc) {
    const list = rows(doc);
    const matches = list.filter(row => row.user && promptMatches(tx, row.text));
    for (let i = matches.length - 1; i >= 0; i--) {
      const index = list.indexOf(matches[i]);
      if (baselineMatches(tx, list.slice(0, index))) return { list, row: matches[i], index };
    }
    return { list, row: null, index: -1, unmatched: matches.length };
  }

  function matchTurn(tx, doc = document) {
    checkChat(doc);
    const state = siteState(doc);
    const { list, row: userRow, index, unmatched } = locateTurn(tx, doc);

    // A message that OpenHands itself reports as failed to send is a hard stop: the site offers Retry,
    // and this extension never resends.
    if (!userRow) {
      const failed = state.sendFailed;
      if (failed && promptMatches(tx, failed.text))
        fail('SEND_FAILED', `OpenHands reported “Failed to send” for this message. Nothing was retried. Use Retry in the OpenHands tab if you want it sent again.`);
    }
    if (!userRow) {
      if (unmatched)
        fail('CONVERSATION_CHANGED', `OpenHands is showing your message, but not after the ${Array.isArray(tx.baseline) ? tx.baseline.length : 0} row(s) that preceded it when you sent. Capture stopped rather than follow an unrelated reply.${rowSummary(list, list.length)}`);
      return { accepted: false, pending: state.pending.map(item => ({ status: item.status, text: item.text.slice(0, 200) })), state: publicState(state) };
    }
    if (tx.userId && tx.userId !== userRow.id && tx.userEl && tx.userEl !== userRow.el && !tx.userEl?.isConnected)
      fail('CONVERSATION_CHANGED', 'The row OpenHands drew for your message was replaced by a different one. Capture stopped.');

    const added = list.slice(index + 1);
    if (added.length > MAX_TURN_ROWS)
      fail('TURN_TOO_LARGE', `This turn has more than ${MAX_TURN_ROWS} rendered messages. Read it in OpenHands instead.`);
    if (added.some(row => row.user))
      fail('AMBIGUOUS_TURN', `Another message appeared after yours in the OpenHands tab (typed there, or sent by something else). Capture stopped rather than attribute the wrong reply.${rowSummary(added, list.length)}`);

    const region = turnRegion(userRow.el, doc);
    const steps = turnSteps(region);
    const errors = errorEvents(region);
    if (errors.length)
      fail('OPENHANDS_ERROR', `OpenHands reported an error inside this turn: “${errors[0].slice(0, 240)}”. Nothing was retried. Read the details in the OpenHands tab.`);

    const texts = added.map(row => row.text).filter(Boolean);
    const liveText = texts.at(-1) || '';
    if (liveText.length > MAX_LIVE_CHARS)
      fail('REPLY_TOO_LARGE', `Live output exceeds ${MAX_LIVE_CHARS} characters. Read it in OpenHands instead.`);
    const confirmation = state.confirmation;
    const busy = state.running || isBusyKind(state.kind) || state.kind === 'connecting' || !!confirmation;

    // Completion is a positive, observable state: your message was drawn, OpenHands produced at least
    // one message for it, and the site has stopped working — with no confirmation card open. The caller
    // additionally requires that this stays true for a settle window, so a momentary re-render between
    // two tool calls can never end a turn early.
    const complete = !!liveText && !busy && state.kind !== 'error';
    const finalRow = complete ? [...added].reverse().find(row => row.text) : null;
    const rich = finalRow ? richOf(finalRow.el) : null;

    // The live preview is formatted too, but rebuilt only when the text changed and at most about twice
    // a second: reading page structure costs more than reading text. The plain text is always sent.
    let liveRich = null;
    if (!complete && liveText) {
      const now = Date.now();
      if (liveText !== tx.liveRichText && (!tx.liveRichAt || now - tx.liveRichAt >= LIVE_RICH_MS)) {
        const last = [...added].reverse().find(row => row.text);
        tx.liveRich = last ? richOf(last.el) : null;
        tx.liveRichText = liveText; tx.liveRichAt = now;
      }
      liveRich = tx.liveRich && tx.liveRichText && liveText.startsWith(tx.liveRichText.slice(0, Math.max(0, tx.liveRichText.length - 200))) ? tx.liveRich : null;
    }

    return {
      accepted: true,
      userId: userRow.id,
      userEl: userRow.el,
      turnIds: added.map(item => item.id),
      messageCount: texts.length,
      steps,
      activity: state.activity,
      thinking: steps.filter(step => step.kind === 'thinking').length,
      generating: busy,
      confirmation: confirmation ? { prompt: confirmation.prompt, highRisk: confirmation.highRisk, ready: confirmation.ready } : null,
      paused: state.kind === 'stopped',
      liveText,
      liveRich,
      fullText: texts.join('\n\n'),
      complete,
      rich,
      text: finalRow ? finalRow.text : '',
      state: publicState(state)
    };
  }
  // The part of the page-state snapshot that crosses the port: labels only, never elements.
  function publicState(state) {
    return {
      status: state.status, kind: state.kind, running: state.running, sending: state.sending,
      activity: state.activity, name: state.name, conversationId: state.conversationId,
      pageKind: state.pageKind, banner: state.banner ? state.banner.text.slice(0, 300) : '',
      // The confirmation card and the agent controls are what let the panel offer an explicit
      // Confirm/Reject and Stop/Resume passthrough while no turn is being tracked.
      confirmation: state.confirmation ? { prompt: state.confirmation.prompt, highRisk: !!state.confirmation.highRisk, ready: !!state.confirmation.ready } : null,
      controls: state.controls || null
    };
  }

  // ---- history -------------------------------------------------------------------------------
  // Read-only import of the turns OpenHands currently has rendered, on explicit request only. Each user
  // row is paired with the agent rows up to the next user row. Nothing is clicked, expanded or scrolled:
  // collapsed action groups stay collapsed, so their hidden detail is never read.
  const HISTORY_MAX_TURNS = 200, HISTORY_MAX_CHARS = 1000000;
  function historyTurns(doc = document) {
    checkChat(doc);
    const list = rows(doc);
    const turns = [];
    let current = null, budget = 0;
    for (const row of list) {
      if (row.user) {
        if (current) turns.push(current);
        current = { id: row.id, prompt: row.text.slice(0, 20000), replies: [], steps: 0 };
        if (turns.length >= HISTORY_MAX_TURNS) break;
        continue;
      }
      if (!current) { current = { id: `a0-${turns.length}`, prompt: '', replies: [], steps: 0, orphan: true }; }
      budget += row.text.length;
      current.replies.push({ id: row.id, text: row.text.slice(0, 100000), rich: budget <= HISTORY_MAX_CHARS ? richOf(row.el) : null });
    }
    if (current) turns.push(current);
    return { turns: turns.slice(-HISTORY_MAX_TURNS), url: loc(doc).href, truncated: turns.length > HISTORY_MAX_TURNS };
  }
  function historyCount(doc = document) { return rows(doc).filter(row => row.user).length; }

  globalThis.OpenHandsSideDOM = {
    version: VERSION, T, DomError, fail, hash, normalize, squash, textOf, visible,
    pageKind, conversationId, conversationName, samePage, statusText, statusKind, isBusyKind,
    securityNotice, bannerText, checkBlocks, checkChat,
    transcript, rows, messageRows, pendingRows, rowText, signature, turnRegion, turnSteps, liveActivity, errorEvents,
    composer, composerText, writeComposer, sendButton, stopButton, resumeButton, agentControls, enabled, fileInput, uploadsFor, stageRequestFor,
    running, confirmationCard, awaitingConfirmation, siteState, summary, conversationReady, inspectControls, preflight, capabilities,
    promptForms, promptMatches, promptDiff, richOf,
    matchTurn, locateTurn, baselineMatches, publicState,
    historyTurns, historyCount
  };
})();
