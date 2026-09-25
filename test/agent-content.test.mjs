import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// The content script runs in Chrome's isolated world. Here it is loaded into a jsdom window with a fake
// chrome API and a scripted page adapter, which is enough to exercise the connection handover, the
// exactly-once rules for Send and Confirm, and the scan scheduler.
const source = readFileSync(new URL('../agent-content.js', import.meta.url), 'utf8');
const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function makePort(name = 'oh-side-panel-v1') {
  const listeners = { message: [], disconnect: [] };
  const port = {
    name, sender: { id: 'test-extension' }, posted: [], disconnected: false, dead: false,
    onMessage: { addListener: fn => listeners.message.push(fn) },
    onDisconnect: { addListener: fn => listeners.disconnect.push(fn) },
    postMessage(message) { if (port.dead || port.disconnected) throw new Error('Attempting to use a disconnected port object'); port.posted.push(message); },
    disconnect() { if (!port.disconnected) { port.disconnected = true; listeners.disconnect.forEach(fn => fn()); } },
    emit(message) { listeners.message.forEach(fn => fn(message)); }
  };
  return port;
}
const sent = types => port => port.posted.filter(message => types.includes(message.type));
// core.js's rule: same origin and path, `/panel` stripped, query and hash ignored.
const pathOf = url => { try { return new URL(url).pathname.replace(/\/panel\/?$/, '/'); } catch { return ''; } };
const sameConversation = (a, b) => !!a && !!b && pathOf(a) === pathOf(b);

// A scripted stand-in for agent-dom.js: every read returns what the test says the page shows.
function makeDOM(script) {
  class DomError extends Error { constructor(code, message) { super(message); this.code = code; this.name = 'DomError'; } }
  return {
    version: '1.0.0', DomError,
    fail: (code, message) => { throw new DomError(code, message); },
    samePage: (a, b) => script.samePage !== false && sameConversation(a, b),
    pageKind: () => 'conversation',
    conversationId: () => 'abc',
    checkBlocks: () => { script.blocked?.(); },
    securityNotice: () => script.security || '',
    rows: () => script.rows || [],
    signature: row => `${row.user ? 'u' : 'a'}:${row.text}`,
    pendingRows: () => script.pending || [],
    running: () => !!script.running,
    awaitingConfirmation: () => !!script.confirmation,
    confirmationCard: () => script.confirmation || null,
    composer: () => script.composerEl,
    composerText: () => script.draft || '',
    writeComposer: (field, text) => { script.writes = (script.writes || 0) + 1; script.draft = text; },
    sendButton: () => script.sendButton,
    enabled: button => !!button && (button === script.sendButton ? script.sendEnabled !== false : button.disabled !== true),
    uploadsFor: () => ({ kind: 'input', input: script.fileInput || {} }),
    stageRequestFor: () => ({ token: script.token || '11111111-2222-4333-8444-555555555555', accept: '*/*', multiple: true }),
    siteState: () => script.state || { kind: 'ready', running: false },
    publicState: state => state,
    inspectControls: () => ({
      inputKind: 'contenteditable', uploadKind: 'input', fileInputCount: 1, status: 'Ready', statusKind: 'ready',
      busy: false, confirmationPending: false, conversationId: 'abc', conversationName: 'Test conversation',
      pageKind: 'conversation', controls: { canStop: false, canResume: false }
    }),
    preflight: () => ({ list: script.rows || [], field: script.composerEl }),
    capabilities: () => ({ pageKind: 'conversation', checks: { composer: true, send: true } }),
    promptMatches: (tx, text) => typeof text === 'string' && text.trim() === String(tx?.prompt || '').trim(),
    matchTurn: () => { script.scans = (script.scans || 0) + 1; return script.match || { accepted: false, state: script.state || null }; },
    locateTurn: () => script.locate || { row: null },
    historyTurns: () => ({ turns: script.history || [], truncated: false }),
    historyCount: () => (script.rows || []).filter(row => row.user).length,
    stopButton: () => script.stopButton || null,
    resumeButton: () => script.resumeButton || null
  };
}

