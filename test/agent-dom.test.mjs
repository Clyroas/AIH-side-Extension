import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// The adapter is a classic script for Chrome's isolated world. It is loaded into a jsdom window that
// stands in for a rendered OpenHands page: jsdom has no layout engine, so getClientRects is polyfilled to
// report a box, which is what `visible()` asks for.
const source = readFileSync(new URL('../agent-dom.js', import.meta.url), 'utf8');

const CHAT = url => `
  <div data-testid="chat-interface">
    <div data-testid="chat-scroll-container" id="scroll">${url || ''}</div>
    <div data-testid="interactive-chat-box">
      <div data-testid="chat-input" contenteditable="true" role="textbox"></div>
      <button data-testid="submit-button" type="button">Send</button>
    </div>
  </div>`;
const USER = text => `<article data-testid="user-message"><div data-testid="markdown-renderer">${text}</div></article>`;
const AGENT = text => `<article data-testid="agent-message"><div data-testid="markdown-renderer">${text}</div></article>`;
const STATUS = label => `<div class="flex"><button data-testid="stop-button" type="button">Stop</button><span title="${label}">${label}</span></div>`;

function open(html = '', url = 'https://app.all-hands.dev/conversations/abc-1') {
  const dom = new JSDOM(`<!doctype html><html><body>${html || CHAT()}</body></html>`, { url, pretendToBeVisual: true, runScripts: 'outside-only' });
  const { window } = dom;
  // jsdom has no layout engine and no editing support; both are what `visible()` and `composer()` ask for.
  window.HTMLElement.prototype.getClientRects = function rect() { return [{ x: 0, y: 0, width: 8, height: 8, top: 0, left: 0, bottom: 8, right: 8 }]; };
  Object.defineProperty(window.HTMLElement.prototype, 'isContentEditable', {
    configurable: true,
    get() { const value = this.getAttribute('contenteditable'); return value !== null && value !== 'false'; }
  });
  window.eval(source);
  return { window, D: window.OpenHandsSideDOM, document: window.document };
}
const code = fn => { try { fn(); return ''; } catch (error) { return error.code || error.message; } };

test('rows come back in page order with turn positions and content ids', () => {
  const page = open(CHAT(`${USER('fix the tests')}<div data-testid="event-group"><button data-testid="event-group-toggle">3 actions completed</button></div>${AGENT('done')}${USER('and again')}${AGENT('ok')}`));
  const rows = page.D.rows();
  assert.deepEqual([...rows.map(row => row.user)], [true, false, true, false]);
  assert.deepEqual([...rows.map(row => row.turn)], [1, 1, 2, 2]);
  assert.equal(rows[0].text, 'fix the tests');
  assert.match(rows[0].id, /^u1-/);
  assert.equal(rows[1].id, 'a1-0');
  assert.equal(rows[3].id, 'a2-0');
  assert.notEqual(page.D.signature(rows[0]), page.D.signature(rows[2]));
});

test('pending rows are evidence, never transcript rows', () => {
  const page = open(CHAT(`${USER('hello')}${USER('queued')}<article data-testid="user-message" data-pending-status="sending"><div data-testid="chat-message-sending">Sending…</div>queued</article>`));
  assert.equal(page.D.rows().length, 2); // the optimistic bubble is not a row
  const pending = page.D.pendingRows();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, 'sending');
  page.document.querySelector('[data-pending-status]').setAttribute('data-pending-status', 'error');
  page.document.querySelector('[data-pending-status]').insertAdjacentHTML('beforeend', '<div data-testid="chat-message-error">Failed to send</div>');
  assert.equal(page.D.pendingRows()[0].failed, true);
});

test('prompt matching tolerates markdown rendering but nothing else', () => {
  const page = open();
  const tx = { prompt: 'Fix **the** tests\n- item one\n- item two\nsee [docs](https://example.com)' };
  assert.equal(page.D.promptMatches(tx, 'Fix **the** tests\n- item one\n- item two\nsee [docs](https://example.com)'), true);
  assert.equal(page.D.promptMatches(tx, 'Fix the tests item one item two see docs'), true);
  assert.equal(page.D.promptMatches(tx, 'Fix the tests'), false);
  assert.equal(page.D.promptMatches(tx, ''), false);
  const withFiles = { prompt: 'explain this', attachmentLabels: true };
  assert.equal(page.D.promptMatches(withFiles, 'explain this pytest-output.txt (1 KB)'), true);
  assert.equal(page.D.promptMatches({ prompt: 'explain this' }, 'explain this pytest-output.txt (1 KB)'), false);
});

