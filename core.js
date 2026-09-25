// Pure helpers shared by the panel, the service worker and the tests. Nothing here touches the DOM,
// Chrome APIs or the network, so every rule can be unit-tested on its own.

export const VERSION = '1.0.0';
export const SITE_ORIGIN = 'https://app.all-hands.dev';
export const HOME_URL = `${SITE_ORIGIN}/conversations`;
export const PORT_NAME = 'oh-side-panel-v1';

// OpenHands Cloud renders the composer on the launcher routes (`/`, `/conversations`) and inside a
// conversation (`/conversations/<id>`). Every other route (settings, automations, MCP, skills, the
// shared-conversation view) has no chat to drive.
export function isOpenHands(url) {
  try { return new URL(url).origin === SITE_ORIGIN; } catch { return false; }
}

export function conversationId(url) {
  try {
    const match = /^\/conversations\/([^/?#]+)/.exec(new URL(url).pathname);
    return match ? decodeURIComponent(match[1]) : '';
  } catch { return ''; }
}

// `chat` = a page this extension can drive, `login` = signed out, `other` = a non-chat app route.
export function pageKindOf(url) {
  if (!isOpenHands(url)) return 'other';
  try {
    const path = new URL(url).pathname;
    if (/^\/(?:login|oauth\/device\/verify)/.test(path)) return 'login';
    if (/^\/shared\//.test(path)) return 'shared';
    if (/^\/conversations\/[^/?#]+/.test(path)) return 'chat';
    if (/^\/(?:conversations\/?)?$/.test(path)) return 'chat';
    return 'other';
  } catch { return 'other'; }
}

export function isChatUrl(url) { return pageKindOf(url) === 'chat'; }

// Same conversation, ignoring the parts of the address OpenHands rewrites while you work:
//   · the `/panel` suffix (toggling the right-hand panel changes the URL, not the conversation)
//   · query string and hash (filters, anchors, React Router state)
// A different conversation id is always a different page, so a reply can never be attributed to the
// wrong task.
export function samePage(a, b) {
  if (a === b) return true;
  try {
    const x = new URL(a), y = new URL(b);
    if (x.origin !== y.origin) return false;
    const key = u => u.pathname.replace(/\/+$/, '').replace(/\/panel$/, '') || '/';
    return key(x) === key(y);
  } catch { return false; }
}

export function tabLabel(tab) {
  let address = '';
  try { const url = new URL(tab.url); address = url.host + url.pathname; } catch { /* no URL exposed */ }
  return `Tab ${tab.id} · ${tab.title || 'OpenHands'} · ${address}`;
}

// The status label OpenHands prints next to its Stop/Play control (`AgentStatus`). The vocabulary
// comes from the site's own translation table, so it is matched exactly and anything new is reported
// as `unknown` rather than guessed.
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

export function statusKind(label) {
  const text = String(label || '').trim();
  if (!text) return 'none';
  for (const [pattern, kind] of STATUS_KINDS) if (pattern.test(text)) return kind;
  return 'unknown';
}

// Kinds that mean "the site is busy, do not send and do not declare a reply finished".
export function isBusyKind(kind) { return kind === 'running' || kind === 'starting'; }

export function describeStatusKind(kind) {
  switch (kind) {
    case 'running': return 'OpenHands says the agent is running.';
    case 'starting': return 'The workspace is still starting.';
    case 'connecting': return 'OpenHands is reconnecting to the workspace.';
    case 'disconnected': return 'OpenHands lost its connection to the workspace.';
    case 'user-needed': return 'OpenHands is waiting for you to confirm an action.';
    case 'stopped': return 'The agent is paused or stopped.';
    case 'error': return 'OpenHands reported an error.';
    case 'done': return 'The agent finished.';
    case 'ready': return 'The agent is ready for a task.';
    case 'none': return 'OpenHands is not showing a status.';
    default: return `OpenHands shows an unrecognized status (${kind}).`;
  }
}

// Human-readable summary of the semantic capability snapshot the page adapter reports (see
// agent-dom.js capabilities()). `drift` is true only when a snapshot was reported AND a control the
// adapter cannot send without is missing — the signal that OpenHands' markup moved. Only the composer
// and its Send control qualify: a brand-new conversation legitimately has no transcript rows yet, and
// confirmations, error banners and the upload input are all transient or optional.
const CAPABILITY_LABELS = [
  ['composer', 'message box', true],
  ['send', 'Send control', true],
  ['transcript', 'transcript rows', false],
  ['scrollContainer', 'chat scroll container', true],
  ['status', 'agent status label', false],
  ['confirmation', 'action confirmation buttons', false],
  ['upload', 'composer file input', false],
  ['liveActivity', 'live activity chip', false]
];

export function capabilitySummary(capabilities) {
  const checks = capabilities?.checks;
  if (!checks || typeof checks !== 'object')
    return { reported: false, text: 'OpenHands capability check not reported.', drift: false, missing: [], required: [] };
  const missing = CAPABILITY_LABELS.filter(([key]) => !checks[key]).map(([, label]) => label);
  const required = CAPABILITY_LABELS.filter(([key, , needed]) => !checks[key] && needed).map(([, label]) => label);
  const where = capabilities.pageKind === 'home' ? 'launcher' : capabilities.conversationId ? 'conversation' : 'page';
  if (!missing.length)
    return { reported: true, text: `OpenHands ${where} layout: every expected control is present.`, drift: false, missing: [], required: [] };
  return {
    reported: true,
    text: required.length
      ? `The OpenHands ${where} layout is missing: ${missing.join(', ')}. The site may have changed; verify the OpenHands tab.`
      : `Core chat is available; OpenHands is not currently showing: ${missing.join(', ')}.`,
    drift: required.length > 0,
    missing,
    required
  };
}

// Chrome extension messaging settles on its own in normal operation, but a service worker that is
// terminated (or replaced by an extension update) while a request is in flight can leave the response
// promise pending forever. Every panel request is therefore bounded: a caller always gets either a
// result or an error, so a stuck request can never leave the panel permanently busy.
export class TimeoutError extends Error {
  constructor(message) { super(message); this.name = 'TimeoutError'; this.code = 'TIMEOUT'; }
}

export function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(message)), ms);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

// Short, stable identifiers. The panel generates request ids with crypto.randomUUID(); this is only
// used to check them, so both sides agree on one shape.
export function isRequestId(value) { return typeof value === 'string' && /^[\da-f-]{36}$/i.test(value); }