function open(script = {}, { adapter = true } = {}) {
  script.composerEl ??= { isConnected: true, nodeName: 'DIV' }; // the composer element the send path anchors on
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.all-hands.dev/conversations/abc', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  if (!window.crypto?.randomUUID) window.crypto.randomUUID = () => '00000000-0000-4000-8000-000000000000';
  const connectListeners = [];
  const sentMessages = [];
  window.chrome = {
    runtime: {
      id: 'test-extension',
      onConnect: { addListener: fn => connectListeners.push(fn) },
      sendMessage: async message => { sentMessages.push(message); return script.worker?.(message) ?? { ok: true, value: true }; }
    }
  };
  // `adapter: false` is the sibling-file failure: agent-dom.js never loaded beside agent-content.js.
  window.OpenHandsSideDOM = adapter ? makeDOM(script) : null;
  window.OpenHandsSideAttachments = { ATTACHMENT_POLICY: { maxFiles: 8, maxBytes: 3 * 1024 * 1024 }, bytesToBase64: () => '' };
  window.eval(source);
  return {
    window, script, sentMessages, connectListeners,
    connect(port = makePort()) { connectListeners.at(-1)(port); return port; },
    close() { window.__OH_SIDE_REGISTRATION__?.dispose?.(); window.close(); }
  };
}
const requestId = () => crypto.randomUUID();

test('the content script registers once and a second injection cannot stack listeners', () => {
  const page = open();
  try {
    assert.equal(page.connectListeners.length, 1);
    assert.equal(page.window.__OH_SIDE_REGISTRATION__.version, '1.0.0');
    assert.equal(page.window.__OH_SIDE_REGISTRATION__.isAlive(), true);
    page.window.eval(source);
    assert.equal(page.connectListeners.length, 1);
  } finally { page.close(); }
});

test('a missing DOM layer reports ADAPTER_MISSING and stays inert', () => {
  // The sibling file never loaded beside agent-content.js (or loaded for another version).
  const page = open({}, { adapter: false });
  try {
    assert.equal(page.window.__OH_SIDE_REGISTRATION__, undefined, 'no transaction machinery is installed');
    const port = page.connect();
    assert.equal(port.posted[0].type, 'ERROR');
    assert.equal(port.posted[0].code, 'ADAPTER_MISSING');
    assert.equal(port.posted[0].clicked, false);
    assert.match(port.posted[0].message, /Nothing was typed or clicked/);
    assert.equal(port.disconnected, true);
    // A send request is never even read: the inert listener is the only one there is.
    port.emit({ type: 'SEND', requestId: requestId(), prompt: 'hi', url: 'https://app.all-hands.dev/conversations/abc' });
    assert.equal(port.posted.length, 1);
  } finally { page.close(); }
});

test('PROBE answers READY with the adapter version and page facts', async () => {
  const page = open();
  try {
    const port = page.connect();
    port.emit({ type: 'PROBE' });
    await sleep(30);
    const ready = sent(['READY'])(port).at(-1);
    assert.equal(ready.adapterVersion, '1.0.0');
    assert.equal(ready.inputKind, 'contenteditable');
    assert.equal(ready.uploadKind, 'input');
    assert.equal(ready.conversationName, 'Test conversation');
    assert.equal(typeof ready.documentId, 'string');
  } finally { page.close(); }
});

test('a live second panel is refused, but a dead one is taken over', async () => {
  const page = open();
  try {
    const first = page.connect();
    const second = makePort();
    page.connect(second);
    assert.equal(second.posted[0].code, 'TAB_IN_USE');
    assert.equal(second.disconnected, true);
    first.dead = true; // Chrome would throw on the next postMessage: the panel is gone
    const third = makePort();
    page.connect(third);
    third.emit({ type: 'PROBE' });
    await sleep(20);
    assert.equal(sent(['READY'])(third).length, 1);
  } finally { page.close(); }
});