test('a turn is accepted only after OpenHands drew the message, and complete only once it stops', () => {
  const tx = { prompt: 'fix the tests', baseline: [] };
  const page = open(CHAT());
  assert.equal(page.D.matchTurn(tx).accepted, false); // nothing drawn yet

  page.document.getElementById('scroll').innerHTML = `${USER('fix the tests')}${STATUS('Running')}`;
  const waiting = page.D.matchTurn(tx);
  assert.equal(waiting.accepted, true);
  assert.equal(waiting.complete, false);
  assert.equal(waiting.state.kind, 'running');

  page.document.getElementById('scroll').innerHTML = `${USER('fix the tests')}${AGENT('All green now.')}`;
  const done = page.D.matchTurn(tx);
  assert.equal(done.accepted, true);
  assert.equal(done.complete, true);
  assert.equal(done.text, 'All green now.');
  assert.equal(done.messageCount, 1);
});

test('a second user message after ours stops capture instead of misattributing', () => {
  const page = open(CHAT(`${USER('fix the tests')}${AGENT('working…')}${USER('someone else typed')}`));
  assert.match(code(() => page.D.matchTurn({ prompt: 'fix the tests', baseline: [] })), /^AMBIGUOUS_TURN$/);
});

test('baseline mismatch is a conversation change, even when the text matches', () => {
  const page = open(CHAT(`${AGENT('unrelated earlier reply')}${USER('fix the tests')}${AGENT('done')}`));
  const tx = { prompt: 'fix the tests', baseline: ['u:does-not-match'] };
  assert.match(code(() => page.D.matchTurn(tx)), /^CONVERSATION_CHANGED$/);
});

test('hard blocks stop everything with a coded reason', () => {
  const login = open(CHAT(), 'https://app.all-hands.dev/login');
  assert.match(code(() => login.D.checkBlocks()), /^SIGN_IN_REQUIRED$/);
  const shared = open(CHAT(), 'https://app.all-hands.dev/shared/conversations/abc');
  assert.match(code(() => shared.D.checkBlocks()), /^WRONG_PAGE$/);
  const settings = open(CHAT(), 'https://app.all-hands.dev/settings/llm');
  assert.match(code(() => settings.D.checkBlocks()), /^WRONG_PAGE$/);
  const offsite = open(CHAT(), 'https://example.com/');
  assert.match(code(() => offsite.D.checkBlocks()), /^WRONG_PAGE$/);

  const archived = open(`${CHAT()}<div data-testid="archived-conversation-banner">This conversation is archived</div>`);
  assert.match(code(() => archived.D.checkBlocks()), /^CONVERSATION_ARCHIVED$/);

  const limited = open(`${CHAT()}<div data-testid="error-message-banner"><span data-testid="error-message-banner-header">Rate limit reached</span><span data-testid="error-message-banner-content">Too many requests. Try again in 10 minutes.</span></div>`);
  assert.match(code(() => limited.D.checkBlocks()), /^RATE_LIMIT$/);

  const reauth = open(`${CHAT()}<div data-testid="error-message-banner"><span data-testid="error-message-banner-content">Your session expired. Please sign in again.</span></div>`);
  assert.match(code(() => reauth.D.checkBlocks()), /^SIGN_IN_REQUIRED$/);
});

test('a security verification is transient: seen by securityNotice, not by checkBlocks', () => {
  const page = open(`${CHAT()}<div role="alert">Please verify that you are human to continue.</div>`);
  // A live send preflight refuses to type into a page behind a verification…
  assert.match(code(() => page.D.checkBlocks()), /^SECURITY_CHECK$/);
  // …while an in-flight turn reads the same notice as a transient hold, so tracking can pause and resume.
  assert.match(page.D.securityNotice(), /security verification/);
  page.document.querySelector('[role="alert"]').remove();
  assert.equal(page.D.securityNotice(), '');
});

test('the confirmation card exposes exactly its two controls and the risk level', () => {
  const page = open(CHAT(`${USER('go')}${STATUS('User needed')}<div><p>Do you want to continue with this action?</p><p>High Risk Review carefully before proceeding.</p><button data-testid="action-confirm-button">Confirm action</button><button data-testid="action-reject-button">Reject action</button></div>`));
  const card = page.D.confirmationCard();
  assert.ok(card.confirm && card.reject);
  assert.equal(card.ready, true);
  assert.equal(card.highRisk, true);
  assert.match(card.prompt, /continue with this action/);
  assert.equal(page.D.awaitingConfirmation(), true);
  const state = page.D.siteState();
  assert.equal(state.confirmation.highRisk, true);
  assert.equal(state.kind, 'user-needed'); // no status label but a card is up
});

