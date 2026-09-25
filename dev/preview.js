// Dev-only motion preview. NOT part of the extension: nothing in manifest.json references this folder.
//
// It loads the real panel.html and panel.css, injects the real panel.js, and answers its Chrome API calls
// with a fake service worker and a fake OpenHands port. Everything on screen is then produced by the
// production code paths — ConversationView, LiveView, live-status, rich-view, the notice and dialog logic —
// so the interface can be judged without an OpenHands account, a network request or a real tab.
//
//   npm run preview        →   http://localhost:8080/dev/preview.html
// (any static server works; file:// does not, because panel.html is fetched)

const wait = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const log = line => {
  const box = document.getElementById('dev-log');
  if (!box) return;
  const row = document.createElement('div');
  row.textContent = line;
  box.append(row);
  while (box.children.length > 6) box.firstElementChild.remove();
  console.info('[preview]', line);
};

const SITE = 'https://app.all-hands.dev';
const URL_CONVERSATION = `${SITE}/conversations/dev-conversation-1`;
const tab = { id: 1, windowId: 1, title: 'Fix the failing checkout tests · OpenHands', url: URL_CONVERSATION, discarded: false, status: 'complete', active: true };
const VERSION = '1.0.0';

// Page state the fake tab reports. Mirrors agent-dom.js publicState() plus the agent controls.
const site = {
  status: 'Ready', kind: 'ready', running: false, sending: false, activity: '', name: 'Fix the failing checkout tests',
  conversationId: 'dev-conversation-1', pageKind: 'conversation', banner: '',
  confirmation: null, controls: { canStop: false, canResume: false, stopVisible: false, resumeVisible: false }
};
const capabilities = {
  pageKind: 'conversation', conversationId: site.conversationId, status: site.status,
  checks: { composer: true, send: true, scrollContainer: true, transcript: true, status: true, confirmation: false, upload: true, liveActivity: false }
};

// ---------- fake OpenHands content-script port ------------------------------------------------
let portHandler = null;
let run = null;
const sent = [];
const usedSends = new Set();

const port = {
  name: 'oh-side-panel-v1',
  posted: [],
  onMessage: { addListener: fn => { portHandler = fn; } },
  onDisconnect: { addListener: () => {} },
  postMessage(message) {
    port.posted.push(message);
    switch (message?.type) {
      case 'PROBE': emitReady(); break;
      case 'PING': emit({ type: 'PONG', url: tab.url, state: { ...site }, busy: !!run, historyCount: 3 }); break;
      case 'SITE': emit({ type: 'SITE_INFO', url: tab.url, state: { ...site }, busy: !!run, historyCount: 3 }); break;
      case 'SEND': sent.push(message); run = { requestId: message.requestId, prompt: message.prompt }; break;
      case 'CONFIRM': run?.confirm?.(message); break;
      case 'CONTROL': run?.control?.(message) ?? controlMessage(message); break;
      case 'LOAD_HISTORY': emitHistory(message.requestId); break;
      case 'WATCH': emit({ type: 'WATCHING', requestId: message.requestId }); break;
      case 'CANCEL': emit({ type: 'CANCELLED', requestId: message.requestId }); run = null; break;
      default: break;
    }
  },
  disconnect() {}
};
function emit(event) { portHandler?.({ documentId: 'dev-document', adapterVersion: VERSION, ...event }); }
function emitReady() {
  emit({
    type: 'READY', url: tab.url, inputKind: 'contenteditable', uploadKind: 'input', fileInputCount: 1,
    historyCount: 3, status: site.status, statusKind: site.kind, busy: site.running,
    confirmationPending: !!site.confirmation, conversationId: site.conversationId, conversationName: site.name,
    pageKind: 'conversation', capabilities, state: { ...site }, blocked: ''
  });
}
// The panel posts SEND only after a worker round-trip when files are staged, so wait for it.
async function nextSend() {
  for (let i = 0; i < 100; i++) {
    const message = sent.find(item => !usedSends.has(item.requestId));
    if (message) { usedSends.add(message.requestId); return message; }
    await wait(50);
  }
  throw new Error('the panel never posted a SEND');
}
function setSite(patch) { Object.assign(site, patch); emit({ type: 'SITE_INFO', url: tab.url, state: { ...site }, busy: !!run, historyCount: 3 }); }
function controlMessage(message) {
  if (message.control === 'stop') { setSite({ status: 'Stopped', kind: 'stopped', running: false, controls: { canStop: false, canResume: true, stopVisible: false, resumeVisible: true } }); emit({ type: 'CONTROL_SENT', control: 'stop', requestId: run?.requestId ?? null }); }
  if (message.control === 'resume') { setSite({ status: 'Running', kind: 'running', running: true, controls: { canStop: true, canResume: false, stopVisible: true, resumeVisible: false } }); emit({ type: 'CONTROL_SENT', control: 'resume', requestId: run?.requestId ?? null }); }
}