test('a send is typed once, clicked once, and never resent for the same request id', async () => {
  const script = { sendButton: { clicks: 0, click() { this.clicks++; } }, sendEnabled: true };
  const page = open(script);
  try {
    const port = page.connect();
    const id = requestId();
    port.emit({ type: 'SEND', requestId: id, prompt: 'fix the tests', url: 'https://app.all-hands.dev/conversations/abc' });
    await sleep(250);
    assert.equal(script.writes, 1);
    assert.equal(script.draft, 'fix the tests'); // typed through the adapter, into the site's own box
    assert.equal(script.sendButton.clicks, 1);
    assert.equal(sent(['SENDING'])(port).length, 1);
    // While the turn is in flight a second request is refused as BUSY, without touching the page.
    port.emit({ type: 'SEND', requestId: requestId(), prompt: 'again', url: 'https://app.all-hands.dev/conversations/abc' });
    await sleep(30);
    assert.equal(sent(['ERROR'])(port).at(-1).code, 'BUSY');
    assert.equal(script.writes, 1);
    assert.equal(script.sendButton.clicks, 1);
    // The request id stays consumed after the turn ends: a panel retry can never cause a second send.
    port.emit({ type: 'CANCEL', requestId: id });
    await sleep(30);
    port.emit({ type: 'SEND', requestId: id, prompt: 'fix the tests', url: 'https://app.all-hands.dev/conversations/abc' });
    await sleep(30);
    assert.equal(sent(['ERROR'])(port).at(-1).code, 'DUPLICATE_REQUEST');
    assert.equal(script.writes, 1);
    assert.equal(script.sendButton.clicks, 1);
  } finally { page.close(); }
});

test('a send whose Send control never enables is refused without a click', async () => {
  const script = { sendButton: { clicks: 0, click() { this.clicks++; } }, sendEnabled: false };
  const page = open(script);
  try {
    const port = page.connect();
    port.emit({ type: 'SEND', requestId: requestId(), prompt: 'hello', url: 'https://app.all-hands.dev/conversations/abc' });
    await sleep(4300); // the enable budget is 4 s
    const failure = sent(['ERROR'])(port).at(-1);
    assert.equal(failure.code, 'SEND_UNAVAILABLE');
    assert.equal(failure.clicked, false);
    assert.equal(script.sendButton.clicks, 0);
    assert.equal(script.writes, 1); // the text was typed, and the message says so
  } finally { page.close(); }
});

test('completion requires the same turn to stay settled', async () => {
  const script = { sendButton: { click() {} }, sendEnabled: true };
  const page = open(script);
  try {
    const port = page.connect();
    const id = requestId();
    port.emit({ type: 'SEND', requestId: id, prompt: 'fix the tests', url: 'https://app.all-hands.dev/conversations/abc' });
    await sleep(40);
    script.match = {
      accepted: true, userId: 'u1', userEl: {}, complete: true, text: 'All green.', rich: null,
      steps: [], messageCount: 1, liveText: 'All green.', state: { kind: 'done', status: 'Done' }
    };
    await sleep(2400); // both the finished text and the idle state must hold for 1.2 s
    const done = sent(['COMPLETE'])(port).at(-1);
    assert.equal(done.requestId, id);
    assert.equal(done.text, 'All green.');
    assert.equal(done.userMessageId, 'u1');
  } finally { page.close(); }
});

test('a confirmation can be answered once per card, in one direction', async () => {
  const confirm = { clicks: 0, click() { this.clicks++; } };
  const reject = { clicks: 0, click() { this.clicks++; } };
  const script = {
    sendButton: { click() {} }, sendEnabled: true,
    confirmation: { confirm, reject, prompt: 'Do you want to continue with this action?', highRisk: true, ready: true }
  };
  const page = open(script);
  try {
    const port = page.connect();
    port.emit({ type: 'CONFIRM', accept: true });
    await sleep(60);
    assert.equal(confirm.clicks, 1);
    assert.equal(reject.clicks, 0);
    assert.equal(sent(['CONFIRM_SENT'])(port).at(-1).accept, true);
    // The card is still up (the page has not applied it): a second answer must not click again.
    port.emit({ type: 'CONFIRM', accept: false });
    await sleep(40);
    assert.equal(confirm.clicks, 1);
    assert.equal(reject.clicks, 0);
    assert.equal(sent(['CONFIRM_ERROR'])(port).at(-1).code, 'CONFIRM_ALREADY_ANSWERED');
  } finally { page.close(); }
});