test('agent controls report only what is visible and usable', () => {
  const running = open(CHAT(`${STATUS('Running')}`));
  assert.deepEqual({ ...running.D.agentControls() }, { canStop: true, canResume: false, stopVisible: true, resumeVisible: false });
  const stopped = open(CHAT('<div><button data-testid="play-button">Resume</button><span title="Stopped">Stopped</span></div>'));
  assert.deepEqual({ ...stopped.D.agentControls() }, { canStop: false, canResume: true, stopVisible: false, resumeVisible: true });
  const idle = open(CHAT());
  assert.deepEqual({ ...idle.D.agentControls() }, { canStop: false, canResume: false, stopVisible: false, resumeVisible: false });
  const disabled = open(CHAT('<button data-testid="stop-button" disabled>Stop</button>'));
  assert.equal(disabled.D.agentControls().canStop, false);
});

test('the composer is written through the native editing pipeline or fails closed', () => {
  const page = open();
  const field = page.D.composer();
  assert.ok(field);
  // jsdom implements neither execCommand nor selections the way Chrome does, and the adapter must say so
  // instead of pretending it typed.
  assert.match(code(() => page.D.writeComposer(field, 'hello')), /^(?:RICH_EDITOR_UNSUPPORTED|COMPOSER_UNAVAILABLE)$/);
  field.textContent = 'an unsent draft';
  assert.match(code(() => page.D.writeComposer(field, 'hello')), /^DRAFT_EXISTS$/);
  assert.equal(page.D.sendButton(page.document, field).getAttribute('data-testid'), 'submit-button');
  const missing = open('<div data-testid="interactive-chat-box"><div data-testid="chat-input" contenteditable="true"></div></div>');
  assert.match(code(() => missing.D.sendButton(missing.document, missing.D.composer())), /^SEND_BUTTON_NOT_FOUND$/);
});

test('the upload input is found by the composer it belongs to', () => {
  const page = open(`<div data-testid="chat-interface"><div data-testid="chat-scroll-container"></div><div data-testid="interactive-chat-box"><div data-testid="chat-input" contenteditable="true"></div><input type="file" multiple accept="*/*" data-testid="upload-image-input" class="hidden"><button data-testid="submit-button">Send</button></div></div>`);
  const field = page.D.composer();
  const uploads = page.D.uploadsFor(field);
  assert.equal(uploads.kind, 'input');
  const request = page.D.stageRequestFor(field, page.document, [{ name: 'a.txt' }]);
  assert.match(request.token, /^[\da-f-]{36}$/i);
  assert.equal(page.document.querySelector(`[data-oh-side-stage="${request.token}"]`) !== null, true);
});

test('rich trees keep code blocks with their language and skip chrome', () => {
  const page = open(CHAT(AGENT('<pre class="language-py"><code>print(1)\n</code></pre><p>after <button data-testid="markdown-file-path-link">src/a.py</button></p>')));
  const [row] = page.D.rows().filter(item => !item.user);
  const tree = page.D.richOf(row.el);
  assert.ok(Array.isArray(tree));
  const pre = JSON.stringify(tree);
  assert.match(pre, /"pre"/);
  assert.match(pre, /"lang":"py"/);
  assert.match(pre, /print\(1\)/);
  // The file-path button becomes inline code, never a clickable control in the panel.
  assert.doesNotMatch(pre, /markdown-file-path-link/);
});

test('history import groups agent rows under the user row that caused them', () => {
  const page = open(CHAT(`${USER('one')}${AGENT('reply one')}${AGENT('more one')}${USER('two')}`));
  const snapshot = page.D.historyTurns();
  assert.equal(snapshot.turns.length, 2);
  assert.equal(snapshot.turns[0].replies.length, 2);
  assert.equal(snapshot.turns[1].replies.length, 0);
  assert.equal(page.D.historyCount(), 2);
});

test('the capability snapshot names what the page exposes, without throwing', () => {
  const page = open(CHAT(`${STATUS('Ready')}${USER('hi')}`));
  const caps = page.D.capabilities();
  assert.equal(caps.checks.composer, true);
  assert.equal(caps.checks.send, true);
  assert.equal(caps.checks.transcript, true);
  assert.equal(caps.checks.upload, false);
  assert.equal(caps.pageKind, 'conversation');
  assert.equal(caps.conversationId, 'abc-1');
  const broken = open('<div>nothing here</div>', 'https://app.all-hands.dev/conversations/abc-1');
  const empty = broken.D.capabilities();
  assert.equal(empty.checks.composer, false);
  assert.equal(empty.checks.send, false);
});

test('preflight refuses to type over a draft or into a busy conversation', () => {
  const busy = open(CHAT(`${STATUS('Running')}`));
  assert.match(code(() => busy.D.preflight()), /^AGENT_BUSY$/);
  const draft = open();
  draft.D.composer().textContent = 'half written';
  assert.match(code(() => draft.D.preflight()), /^DRAFT_EXISTS$/);
  const ok = open();
  assert.equal(Array.isArray(ok.D.preflight().list), true);
});