// ---------- fake service worker ---------------------------------------------------------------
const worker = {
  VERSION: () => ({ ok: true, value: { version: VERSION, site: SITE } }),
  LIST_TABS: () => ({ ok: true, value: [tab] }),
  GET_TAB: () => ({ ok: true, value: tab }),
  FOCUS_TAB: () => ({ ok: true, value: tab }),
  ATTACH: () => ({ ok: true, value: { documentId: 'dev-document', url: tab.url } }),
  STAGE_GRANT: () => ({ ok: true, value: true }),
  STAGE_REVOKE: () => ({ ok: true, value: true }),
  NAVIGATE_TAB: () => ({ ok: true, value: { windowId: 1, wasMinimized: false, url: tab.url } }),
  RESTORE_TAB: () => ({ ok: true, value: true }),
  OPEN_SITE: () => ({ ok: true, value: { id: 2, url: SITE } })
};

globalThis.chrome = {
  runtime: {
    id: 'dev-preview',
    lastError: undefined,
    getURL: path => new URL(`../${path}`, import.meta.url).href,
    sendMessage: async message => worker[message?.type]?.() ?? { ok: true, value: true }
  },
  tabs: {
    connect: () => port,
    create: async ({ url }) => { window.open(url, '_blank', 'noopener'); return { id: 99 }; },
    get: async () => tab,
    update: async () => ({}),
    query: async () => [tab],
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    onRemoved: { addListener: () => {}, removeListener: () => {} }
  },
  permissions: { contains: async () => true, request: async () => true, remove: async () => true },
  windows: { getCurrent: async () => ({ id: 1, type: 'normal' }), get: async () => ({ id: 1, state: 'normal' }), update: async () => ({}) },
  scripting: { executeScript: async () => [] }
};

// ---------- load the real panel ---------------------------------------------------------------
const panelUrl = new URL('../panel.html', import.meta.url);
const asset = path => new URL(path, panelUrl).href;
document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: asset('../panel.css') }));
document.head.append(Object.assign(document.createElement('base'), { href: new URL('../', panelUrl).href }));

const load = (src, type = '') => new Promise((resolve, reject) => {
  const script = Object.assign(document.createElement('script'), { src, ...(type ? { type } : {}) });
  script.onload = resolve;
  script.onerror = () => reject(new Error(`${src} failed to load`));
  document.body.append(script);
});

async function boot() {
  const response = await fetch(panelUrl);
  if (!response.ok) throw new Error(`panel.html could not be fetched (${response.status}). Serve this folder over http:// (npm run preview), not file://`);
  const markup = await response.text();
  // The body tag carries attributes (<body data-sheet="open">), so match the tag, not a literal string.
  const body = markup.replace(/^[\s\S]*?<body[^>]*>/i, '').replace(/<\/body>[\s\S]*$/i, '');
  if (!body.includes('id="prepare"')) throw new Error('panel.html did not contain the panel markup');
  document.body.insertAdjacentHTML('afterbegin', body.replace(/<script[\s\S]*?<\/script>/g, ''));
  await load(asset('theme.js'));
  await load(asset('customization.js'));
  await load(asset('panel.js'), 'module');
}

