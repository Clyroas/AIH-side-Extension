import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// End-to-end for the panel half: the real panel.html markup, the real panel.js (and with it agent-client,
// conversation-view, live-view, rich-view and live-status) against a fake service worker and a fake
// OpenHands port. No extension, no tab and no network are involved; the events the fake emits are exactly
// the ones agent-content.js sends.
const html = readFileSync(new URL('../panel.html', import.meta.url), 'utf8');
const markup = html.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '').replace(/<script[\s\S]*?<\/script>/g, '');

const dom = new JSDOM(`<!doctype html><html><body>${markup}</body></html>`, {
  url: 'https://extension.test/panel.html', pretendToBeVisual: true
});
const { window } = dom;
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.requestAnimationFrame = cb => window.requestAnimationFrame(cb);
globalThis.cancelAnimationFrame = cb => window.cancelAnimationFrame(cb);

// jsdom implements <dialog> as an element but not its modal API; Chrome has both. The polyfill keeps the
// panel's exactly-one-dialog rule observable in tests.
if (!window.HTMLDialogElement.prototype.showModal) {
  window.HTMLDialogElement.prototype.showModal = function showModal() { this.open = true; };
  window.HTMLDialogElement.prototype.close = function close() { this.open = false; };
}
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const until = async (predicate, tries = 120) => { for (let i = 0; i < tries; i++) { if (predicate()) return true; await sleep(25); } return false; };
const $ = id => window.document.getElementById(id);

const SITE = 'https://app.all-hands.dev';
const tab = { id: 1, windowId: 1, title: 'Fix the checkout tests · OpenHands', url: `${SITE}/conversations/abc`, discarded: false, status: 'complete' };
const siteState = () => ({
  status: 'Ready', kind: 'ready', running: false, sending: false, activity: '', name: 'Fix the checkout tests',
  conversationId: 'abc', pageKind: 'conversation', banner: '', confirmation: null,
  controls: { canStop: false, canResume: false, stopVisible: false, resumeVisible: false }
});

// ---- fake port & worker ----------------------------------------------------------------------
const inbound = [];
let panelHandler = null;
const port = {
  name: 'oh-side-panel-v1',
  onMessage: { addListener: fn => { panelHandler = fn; } },
  onDisconnect: { addListener: () => {} },
  postMessage(message) { inbound.push(message); respond(message); },
  disconnect() {}
};
function emit(event) { panelHandler?.({ documentId: 'doc', adapterVersion: '1.0.0', ...event }); }
function emitReady() {
  emit({
    type: 'READY', url: tab.url, inputKind: 'contenteditable', uploadKind: 'input', fileInputCount: 1,
    historyCount: 2, status: 'Ready', statusKind: 'ready', busy: false, confirmationPending: false,
    conversationId: 'abc', conversationName: 'Fix the checkout tests', pageKind: 'conversation',
    capabilities: { pageKind: 'conversation', conversationId: 'abc', status: 'Ready', checks: { composer: true, send: true, scrollContainer: true, transcript: true, status: true, confirmation: false, upload: true, liveActivity: false } },
    state: siteState(), blocked: ''
  });
}
function respond(message) {
  switch (message?.type) {
    case 'PROBE': emitReady(); break;
    case 'PING': emit({ type: 'PONG', url: tab.url, state: siteState(), busy: false, historyCount: 2 }); break;
    case 'SITE': emit({ type: 'SITE_INFO', url: tab.url, state: siteState(), busy: false, historyCount: 2 }); break;
    case 'SEND': script.onSend?.(message); break;
    case 'CONFIRM': script.onConfirm?.(message); break;
    case 'CONTROL': script.onControl?.(message); break;
    case 'LOAD_HISTORY':
      emit({ type: 'HISTORY', requestId: message.requestId, url: tab.url, truncated: false, turns: [{ id: 'u1', prompt: 'clone it', replies: [{ id: 'a1', text: 'cloned', rich: null }] }] });
      break;
    case 'CANCEL': emit({ type: 'CANCELLED', requestId: message.requestId }); break;
    default: break;
  }
}
const script = {};
const worker = {
  LIST_TABS: () => ({ ok: true, value: [tab] }),
  GET_TAB: () => ({ ok: true, value: tab }),
  FOCUS_TAB: () => ({ ok: true, value: tab }),
  ATTACH: () => ({ ok: true, value: { documentId: 'doc', url: tab.url } }),
  STAGE_GRANT: () => ({ ok: true, value: true }),
  STAGE_REVOKE: () => ({ ok: true, value: true }),
  OPEN_SITE: () => ({ ok: true, value: { id: 2, url: `${SITE}/` } })
};
globalThis.chrome = {
  runtime: { id: 'test-extension', lastError: undefined, sendMessage: async message => worker[message?.type]?.(message) ?? { ok: true, value: true } },
  tabs: {
    connect: () => port,
    get: async () => tab,
    update: async () => ({}),
    query: async () => [tab],
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    onRemoved: { addListener: () => {}, removeListener: () => {} }
  },
  permissions: { contains: async () => true },
  windows: { get: async () => ({ id: 1, state: 'normal' }), update: async () => ({}) }
};