test('stopping and resuming the agent are single clicks on the site controls', async () => {
  const stop = { clicks: 0, click() { this.clicks++; } };
  const script = { stopButton: stop };
  const page = open(script);
  try {
    const port = page.connect();
    port.emit({ type: 'CONTROL', control: 'stop' });
    await sleep(60);
    assert.equal(stop.clicks, 1);
    assert.equal(sent(['CONTROL_SENT'])(port).at(-1).control, 'stop');
    script.stopButton = null; // OpenHands drops the Stop control once it takes effect
    await sleep(200);
    assert.equal(sent(['CONTROL_ERROR'])(port).length, 0);
    script.resumeButton = { clicks: 0, click() { this.clicks++; } };
    port.emit({ type: 'CONTROL', control: 'resume' });
    await sleep(60);
    assert.equal(script.resumeButton.clicks, 1);
    script.resumeButton = null;
    await sleep(200);
    port.emit({ type: 'CONTROL', control: 'sideways' });
    await sleep(20);
    assert.equal(sent(['CONTROL_ERROR'])(port).at(-1).code, 'INVALID_CONTROL');
  } finally { page.close(); }
});

test('cancelling stops tracking and clears the transaction', async () => {
  const script = { sendButton: { click() {} }, sendEnabled: true };
  const page = open(script);
  try {
    const port = page.connect();
    const id = requestId();
    port.emit({ type: 'SEND', requestId: id, prompt: 'hello', url: 'https://app.all-hands.dev/conversations/abc' });
    await sleep(40);
    port.emit({ type: 'CANCEL', requestId: id });
    await sleep(20);
    assert.equal(sent(['CANCELLED'])(port).at(-1).requestId, id);
    const before = script.scans || 0;
    await sleep(400);
    assert.ok((script.scans || 0) - before <= 1, 'scanning stops once the transaction is gone');
  } finally { page.close(); }
});

test('a security notice holds an in-flight turn and resumes by itself', async () => {
  const script = { sendButton: { clicks: 0, click() { this.clicks++; } }, sendEnabled: true, security: 'Verify you are human' };
  const page = open(script);
  try {
    const port = page.connect();
    const id = requestId();
    port.emit({ type: 'SEND', requestId: id, prompt: 'hello', url: 'https://app.all-hands.dev/conversations/abc' });
    await sleep(400);
    // A verification before the click is a hold: nothing is typed into, nothing is clicked, no error yet.
    assert.equal(sent(['BLOCKED'])(port).at(-1).code, 'SECURITY_CHECK');
    assert.equal(sent(['BLOCKED'])(port).at(-1).clicked, false);
    assert.equal(script.writes || 0, 0);
    assert.equal(script.sendButton.clicks, 0);
    assert.equal(sent(['ERROR'])(port).length, 0);
    // It clears on its own and the same request continues: no resend, no new request id.
    script.security = '';
    await sleep(500);
    assert.equal(sent(['SECURITY_CLEARED'])(port).length, 1);
    assert.equal(script.writes, 1);
    assert.equal(script.sendButton.clicks, 1);
    // Mid-turn: the scan loop holds the same way and resumes the same way.
    script.security = 'Verify you are human';
    await sleep(500);
    assert.equal(sent(['BLOCKED'])(port).length, 2);
    assert.equal(sent(['BLOCKED'])(port).at(-1).clicked, true);
    script.security = '';
    await sleep(500);
    assert.equal(sent(['SECURITY_CLEARED'])(port).length, 2);
    assert.equal(script.sendButton.clicks, 1, 'still exactly one click');
  } finally { page.close(); }
});

test('history is read-only and bound to the same page', async () => {
  const script = { history: [{ id: 'u1', prompt: 'hi', replies: [{ id: 'a1', text: 'hello', rich: null }] }] };
  const page = open(script);
  try {
    const port = page.connect();
    port.emit({ type: 'LOAD_HISTORY', requestId: 'h1', url: 'https://app.all-hands.dev/conversations/abc' });
    await sleep(30);
    const history = sent(['HISTORY'])(port).at(-1);
    assert.equal(history.requestId, 'h1');
    assert.equal(history.turns.length, 1);
    port.emit({ type: 'LOAD_HISTORY', requestId: 'h2', url: 'https://app.all-hands.dev/conversations/other' });
    await sleep(30);
    assert.equal(sent(['HISTORY_ERROR'])(port).at(-1).code, 'URL_CHANGED');
  } finally { page.close(); }
});