function fail(error) {
  console.error('[preview]', error);
  const box = document.getElementById('dev-bar');
  if (box) box.replaceChildren();
  const message = document.createElement('span');
  message.className = 'dev-label';
  message.textContent = `Preview failed: ${error?.message || error}`;
  (box || document.body).append(message);
  const logBox = document.getElementById('dev-log');
  if (logBox) { logBox.style.pointerEvents = 'auto'; logBox.textContent = String(error?.stack || error); }
}

const $ = id => document.getElementById(id);
const until = async (predicate, tries = 120) => { for (let i = 0; i < tries; i++) { if (predicate()) return true; await wait(50); } return false; };

try { await boot(); } catch (error) { fail(error); throw error; }
await until(() => $('tabs').value === '1');
$('confirmed').checked = true;
$('authorize').checked = true;
$('confirmed').dispatchEvent(new Event('change'));
$('connect').click();
if (!await until(() => $('connected').hidden === false)) fail(new Error('the fake tab never connected'));

// ---------- acts ------------------------------------------------------------------------------
// A reply tree in the exact shape agent-dom.js richOf() produces, so rich-view is exercised for real.
const RICH_REPLY = [
  ['div', {},
    ['p', {}, 'The checkout tests were failing because ', ['code', {}, 'ci/checkout.yml'], ' pinned an action that no longer exists.'],
    ['ul', {},
      ['li', {}, ['p', {}, 'Moved the job to ', ['strong', {}, 'actions/checkout@v4'], '.']],
      ['li', {}, ['p', {}, 'Added a ', ['em', {}, 'timeout-minutes'], ' guard so a hung runner fails fast.']]
    ],
    ['pre', { lang: 'diff' }, '- uses: actions/checkout@v3\n+ uses: actions/checkout@v4\n+ timeout-minutes: 10\n'],
    ['p', {}, ['a', { href: 'https://github.com/All-Hands-AI/OpenHands/pull/1' }, 'Pull request #1'], ' is ready for review.']
  ]
];
const STEPS = [
  { kind: 'group', label: 'Read 4 files', state: 'done' },
  { kind: 'action', label: 'Ran pytest -k checkout', state: 'done' },
  { kind: 'thinking', label: 'Thinking', state: 'activity' }
];

async function typePrompt(text) {
  $('prompt').value = text;
  $('prompt').dispatchEvent(new Event('input', { bubbles: true }));
  await until(() => !$('prepare').disabled);
  $('prepare').click();
}
function live(requestId, patch) {
  emit({
    type: 'LIVE_UPDATE', requestId, text: '', rich: null, steps: [], activity: '', thinking: 0,
    generating: true, paused: false, confirmation: null, messageCount: 0, state: { ...site }, accepted: true, ...patch
  });
}
async function accept() { await until(() => $('pending').hidden === false); emit({ type: 'ACCEPTED', requestId: run.requestId, userMessageId: 'u4-dev' }); }
function complete(requestId, text = 'Done — the failing checkout tests are green.', rich = RICH_REPLY) {
  setSite({ status: 'Done', kind: 'done', running: false, activity: '', controls: { canStop: false, canResume: false, stopVisible: false, resumeVisible: false } });
  emit({ type: 'COMPLETE', requestId, userMessageId: 'u4-dev', text, rich, fullText: text, steps: STEPS, messageCount: 2, url: tab.url, conversationId: site.conversationId, status: 'Done' });
  run = null;
}