test.after(() => { window.close(); }); // jsdom's animation loop would otherwise keep the process alive
await import('../panel.js');
await until(() => $('tabs').value === '1');

test('the panel opens on the connection sheet and lists the OpenHands tab', () => {
  assert.equal($('settings-sheet').dataset.open, 'true');
  assert.equal($('tabs').options.length, 1);
  assert.match($('tabs').options[0].textContent, /Fix the checkout tests/);
  assert.equal($('connect').disabled, true); // both confirmations are still unchecked
});

test('connect verifies the adapter and reports the page facts', async () => {
  $('confirmed').checked = true;
  $('authorize').checked = true;
  $('confirmed').dispatchEvent(new window.Event('change'));
  assert.equal($('connect').disabled, false);
  $('connect').click();
  assert.ok(await until(() => $('connected').hidden === false), 'the fake tab never connected');
  assert.equal($('status').textContent, 'Ready');
  assert.equal($('agent-bar').hidden, false);
  assert.match($('site-name').textContent, /Fix the checkout tests/);
  assert.match($('adapter-state').textContent, /page adapter v1\.0\.0 verified/);
  assert.match($('adapter-state').textContent, /composer file input ready/);
  assert.equal($('settings-sheet').dataset.open, 'false');
  assert.equal($('prompt').disabled, false);
  assert.equal($('load-history').disabled, false);
});

test('read-only history import adds turns and never touches the page beyond the request', async () => {
  $('load-history').click();
  assert.ok(await until(() => $('history').querySelectorAll('article.turn').length === 1));
  const article = $('history').querySelector('article.turn');
  assert.equal(article.classList.contains('imported'), true);
  assert.equal(article.querySelector('.bubble.user').textContent, 'clone it');
  assert.equal(article.querySelector('.bubble.assistant').textContent, 'cloned');
  assert.match($('history-import-note').textContent, /1 imported/);
});

test('a send is one click: prompt, ACCEPTED, live text, then the final reply', async () => {
  const seen = [];
  script.onSend = message => { seen.push(message); emit({ type: 'SENDING', requestId: message.requestId, inputKind: 'contenteditable' }); };
  $('prompt').value = 'fix the failing checkout tests';
  $('prompt').dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal($('prepare').disabled, false);
  $('prepare').click();
  assert.ok(await until(() => seen.length === 1), 'the panel never posted SEND');
  assert.equal(seen[0].prompt, 'fix the failing checkout tests');
  assert.match(seen[0].requestId, /^[\da-f-]{36}$/i);
  assert.equal($('prompt').value, ''); // the draft leaves the box the moment it is handed over
  assert.ok(await until(() => $('pending').hidden === false));

  const requestId = seen[0].requestId;
  emit({ type: 'ACCEPTED', requestId, userMessageId: 'u3-x' });
  await until(() => $('status').textContent === 'Waiting for OpenHands');
  emit({
    type: 'LIVE_UPDATE', requestId, text: 'Pinning actions/checkout@v4…', rich: null, generating: true,
    steps: [{ kind: 'group', label: 'Read 2 files', state: 'done' }], activity: 'Editing ci/checkout.yml',
    thinking: 0, confirmation: null, pending: [], messageCount: 1, state: { ...siteState(), status: 'Running', kind: 'running', running: true }, accepted: true
  });
  // Every turn carries a live view; the streamed text must be in the one that is in flight.
  const liveOf = () => [...$('history').querySelectorAll('article.turn')].at(-1);
  assert.ok(await until(() => liveOf().querySelector('.live-text')?.textContent.includes('Pinning actions/checkout@v4')));
  assert.match(liveOf().querySelector('.step-activity').textContent, /Read 2 files/);

  emit({
    type: 'COMPLETE', requestId, userMessageId: 'u3-x', text: 'Done: the checkout job is pinned to v4 and green.',
    rich: [['div', {}, ['p', {}, 'Done: the checkout job is pinned to ', ['code', {}, 'v4'], ' and green.']]],
    fullText: 'Done: the checkout job is pinned to v4 and green.', steps: [], messageCount: 1,
    url: tab.url, conversationId: 'abc', status: 'Done'
  });
  assert.ok(await until(() => $('pending').hidden === true));
  const bubbles = $('history').querySelectorAll('.bubble.assistant');
  const last = bubbles[bubbles.length - 1];
  assert.match(last.textContent, /pinned to v4 and green/);
  assert.equal(last.querySelector('code').textContent, 'v4');
  assert.match($('notice-text').textContent, /Reply received automatically/);
  assert.equal($('status').textContent, 'Ready');
});