const acts = {
  async reply() {
    setSite({ status: 'Ready', kind: 'ready', running: false, confirmation: null });
    await typePrompt('Fix the failing checkout tests and open a PR.');
    const message = await nextSend();
    emit({ type: 'SENDING', requestId: message.requestId, inputKind: 'contenteditable' });
    setSite({ status: 'Running', kind: 'running', running: true, controls: { canStop: true, canResume: false, stopVisible: true, resumeVisible: false } });
    await accept();
    const text = 'The checkout tests were failing because ci/checkout.yml pinned an action that no longer exists.';
    for (const size of [18, 46, 82, text.length]) {
      live(message.requestId, { text: text.slice(0, size), generating: size < text.length, activity: size < text.length ? 'Writing a message' : '' });
      await wait(340);
    }
    complete(message.requestId, text);
    log('reply streamed and completed');
  },
  async steps() {
    setSite({ status: 'Ready', kind: 'ready', running: false, confirmation: null });
    await typePrompt('Run the whole test suite and summarise what fails.');
    const message = await nextSend();
    setSite({ status: 'Running', kind: 'running', running: true, activity: 'Running pytest', controls: { canStop: true, canResume: false, stopVisible: true, resumeVisible: false } });
    await accept();
    for (const count of [1, 2, 3]) {
      live(message.requestId, { steps: STEPS.slice(0, count), activity: count < 3 ? 'Running pytest' : '', text: count === 3 ? 'Three of the checkout tests still fail on Python 3.12.' : '' });
      await wait(700);
    }
    complete(message.requestId, 'Three of the checkout tests still fail on Python 3.12; the rest are green.');
    log('action steps rendered');
  },
  async confirm() {
    setSite({ status: 'User needed', kind: 'user-needed', running: true, activity: '' });
    await typePrompt('Delete the stale build artefacts and rerun the release job.');
    const message = await nextSend();
    await accept();
    const card = { prompt: 'Do you want to continue with this action?', highRisk: true, ready: true };
    setSite({ confirmation: card, status: 'User needed', kind: 'user-needed' });
    live(message.requestId, { confirmation: card, steps: STEPS.slice(0, 1), text: '' });
    run.confirm = answer => {
      emit({ type: 'CONFIRM_SENT', requestId: message.requestId, accept: answer.accept });
      setSite({ confirmation: null, status: 'Running', kind: 'running', running: true, activity: 'Running the release job' });
      live(message.requestId, { confirmation: null, text: answer.accept ? 'Removing 12 stale artefacts and rerunning the release job.' : 'Skipping the cleanup as requested.' });
      setTimeout(() => complete(message.requestId, answer.accept ? 'Artefacts removed and the release job reran cleanly.' : 'Cleanup rejected; nothing was deleted.'), 900);
    };
    log('confirmation card shown — click Confirm or Reject in the panel');
  },
  async paused() {
    setSite({ status: 'Ready', kind: 'ready', running: false, confirmation: null });
    await typePrompt('Migrate the fixtures to the new schema.');
    const message = await nextSend();
    await accept();
    setSite({ status: 'Running', kind: 'running', running: true, controls: { canStop: true, canResume: false, stopVisible: true, resumeVisible: false } });
    live(message.requestId, { text: 'Reading the current schema…', steps: STEPS.slice(0, 1) });
    await wait(1200);
    setSite({ status: 'Stopped', kind: 'stopped', running: false, controls: { canStop: false, canResume: true, stopVisible: false, resumeVisible: true } });
    emit({ type: 'PAUSED', requestId: message.requestId, message: 'The OpenHands agent is paused or stopped. Tracking is held; it resumes on its own if you resume the agent in the OpenHands tab.', accepted: true });
    run.control = control => {
      controlMessage(control);
      if (control.control === 'resume') {
        emit({ type: 'RESUMED', requestId: message.requestId, accepted: true });
        live(message.requestId, { text: 'Migrating 38 fixtures…', steps: STEPS.slice(0, 2) });
        setTimeout(() => complete(message.requestId, 'All 38 fixtures migrated; the suite passes.'), 1400);
      }
    };
    log('agent paused — click Resume agent in the panel');
  },
  async security() {
    setSite({ status: 'Ready', kind: 'ready', running: false, confirmation: null });
    await typePrompt('Summarise the last deployment.');
    const message = await nextSend();
    await accept();
    emit({ type: 'BLOCKED', requestId: message.requestId, code: 'SECURITY_CHECK', message: 'OpenHands is showing a security verification.', clicked: true, accepted: true });
    log('verification hold — clears by itself in 4 s');
    await wait(4000);
    emit({ type: 'SECURITY_CLEARED', requestId: message.requestId, clicked: true, accepted: true });
    live(message.requestId, { text: 'The last deployment shipped 41 commits.' });
    await wait(900);
    complete(message.requestId, 'The last deployment shipped 41 commits and rolled back cleanly once.');
  },
  async error() {
    setSite({ status: 'Ready', kind: 'ready', running: false, confirmation: null });
    await typePrompt('Send this while the agent is busy.');
    const message = await nextSend();
    emit({ type: 'SENDING', requestId: message.requestId, inputKind: 'contenteditable' });
    await wait(400);
    emit({
      type: 'ERROR', requestId: message.requestId, code: 'AGENT_BUSY', clicked: false, accepted: false,
      message: 'OpenHands is already working (Running). Wait for it to finish before sending another message; nothing was typed or clicked.'
    });
    run = null;
    log('coded error, draft restored, nothing resent');
  },
  async attach() {
    setSite({ status: 'Ready', kind: 'ready', running: false, confirmation: null });
    const transfer = new DataTransfer();
    transfer.items.add(new File(['checkout: failing on 3.12\n'], 'pytest-output.txt', { type: 'text/plain' }));
    const composer = document.querySelector('.oh-composer');
    composer.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer }));
    await until(() => document.querySelectorAll('.attachment-chip').length === 1);
    log('one file staged (3 MB / 8 files cap, as OpenHands enforces)');
    await typePrompt('Explain this test output.');
    const message = await nextSend();
    emit({ type: 'STAGED', requestId: message.requestId, count: 1 });
    await wait(500);
    await accept();
    live(message.requestId, { text: 'The failure is a Python 3.12 deprecation in the checkout fixture.' });
    await wait(900);
    complete(message.requestId, 'The failure is a Python 3.12 deprecation in the checkout fixture; pinned the action and it passes.');
  },
  async history() {
    emitHistory('dev-history');
    log('earlier turns imported (read-only)');
  }
};
function emitHistory(requestId) {
  emit({
    type: 'HISTORY', requestId, url: tab.url, truncated: false,
    turns: [
      { id: 'u1-dev', prompt: 'Clone the repo and run the tests.', replies: [{ id: 'a1-0', text: 'Cloned. 214 tests ran; 3 failed in the checkout suite.', rich: null }] },
      { id: 'u2-dev', prompt: 'Show me the failing assertion.', replies: [{ id: 'a2-0', text: 'AssertionError: expected ref v4, got v3 in ci/checkout.yml.', rich: null }] },
      { id: 'u3-dev', prompt: 'Any other places pinning v3?', replies: [] }
    ]
  });
}

let acting = null;
async function play(name) {
  if (acting) { log(`already running “${acting}”`); return; }
  acting = name;
  for (const button of document.querySelectorAll('#dev-bar button')) button.dataset.active = String(button.dataset.act === name);
  try { await acts[name](); }
  catch (error) { fail(error); }
  finally { acting = null; }
}
for (const button of document.querySelectorAll('#dev-bar button'))
  button.addEventListener('click', () => { void play(button.dataset.act); });

async function tour() {
  await acts.history();
  await wait(700);
  await acts.reply();
  await wait(1100);
  await acts.steps();
  await wait(1100);
  await acts.attach();
  await wait(1100);
  await acts.confirm();
  await until(() => !$('confirm-bar-yes').disabled || !document.querySelector('.confirm-yes').disabled, 60);
  const target = document.querySelector('.confirm-card .confirm-yes') || $('confirm-bar-yes');
  target.click();
  await until(() => $('dialog-ok') && $('confirm-dialog').open);
  $('dialog-ok').click();
  await wait(2600);
  await acts.paused();
  await until(() => !$('resume-agent').hidden, 60);
  $('resume-agent').click();
  await until(() => $('dialog-ok') && $('confirm-dialog').open);
  await wait(2600);
  log('tour finished');
}
void tour();