test('a coded failure without a Send click restores the draft and keeps the files', async () => {
  script.onSend = message => emit({
    type: 'ERROR', requestId: message.requestId, code: 'AGENT_BUSY', clicked: false, accepted: false,
    message: 'OpenHands is already working (Running). Wait for it to finish before sending another message; nothing was typed or clicked.'
  });
  $('prompt').value = 'while busy';
  $('prompt').dispatchEvent(new window.Event('input', { bubbles: true }));
  $('prepare').click();
  assert.ok(await until(() => $('prompt').value === 'while busy'), 'the draft was not restored');
  assert.match($('notice-text').textContent, /^AGENT_BUSY:/);
  assert.equal($('status').textContent, 'Stopped · check tab');
  // The stopped card stays up with its coded reason until the user dismisses it explicitly…
  assert.equal($('pending').hidden, false);
  assert.equal($('pending').dataset.state, 'error');
  assert.equal($('cancel').textContent, 'Dismiss');
  $('cancel').click();
  assert.ok(await until(() => $('pending').hidden === true));
  assert.equal($('status').textContent, 'Ready');
  // …and the errored turn keeps its reason in the transcript.
  const errored = [...$('history').querySelectorAll('article.turn')].at(-1);
  assert.match(errored.querySelector('.turn-outcome').textContent, /AGENT_BUSY/);
});

test('the idle confirmation bar answers the site card once, through the dialog', async () => {
  const confirms = [];
  script.onConfirm = message => { confirms.push(message); emit({ type: 'CONFIRM_SENT', requestId: null, accept: message.accept }); emit({ type: 'SITE_INFO', url: tab.url, state: { ...siteState(), confirmation: null }, busy: false, historyCount: 3 }); };
  emit({ type: 'SITE_INFO', url: tab.url, state: { ...siteState(), status: 'User needed', kind: 'user-needed', confirmation: { prompt: 'Do you want to continue with this action?', highRisk: false, ready: true } }, busy: false, historyCount: 3 });
  assert.ok(await until(() => $('confirm-bar').hidden === false));
  assert.match($('confirm-bar-prompt').textContent, /continue with this action/);
  $('confirm-bar-yes').click();
  assert.ok(await until(() => $('confirm-dialog').open));
  $('dialog-ok').click();
  assert.ok(await until(() => confirms.length === 1));
  assert.equal(confirms[0].accept, true);
  assert.ok(await until(() => $('confirm-bar').hidden === true));
  assert.match($('notice-text').textContent, /You confirmed the action once/);
});

test('disconnect clears the panel transcript and leaves the conversation alone', async () => {
  $('disconnect').click();
  assert.ok(await until(() => $('confirm-dialog').open), 'disconnect must confirm before clearing');
  $('dialog-ok').click();
  assert.ok(await until(() => $('settings-sheet').dataset.open === 'true'));
  assert.equal($('history').querySelectorAll('article.turn').length, 0);
  assert.equal($('status').textContent, 'Disconnected');
  assert.equal($('agent-bar').hidden, true);
});
