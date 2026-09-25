// The panel: connection setup, the transcript, the composer and the one transaction at a time.
//
// Everything the panel knows about OpenHands arrives as coded events from the page adapter (agent-dom.js
// via agent-content.js). Nothing here reads the site, holds credentials, or decides on its own that a reply
// finished — and no failure ever degrades into "paste the reply here". If the page cannot be driven, the
// panel says exactly why and stops.
import { encodeAttachments, releaseTurnAttachments, restoreTurnAttachments, selectAttachments } from './attachment-state.js';
import { TabAwakeLease } from './tab-awake.js';
import { ConversationView } from './conversation-view.js';
import { AgentClient } from './agent-client.js';
import { SITE_ORIGIN, VERSION, capabilitySummary, isChatUrl, isOpenHands, samePage, tabLabel, withTimeout } from './core.js';
import { confirmationState, liveStatus, siteStatus } from './live-status.js';
import './attachment-policy.js'; // Registers OpenHandsSideAttachments (the same text the page adapter loads).

const { ATTACHMENT_POLICY, formatBytes } = globalThis.OpenHandsSideAttachments;
const $ = id => document.getElementById(id);

const conversation = new ConversationView(document, answerConfirmation);
let tab = null, client = null, pending = null, turns = [], state = 'disconnected';
let busy = false, epoch = 0, actionId = 0, dialogResolve = null, awakeTab = null;
let historyRequest = null, historyTimer = null;
const awakeLease = new TabAwakeLease();
const staged = []; // Staged files live in memory only, until an accepted send or a local reset.
let recovery = { attempt: 0, timer: null, running: false };
const RECOVERY_DELAYS = [400, 900, 1800, 3600, 7000];

const labels = {
  disconnected: 'Disconnected', connecting: 'Checking controls…', reconnecting: 'Reconnecting…',
  ready: 'Ready', sending: 'Sending…', waiting: 'Waiting for OpenHands', error: 'Stopped · check tab'
};
// OpenHands' composer takes the same 30,000-character budget the adapter enforces; the count appears near
// the limit and says so when a paste had to be cut (the browser silently drops the rest at maxlength).
const PROMPT_LIMIT = 30000;
let promptCut = 0;

$('version').textContent = `v${VERSION}`;
$('attachment-input').accept = Object.keys(ATTACHMENT_POLICY.types).map(ext => `.${ext}`).join(',');

// ---- worker requests -------------------------------------------------------------------------
// One-shot worker requests are always bounded (see withTimeout in core.js). A suspended, restarting or
// updated service worker must never leave this panel permanently busy: a late answer is ignored and the
// caller gets a clear error to show, instead of a spinner that never ends.
const RPC_TIMEOUT_MS = 20000;
const rpc = async (type, extra = {}) => {
  let result;
  try {
    result = await withTimeout(chrome.runtime.sendMessage({ type, ...extra }), RPC_TIMEOUT_MS,
      `${type} did not answer within ${Math.round(RPC_TIMEOUT_MS / 1000)} seconds. Chrome may have restarted the extension worker. Reload the OpenHands tab and try again; nothing was sent.`);
  } catch (error) {
    if (error?.name === 'TimeoutError') throw error;
    // Most often "Extension context invalidated": the panel outlived an extension reload or update.
    throw new Error(`${type} could not reach the extension worker (${error?.message || 'no response'}). Reload this panel with the extension's Reload button and try again; nothing was sent to OpenHands.`);
  }
  if (!result?.ok) throw new Error(result?.error || 'The extension worker did not respond. Reload the extension and the OpenHands tab.');
  return result.value;
};

// ---- settings sheet --------------------------------------------------------------------------
let sheetOpener = null;
function setSheet(open, { restoreFocus = true } = {}) {
  const sheet = $('settings-sheet'), was = sheet.dataset.open === 'true';
  sheet.dataset.open = String(open);
  document.body.dataset.sheet = open ? 'open' : '';
  if (open && !was) sheetOpener = document.activeElement;
  sheet.inert = !open;
  document.querySelector('.app').inert = open;
  for (const id of ['settings-button', 'status-pill']) $(id).setAttribute('aria-expanded', String(open));
  if (open && (!was || !sheet.contains(document.activeElement)))
    requestAnimationFrame(() => { if (sheet.dataset.open === 'true' && !document.querySelector('dialog[open]')) $('sheet-done').focus({ preventScroll: true }); });
  if (!open && was && restoreFocus && sheet.contains(document.activeElement))
    (sheetOpener?.isConnected && !sheetOpener.disabled && sheetOpener !== document.body ? sheetOpener
      : !$('prompt').disabled ? $('prompt') : $('settings-button')).focus({ preventScroll: true });
}
const toggleSheet = () => setSheet($('settings-sheet').dataset.open !== 'true');
$('settings-button').addEventListener('click', toggleSheet);
$('status-pill').addEventListener('click', toggleSheet);
$('sheet-done').addEventListener('click', () => setSheet(false));
$('sheet-backdrop').addEventListener('click', () => setSheet(false));
$('empty-connect').addEventListener('click', () => setSheet(true));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && $('settings-sheet').dataset.open === 'true' && !$('confirm-dialog').open) {
    event.preventDefault();
    setSheet(false);
  }
  // Keep focus inside the sheet while it is modal.
  if (event.key === 'Tab' && $('settings-sheet').dataset.open === 'true' && !document.querySelector('dialog[open]')) {
    const controls = [...$('settings-sheet').querySelectorAll('button:not(:disabled),select:not(:disabled),input:not(:disabled),summary,[tabindex="0"]')]
      .filter(el => el.getClientRects().length && !el.closest('[hidden],[inert]'));
    const first = controls[0], last = controls.at(-1);
    if (first && event.shiftKey && (document.activeElement === first || !$('settings-sheet').contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (first && !event.shiftKey && (document.activeElement === last || !$('settings-sheet').contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
});

// ---- composer --------------------------------------------------------------------------------
function fitPrompt() { const field = $('prompt'); field.style.height = 'auto'; field.style.height = `${field.scrollHeight}px`; }
function renderPromptCount() {
  const length = $('prompt').value.length, box = $('prompt-count');
  const show = length >= PROMPT_LIMIT * 0.8 || promptCut > 0;
  box.hidden = !show;
  if (!show) return;
  box.dataset.full = String(length >= PROMPT_LIMIT);
  box.textContent = `${length.toLocaleString('en-US')} / ${PROMPT_LIMIT.toLocaleString('en-US')} characters`
    + (promptCut ? ` · your paste was cut: ${promptCut.toLocaleString('en-US')} characters did not fit. Send the rest in a follow-up message or attach it as a .txt file.` : '');
}
$('prompt').addEventListener('input', () => { fitPrompt(); updateSendAvailability(); });
$('prompt').addEventListener('paste', event => {
  const text = event.clipboardData?.getData('text/plain') || '';
  if (!text) return;
  const field = $('prompt'), room = PROMPT_LIMIT - (field.value.length - (field.selectionEnd - field.selectionStart));
  promptCut = Math.max(0, text.length - room);
  setTimeout(renderPromptCount, 0);
});
$('prompt').addEventListener('input', event => { if (event.inputType !== 'insertFromPaste') promptCut = 0; renderPromptCount(); });
$('prompt').addEventListener('keydown', event => {
  // Enter sends, Shift+Enter breaks the line, and an IME composition is never interrupted — the same rules
  // OpenHands' own composer uses, so the panel cannot send half a composed character.
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
  if ($('prompt').disabled || $('prepare').disabled) return;
  event.preventDefault();
  sendPrompt();
});

// ---- notices ---------------------------------------------------------------------------------
// Notices appear in full, then tuck away into a dot in the composer corner. Info shrinks by itself after a
// few seconds (not while hovered or focused); errors stay until minimized.
const NOTICE_AUTO_MS = 6000;
let noticeTimer = null;
function noticeKind(text) {
  if (state === 'error' || /^[A-Z][A-Z0-9_]{3,}:/.test(text)) return 'error';
  return state === 'reconnecting' ? 'warning' : 'info';
}
function setNoticeOpen(open) {
  const box = $('notice'), dot = $('notice-dot'), has = !!$('notice-text').textContent;
  box.hidden = !has || !open;
  dot.hidden = !has || open;
  dot.dataset.kind = box.dataset.kind || 'info';
}
function armNoticeTimer() {
  clearTimeout(noticeTimer);
  if ($('notice').dataset.kind === 'error' || !$('notice-text').textContent) return;
  noticeTimer = setTimeout(() => {
    const box = $('notice');
    if (box.matches(':hover') || box.contains(document.activeElement)) return armNoticeTimer();
    setNoticeOpen(false);
  }, NOTICE_AUTO_MS);
}
function notice(text = '') {
  $('notice-text').textContent = text;
  const kind = noticeKind(text);
  $('notice').dataset.kind = kind;
  $('notice').setAttribute('role', kind === 'error' ? 'alert' : 'status');
  setNoticeOpen(!!text);
  if (text) { $('notice-dot').classList.remove('fresh'); void $('notice-dot').offsetWidth; $('notice-dot').classList.add('fresh'); }
  armNoticeTimer();
}
$('notice-minimize').addEventListener('click', () => { clearTimeout(noticeTimer); setNoticeOpen(false); $('notice-dot').focus({ preventScroll: true }); });
$('notice-dot').addEventListener('click', () => { $('notice-dot').classList.remove('fresh'); setNoticeOpen(true); armNoticeTimer(); });
$('notice').addEventListener('mouseleave', armNoticeTimer);

// ---- confirm dialog --------------------------------------------------------------------------
// Exactly one confirmation may be open at a time. showModal() throws InvalidStateError on an already-open
// dialog, which used to surface as an unhandled rejection and could lose the answer meant for the first
// caller. A second request is treated as "not confirmed": it never overwrites the pending one, never throws.
function showConfirm({ title, text, ok, cancel }) {
  const dialog = $('confirm-dialog');
  if (dialog.open || dialogResolve) return Promise.resolve(false);
  $('dialog-title').textContent = title;
  $('dialog-description').textContent = text;
  $('dialog-ok').textContent = ok;
  $('dialog-cancel').textContent = cancel;
  try { dialog.showModal(); } catch { return Promise.resolve(false); }
  return new Promise(resolve => { dialogResolve = resolve; });
}
const askConfirm = (title, text, ok = 'Continue', cancel = 'Cancel') => showConfirm({ title, text, ok, cancel });
function hasContent() { return !!(turns.length || $('prompt').value || staged.length); }
function askClear(text) {
  if (!hasContent()) return Promise.resolve(true);
  return showConfirm({ title: 'Clear this session?', text, ok: 'Continue', cancel: 'Keep session' });
}
function closeDialog(value) { $('confirm-dialog').close(); dialogResolve?.(value); dialogResolve = null; }
$('dialog-ok').onclick = () => closeDialog(true);
$('dialog-cancel').onclick = () => closeDialog(false);
$('confirm-dialog').addEventListener('cancel', event => { event.preventDefault(); closeDialog(false); });

// ---- render ----------------------------------------------------------------------------------
// Send availability is recomputed on every keystroke as well as on every render: the button must enable
// the moment there is something to send, without waiting for the next event from the page.
function updateSendAvailability(drift = client?.ready ? capabilitySummary(client.capabilities) : null) {
  const canSend = state === 'ready' && !!client?.ready && !pending && !busy && !drift?.drift && !client?.silent;
  $('prepare').disabled = !canSend || !$('prompt').value.trim();
}
function render() {
  const drift = client?.ready ? capabilitySummary(client.capabilities) : null;
  const site = client?.state || null;
  const confirmation = site?.confirmation || null;
  const controls = site?.controls || null;
  // The idle confirmation bar is offered only when no tracked turn already shows the same card, so one
  // question can never be answered from two places at once.
  const turnHandlesConfirmation = !!pending?.live?.confirmation && confirmationState(pending.live.confirmation) !== 'none';
  const idleConfirmation = !turnHandlesConfirmation && confirmationState(confirmation) !== 'none';

  $('status').textContent = labels[state] || state;
  $('status').dataset.state = state;
  document.body.dataset.working = String(!!pending && pending.status !== 'error');
  document.body.dataset.connected = String(!!client?.ready);

  $('connected').hidden = !tab;
  $('connect').disabled = busy || !!tab || !$('tabs').value || !$('confirmed').checked || !$('authorize').checked;
  $('tabs').disabled = busy || !!tab;
  $('confirmed').disabled = busy || !!tab;
  $('authorize').disabled = busy || !!tab;

  updateSendAvailability(drift);
  $('prepare').textContent = staged.length ? `Send to OpenHands · ${staged.length} file${staged.length > 1 ? 's' : ''}` : 'Send to OpenHands';
  $('prepare').title = drift?.drift ? 'The OpenHands layout is missing a control this adapter drives. Fix it in the tab or update the extension.'
    : client?.silent ? 'The OpenHands tab is not answering the heartbeat. Open the tab to wake it.'
      : staged.length ? 'Send this message together with the staged files' : 'Exactly one Send click, in the OpenHands page';
  // While reattaching the draft stays editable; Send waits for the verified connection.
  $('prompt').disabled = pending ? true : busy || (state !== 'reconnecting' && state !== 'ready') || !client?.ready;
  $('prompt').placeholder = state === 'ready' ? 'Type a message to send to OpenHands…'
    : state === 'reconnecting' && !pending ? 'Reconnecting to OpenHands… you can keep typing'
      : idleConfirmation ? 'Answer the confirmation above to continue…'
        : pending ? 'OpenHands is working on this task…' : 'Connect your OpenHands tab to start…';

  const uploadReady = client?.ready && client.uploadKind === 'input';
  $('attach-files').disabled = busy || !!pending || state !== 'ready' || !uploadReady;
  $('attach-files').title = uploadReady ? 'Attach images or files from your computer'
    : 'Staged files can only be sent while the OpenHands tab exposes its composer file input. Attach them in OpenHands until then.';

  // Every panel action is serialized (one at a time). Stop/Resume are set separately below because they
  // depend on what OpenHands is currently showing, not on the panel being idle.
  for (const id of ['refresh', 'open', 'open-list', 'focus', 'reconnect', 'disconnect', 'cancel', 'open-conversation'])
    if ($(id)) $(id).disabled = busy;
  $('connection-escape').hidden = !['connecting', 'reconnecting'].includes(state);
  $('connection-focus').disabled = !tab;
  $('connection-info').hidden = !tab;
  $('connection-summary-text').textContent = tab ? `Tab ${tab.id} · ${tab.title || 'OpenHands'}` : 'Choose your OpenHands tab';
  $('connection-summary-text').title = tab ? tabLabel(tab) : '';
  $('connected-tab-short').textContent = tab ? `Tab ${tab.id}` : '';
  $('connected-tab-short').title = tab?.url || '';
  $('tab-name').textContent = tab ? tabLabel(tab) : '';
  $('tab-url').textContent = tab?.url || '';

  // Agent-level passthrough: only offered while OpenHands actually shows the control, and never for a
  // confirmation (those have their own one-click path).
  $('stop-agent').hidden = !client?.ready || !controls?.canStop;
  $('stop-agent').disabled = busy || !controls?.canStop;
  $('resume-agent').hidden = !client?.ready || !controls?.canResume;
  $('resume-agent').disabled = busy || !controls?.canResume;
  $('open-conversation').hidden = !client?.ready;

  // Header: what OpenHands itself says, never an inference from timing.
  $('agent-bar').hidden = !client?.ready;
  const headline = siteStatus(site, { busy: !!pending });
  $('site-name').textContent = client?.conversationName || (client?.conversationId ? `Conversation ${client.conversationId}` : client?.pageKind === 'home' ? 'OpenHands launcher' : 'OpenHands');
  $('site-name').title = client?.conversationId ? `Conversation ${client.conversationId}` : '';
  $('site-status').textContent = `${headline.label}${site?.activity ? ` · ${site.activity}` : ''}`;
  $('site-status').dataset.kind = headline.kind;
  $('site-status').title = headline.text;

  $('adapter-state').textContent = client?.ready
    ? `OpenHands page adapter v${VERSION} verified · ${client.pageKind === 'conversation' ? 'conversation' : 'launcher'} · contenteditable composer · upload: ${client.uploadKind === 'input' ? 'composer file input ready' : client.uploadKind === 'button-only' ? 'site picker only — attach in OpenHands' : 'not detected — staged files cannot be sent'}${drift ? ` · ${drift.text}` : ''}`
    : 'Page adapter check not ready. Reconnect after fixing the reported issue.';
  $('adapter-state').dataset.drift = String(!!drift?.drift);

  // Pending card
  $('pending').hidden = !pending;
  $('pending').dataset.state = pending?.status || '';
  $('progress').textContent = pending?.status === 'error'
    ? 'Capture stopped. Read the error above and check the OpenHands tab. No manual reply entry is available.'
    : pending?.securityHold ? 'Tracking is paused until OpenHands’ security verification is completed in the tab. It resumes automatically; nothing is resent.'
      : pending?.pauseHold ? 'The agent is paused or stopped. Resume it here or in the OpenHands tab and tracking continues; nothing is resent.'
        : pending?.status === 'waiting' ? 'Your message is in OpenHands. The status above follows its visible activity; the final reply appears separately — no response time limit.'
          : pending?.phase === 'upload' ? 'Placing your staged files into the OpenHands composer, then attempting exactly one Send click…'
            : pending?.resumed ? 'Reattached to the OpenHands tab and still tracking this message — nothing was resent.'
              : 'Preparing the OpenHands composer and attempting exactly one Send click…';
  $('cancel').disabled = busy || !pending;
  $('cancel').textContent = pending?.status === 'error' ? 'Dismiss' : 'Stop tracking';

  // Idle confirmation bar
  $('confirm-bar').hidden = !idleConfirmation;
  if (idleConfirmation) {
    $('confirm-bar').dataset.risk = String(!!confirmation.highRisk);
    $('confirm-bar-prompt').textContent = confirmation.prompt || 'Do you want to continue with this action?';
    $('confirm-bar-risk').hidden = !confirmation.highRisk;
    const locked = busy || !confirmation.ready || !!confirmBusy;
    $('confirm-bar-yes').disabled = locked;
    $('confirm-bar-no').disabled = locked;
    $('confirm-bar-status').textContent = confirmStatus
      || (!confirmation.ready ? 'OpenHands has not finished rendering its controls for this action yet.'
        : 'One click on OpenHands’ own control, one direction. Nothing is confirmed for you.');
  }

  // History import
  const found = client?.ready ? client.historyCount || 0 : 0;
  const imported = turns.filter(t => t.imported).length;
  $('history-import').hidden = !client?.ready || (!found && !imported);
  $('load-history').disabled = busy || !!historyRequest || !!pending || state !== 'ready';
  $('load-history').textContent = historyRequest ? 'Loading earlier messages…' : imported ? 'Reload earlier messages' : `Load earlier messages (${found} found)`;
  $('history-import-note').textContent = imported ? `${imported} imported from the OpenHands page` : 'Read-only · from this OpenHands conversation';

  conversation.render(turns, pending, state);
  updateLiveStatus();
  fitPrompt();
  renderPromptCount();
}

// The pending card's live line ticks once a second, touching only its three text nodes.
let statusTimer = null;
function updateLiveStatus() {
  if (!pending) { clearInterval(statusTimer); statusTimer = null; $('pending').dataset.kind = ''; return; }
  const status = liveStatus(pending);
  if (!status) return;
  if ($('pending-title').textContent !== status.step) $('pending-title').textContent = status.step;
  if ($('live-detail').textContent !== status.detail) $('live-detail').textContent = status.detail;
  $('live-detail').hidden = !status.detail;
  if ($('live-elapsed').textContent !== status.meta) $('live-elapsed').textContent = status.meta;
  $('pending').dataset.kind = status.kind;
  if (!statusTimer && pending.status !== 'error') statusTimer = setInterval(updateLiveStatus, 1000);
  if (statusTimer && pending.status === 'error') { clearInterval(statusTimer); statusTimer = null; }
}

// ---- attachments -----------------------------------------------------------------------------
function setAttachmentStatus(text, isError = false) {
  $('attachment-status').textContent = text;
  $('attachment-status').dataset.state = isError ? 'error' : '';
  $('attachments').hidden = !staged.length && !text;
}
function renderAttachments() {
  const chips = $('attachment-chips');
  chips.replaceChildren(...staged.map((item, index) => {
    const chip = document.createElement('span');
    chip.className = 'attachment-chip';
    if (item.url) {
      const preview = document.createElement('img');
      preview.src = item.url; preview.alt = '';
      chip.append(preview);
    }
    const name = document.createElement('span');
    name.className = 'attachment-name'; name.textContent = item.name; name.title = item.name;
    const size = document.createElement('span');
    size.className = 'attachment-size'; size.textContent = formatBytes(item.size);
    const remove = document.createElement('button');
    remove.type = 'button'; remove.className = 'attachment-remove'; remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.disabled = busy || !!pending;
    remove.addEventListener('click', () => {
      if (busy || pending) return;
      const [gone] = staged.splice(index, 1);
      if (gone?.url) URL.revokeObjectURL(gone.url);
      setAttachmentStatus(staged.length ? `${staged.length} file(s) staged.` : '');
      renderAttachments(); render();
    });
    chip.append(name, size, remove);
    return chip;
  }));
  $('attachments').hidden = !staged.length && !$('attachment-status').textContent;
  $('attachment-help').hidden = !!staged.length;
}
function stageFiles(list, origin) {
  const files = Array.from(list || []);
  if (!files.length) return;
  if (!client?.ready || pending || state !== 'ready') { setAttachmentStatus('Attach files only while connected and idle.', true); return; }
  if (client.uploadKind !== 'input') {
    setAttachmentStatus('OpenHands is not exposing a usable file input on this page, so files cannot be staged from the panel. Attach them in the OpenHands tab instead.', true);
    return;
  }
  const { accepted, rejected } = selectAttachments(files, staged);
  for (const item of accepted) {
    if (item.image) { try { item.url = URL.createObjectURL(item.file); } catch { /* preview only */ } }
    staged.push(item);
  }
  const reasons = rejected.map(item => `${item.name}: ${item.reason}`);
  setAttachmentStatus(reasons.length
    ? `${reasons.join(' ')}${accepted.length ? ` ${accepted.length} file(s) staged anyway.` : ''}`
    : `${staged.length} file(s) staged from ${origin}. They go only with your explicit Send.`, !!reasons.length);
  renderAttachments();
  render();
}
$('attach-files').addEventListener('click', () => { if (!$('attach-files').disabled) $('attachment-input').click(); });
$('attachment-input').addEventListener('change', () => {
  stageFiles($('attachment-input').files, 'the file picker');
  $('attachment-input').value = '';
});
document.addEventListener('paste', event => {
  if (event.target?.closest?.('#prompt') || !client?.ready) {
    // A paste inside the composer may still carry files (a screenshot); take those, leave the text alone.
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) { event.preventDefault(); stageFiles(files, 'a paste'); }
    return;
  }
  const files = [...(event.clipboardData?.files || [])];
  if (files.length) { event.preventDefault(); stageFiles(files, 'a paste'); }
});
for (const target of [document.querySelector('.oh-composer'), $('chat-scroll')]) {
  target?.addEventListener('dragover', event => { if (client?.ready && !pending) { event.preventDefault(); target.dataset.dragover = 'true'; } });
  target?.addEventListener('dragleave', () => { delete target.dataset.dragover; });
  target?.addEventListener('drop', event => {
    delete target.dataset.dragover;
    if (!client?.ready || pending) return;
    event.preventDefault();
    stageFiles(event.dataTransfer?.files, 'a drop');
  });
}

// ---- send ------------------------------------------------------------------------------------
async function sendPrompt() {
  if (!client?.ready || pending || state !== 'ready' || busy) return;
  const prompt = $('prompt').value.trim();
  if (!prompt) { notice('Type a message first. Nothing was sent.'); return; }
  if (prompt.length > PROMPT_LIMIT) { notice(`PROMPT_TOO_LONG: The message is longer than ${PROMPT_LIMIT.toLocaleString('en-US')} characters. Shorten it; nothing was sent.`); return; }
  if (staged.length && client.uploadKind !== 'input') {
    notice('UPLOAD_UNAVAILABLE: OpenHands is not exposing a usable file input, so the staged files cannot be placed in its composer. Remove them and send the text, or attach the files in the OpenHands tab. Nothing was sent.');
    return;
  }
  const requestId = crypto.randomUUID();
  const turn = {
    id: requestId, prompt, status: 'sending', phase: '', reply: '', rich: null, live: null, liveRevision: 0,
    steps: [], attachments: staged.map(({ name, type, size }) => ({ name, type, size })),
    files: staged.map(item => item.file), payload: null, createdAt: Date.now(), launcher: client.pageKind !== 'conversation'
  };
  let payload = [];
  if (staged.length) {
    try { payload = await encodeAttachments(staged); turn.payload = payload; }
    catch (error) { notice(error.message || 'The staged files could not be read. Nothing was sent.'); return; }
  }
  turns.push(turn);
  pending = turn;
  state = 'sending';
  busy = true;
  $('prompt').value = ''; promptCut = 0;
  notice(turn.launcher ? 'Sending from the OpenHands launcher: this creates a new conversation and the panel follows it.' : '');
  render();
  try {
    await client.send(requestId, prompt, tab.url, payload);
  } catch (error) {
    // The send never left the panel: keep the draft and the files so the user can decide, but never retry.
    restoreUnsentDraft(turn);
    turns.pop();
    pending = null;
    state = client?.ready ? 'ready' : 'error';
    notice(error.message || 'The message could not be handed to the OpenHands tab. Nothing was sent.');
  } finally {
    busy = false;
    render();
  }
}
$('prepare').addEventListener('click', () => { void sendPrompt(); });

// Only call when no Send click was attempted. Staging may already have touched the OpenHands composer;
// restoring a local draft is not permission to retry the send automatically.
function restoreUnsentDraft(turn) {
  if (!turn) return;
  if (!$('prompt').value) $('prompt').value = turn.prompt;
  const restored = restoreTurnAttachments(turn);
  if (!staged.length) {
    for (const item of restored) {
      if (item.type?.startsWith('image/')) { try { item.url = URL.createObjectURL(item.file); } catch { /* preview only */ } }
      staged.push(item);
    }
  }
  renderAttachments();
  setAttachmentStatus(staged.length ? `${staged.length} file(s) kept for your next Send.` : '');
  renderPromptCount();
  fitPrompt();
}
function clearStagedFiles() {
  for (const item of staged) if (item.url) URL.revokeObjectURL(item.url);
  staged.length = 0;
  renderAttachments();
}

// ---- confirmation & agent controls -----------------------------------------------------------
let confirmBusy = false, confirmStatus = '';
async function answerConfirmation(turnId, accept) {
  if (confirmBusy || !client?.ready) return;
  const word = accept ? 'Confirm' : 'Reject';
  const highRisk = accept && (pending?.live?.confirmation?.highRisk || client.state?.confirmation?.highRisk);
  const body = accept
    ? `This clicks OpenHands’ own Confirm control exactly once, so the agent continues with the action it proposed${highRisk ? ', which OpenHands marks High Risk' : ''}. It cannot be undone here.`
    : 'This clicks OpenHands’ own Reject control exactly once, so the agent declines the action it proposed.';
  if (!await askConfirm(`${word} this action?`, body, word, 'Cancel')) return;
  confirmBusy = true;
  confirmStatus = `Clicking ${word} once…`;
  render();
  try {
    client.confirm(turnId || null, accept);
  } catch (error) {
    confirmStatus = '';
    notice(error.message || 'The confirmation could not be answered.');
  } finally {
    confirmBusy = false;
    render();
  }
}
$('confirm-bar-yes').addEventListener('click', () => answerConfirmation(pending?.id || null, true));
$('confirm-bar-no').addEventListener('click', () => answerConfirmation(pending?.id || null, false));

// One click on OpenHands' own Stop/Play control. Stopping is the way out of a runaway turn, so it is
// offered while a turn is being tracked; it is never automatic and never retried.
async function agentControl(name) {
  if (!client?.ready || busy) return;
  if (name === 'stop' && !await askConfirm('Stop the OpenHands agent?',
    'This clicks OpenHands’ own Stop control exactly once. The agent stops where it is; work already done stays in the conversation. Tracking of the current reply is held, not lost.',
    'Stop agent', 'Cancel')) return;
  busy = true;
  render();
  try { client.control(name); }
  catch (error) { notice(error.message || 'The agent control could not be used.'); }
  finally { busy = false; render(); }
}
$('stop-agent').addEventListener('click', () => agentControl('stop'));
$('resume-agent').addEventListener('click', () => agentControl('resume'));

// ---- tabs & connection -----------------------------------------------------------------------
async function refresh() {
  const list = await rpc('LIST_TABS');
  const select = $('tabs');
  const current = select.value;
  const options = list.map(item => {
    const option = document.createElement('option');
    option.value = String(item.id);
    option.textContent = `${item.title || 'OpenHands'} · ${shortUrl(item.url)}${item.active ? ' · active' : ''}`;
    return option;
  });
  select.replaceChildren(...(options.length ? options : [emptyOption('No OpenHands tab is open')]));
  if (current && list.some(item => String(item.id) === current)) select.value = current;
  if (!options.length) notice('No open tab is on https://app.all-hands.dev. Open OpenHands, sign in there, then refresh this list.');
  return list;
}
const emptyOption = text => { const option = document.createElement('option'); option.value = ''; option.textContent = text; return option; };
function shortUrl(url) {
  try { const parsed = new URL(url); return parsed.pathname === '/' ? 'launcher' : parsed.pathname.replace(/^\//, ''); }
  catch { return ''; }
}
async function connect(id) {
  const version = ++epoch;
  clearHistoryRequest();
  closeClient();
  state = 'connecting';
  render();
  const selected = await rpc('GET_TAB', { tabId: id });
  if (epoch !== version) return;
  if (!isOpenHands(selected.url)) throw new Error('That tab is not on https://app.all-hands.dev. Open your OpenHands tab and select it again.');
  if (!isChatUrl(selected.url))
    throw new Error('That OpenHands page has no chat to drive (settings, automations, MCP, skills and shared conversations are read-only here). Open the launcher or a conversation, then reconnect. It will not fall back to manual copying.');
  tab = selected;
  render();
  const next = new AgentClient(id, event => { if (epoch === version && client === next) receive(event); }, selected.url);
  client = next;
  try { await next.readiness; }
  catch (error) { next.close(); if (client === next) client = null; throw error; }
  if (version !== epoch) return;
  state = 'ready';
  $('connection-details').open = false;
  setSheet(false);
  keepTabAwake(selected.id, true);
  notice(next.pageKind === 'conversation'
    ? `Connected to ${next.conversationName || 'the conversation'}. Send a message below — replies appear right here.`
    : 'Connected to the OpenHands launcher. Your first Send creates a new conversation and the panel follows it.');
  render();
}
function closeClient() { client?.close(); client = null; }
function keepTabAwake(tabId, keep) {
  if (keep) {
    if (awakeTab !== null && awakeTab !== tabId) void awakeLease.release(awakeTab);
    awakeTab = tabId;
    void awakeLease.acquire(tabId);
  } else {
    if (awakeTab === tabId) awakeTab = null;
    void awakeLease.release(tabId);
  }
}
function clear() {
  epoch++;
  clearHistoryRequest();
  closeClient();
  stopRecovery();
  if (awakeTab !== null) keepTabAwake(awakeTab, false);
  for (const turn of turns) releaseTurnAttachments(turn);
  tab = null; pending = null; turns = []; state = 'disconnected';
  clearStagedFiles();
  setAttachmentStatus('');
  $('connection-details').open = true;
  setSheet(true);
  $('prompt').value = '';
  $('confirmed').checked = false;
  $('authorize').checked = false;
  confirmStatus = '';
  notice();
  render();
}
function clearHistoryRequest() { clearTimeout(historyTimer); historyTimer = null; historyRequest = null; }

// ---- history (read-only) ---------------------------------------------------------------------
function receiveHistory(event) {
  if (event.type === 'HISTORY_ERROR') {
    clearHistoryRequest();
    notice(`${event.code || 'HISTORY_FAILED'}: ${event.message || 'Earlier messages could not be read.'}`);
    return;
  }
  if (!historyRequest || event.requestId !== historyRequest) return; // a late answer to a timed-out request
  clearHistoryRequest();
  const imported = (Array.isArray(event.turns) ? event.turns : []).map((item, index) => ({
    id: `imported-${item.id || index}`, imported: true, prompt: item.prompt || '(no text on the page)',
    reply: item.replies?.length ? item.replies.map(reply => reply.text).filter(Boolean).join('\n\n') : '',
    rich: item.replies?.length === 1 ? item.replies[0].rich || null : null,
    status: item.replies?.some(reply => reply.text) ? 'imported' : 'imported-no-reply',
    steps: [], live: null, liveRevision: 0, attachments: [], orphan: !!item.orphan
  }));
  if (!imported.length) { notice('HISTORY_EMPTY: OpenHands has no earlier messages rendered on this page.'); return; }
  // Imported turns replace the previous import; turns captured in this session are kept as they are.
  turns = [...turns.filter(turn => !turn.imported), ...imported];
  notice(`Imported ${imported.length} earlier message${imported.length === 1 ? '' : 's'} from the OpenHands page (read-only).${event.truncated ? ' The oldest part was left out.' : ''}`);
}
$('load-history').addEventListener('click', () => {
  if ($('load-history').disabled || !client?.ready || !tab) return;
  historyRequest = crypto.randomUUID();
  historyTimer = setTimeout(() => {
    clearHistoryRequest();
    notice('HISTORY_TIMEOUT: Earlier messages did not arrive. Open the OpenHands tab or try the read-only request again.');
    render();
  }, 15000);
  try { client.loadHistory(historyRequest, tab.url); }
  catch (error) { clearHistoryRequest(); notice(error.message); }
  render();
});

// ---- recovery --------------------------------------------------------------------------------
function stopRecovery() { clearTimeout(recovery.timer); recovery = { attempt: 0, timer: null, running: false }; }
function scheduleRecovery(delay) {
  clearTimeout(recovery.timer);
  recovery.timer = setTimeout(recoverNow, delay ?? RECOVERY_DELAYS[Math.min(recovery.attempt, RECOVERY_DELAYS.length - 1)]);
}
function interrupt(turn, text) {
  releaseTurnAttachments(turn);
  turn.status = 'error';
  turn.code = 'CONNECTION_INTERRUPTED';
  turn.outcomeText = text;
  if (pending === turn) pending = null;
}
function giveUp(message, turnText) {
  if (awakeTab !== null) keepTabAwake(awakeTab, false);
  stopRecovery();
  state = 'error';
  if (pending) interrupt(pending, turnText || 'The connection ended before the reply arrived. Read it in OpenHands; nothing was resent.');
  notice(message);
}
function connectionLost(event) {
  clearHistoryRequest();
  const old = client;
  client = null;
  old?.close();
  if (!tab || !event.wasReady) {
    state = 'error';
    if (pending) { pending.status = 'error'; releaseTurnAttachments(pending); }
    notice(`${event.code ? `${event.code}: ` : ''}${event.message}`);
    return;
  }
  if (pending) {
    // Only a message OpenHands already accepted can be re-watched. Anything earlier is reported honestly:
    // the panel cannot know whether the Send click landed.
    if (pending.status === 'waiting' && pending.userId) { pending.phase = 'reconnecting'; pending.resume = true; }
    else interrupt(pending, 'The connection dropped while this message was being sent. Check OpenHands before sending it again — it may or may not have been submitted.');
  }
  state = 'reconnecting';
  notice('Lost the connection to the OpenHands tab. Reconnecting automatically — nothing will be resent.');
  scheduleRecovery(0);
}
async function recoverNow() {
  if (state !== 'reconnecting' || !tab || recovery.running) return;
  recovery.running = true;
  recovery.attempt++;
  const version = epoch;
  let next = null;
  try {
    const current = await rpc('GET_TAB', { tabId: tab.id });
    if (epoch !== version || state !== 'reconnecting') return;
    if (current.discarded) throw new Error('Chrome put the OpenHands tab to sleep. Click “Go to OpenHands tab” in Settings to wake it; the panel reattaches by itself.');
    if (current.status === 'loading') throw new Error('The OpenHands tab is still loading.');
    if (!samePage(current.url, tab.url)) {
      giveUp('The OpenHands tab is now on a different page, so the panel did not reattach automatically. Open Settings and use Reconnect to connect to that page.',
        'The OpenHands tab moved to a different conversation while this reply was being tracked. Read it in OpenHands; nothing was resent.');
      return;
    }
    next = new AgentClient(tab.id, event => {
      if (epoch !== version || client !== next) return;
      if (!next.ready && event.type === 'ERROR' && !event.requestId) return; // reported through readiness below
      receive(event);
    }, tab.url);
    client = next;
    await next.readiness;
    if (epoch !== version || client !== next) return;
    stopRecovery();
    keepTabAwake(tab.id, true);
    if (pending?.resume) {
      pending.resume = false;
      pending.phase = '';
      pending.resumed = true;
      state = 'waiting';
      // No baseline here: after a reload the panel cannot know the transcript that preceded the message,
      // so the row is matched by its content alone (the newest matching row wins).
      next.watch(pending.id, pending.prompt, tab.url, { hadAttachments: !!pending.attachments?.length, baseline: [] });
      notice('Reconnected to the OpenHands tab. Still tracking your message — nothing was resent.');
    } else {
      state = 'ready';
      notice('Reconnected to the OpenHands tab automatically. Nothing was resent.');
    }
  } catch (error) {
    if (next && client === next) { client = null; next.close(); }
    if (epoch !== version || state !== 'reconnecting') return;
    const text = error.message || '';
    if (/no tab with id/i.test(text)) { giveUp('The OpenHands tab was closed. Open OpenHands and connect again from Settings.', 'The OpenHands tab was closed before the reply arrived.'); return; }
    // The page clears its side of a closed port asynchronously, so a reconnect that races the previous
    // connection can be refused once. That is transient: retry with backoff before ending the session.
    if (/TAB_IN_USE|Another OpenHands Side Panel/i.test(text) && recovery.attempt < 4) {
      notice(`Reconnecting to the OpenHands tab… (attempt ${recovery.attempt}) the previous connection is still closing.`);
      scheduleRecovery(Math.max(1000, RECOVERY_DELAYS[Math.min(recovery.attempt, RECOVERY_DELAYS.length - 1)]));
      return;
    }
    if (/no longer on OpenHands|TAB_IN_USE/i.test(text)) { giveUp(`${text} Open Settings to connect again.`); return; }
    notice(`Reconnecting to the OpenHands tab… (attempt ${recovery.attempt}) ${text}`.trim());
    scheduleRecovery();
  } finally {
    recovery.running = false;
    render();
  }
}
const nudgeRecovery = () => { if (state === 'reconnecting' && !recovery.running) scheduleRecovery(0); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') nudgeRecovery(); });
window.addEventListener('focus', nudgeRecovery);
chrome.tabs?.onUpdated?.addListener((tabId, info) => { if (tab && tabId === tab.id && info.status === 'complete') nudgeRecovery(); });

// ---- events ----------------------------------------------------------------------------------
// An event that cannot be applied must never leave the panel frozen on stale state or — worse — kill the
// port listener it arrived on: the failure is logged, reported, and the view is rebuilt from what the
// panel knows.
function receive(event) {
  try { handleEvent(event); }
  catch (error) {
    console.error('OpenHands Side Panel could not apply an event:', event?.type, error);
    try { notice(`${event?.type || 'EVENT'}_FAILED: The panel could not update itself (${error?.message || error}). Reconnect in Settings if this keeps happening.`); }
    catch { /* the panel DOM is unusable */ }
    try { render(); } catch { /* already reported above */ }
  }
}
function handleEvent(event) {
  switch (event.type) {
    case 'TRANSPORT_HEALTH':
      notice(event.responsive ? 'The OpenHands tab is responding again. Nothing was resent.'
        : 'TAB_NOT_RESPONDING: The OpenHands tab has not answered the connection heartbeat. Open it from Settings to wake it. Send is paused; nothing will be resent.');
      render(); return;
    case 'SITE_INFO':
    case 'PONG':
      render(); return;
    case 'BRIDGE_LOST': connectionLost(event); render(); return;
    case 'WAITING': notice(`${event.code}: ${event.message}`); render(); return;
    case 'HISTORY':
    case 'HISTORY_ERROR': receiveHistory(event); render(); return;
    case 'CONTROL_SENT':
      confirmStatus = '';
      notice(event.control === 'stop' ? 'OpenHands’ Stop control was clicked once. The agent is stopping; tracking is held until it pauses or finishes.'
        : 'OpenHands’ Resume control was clicked once. Tracking continues if a reply was in flight.');
      client?.querySite();
      render(); return;
    case 'CONTROL_ERROR':
      notice(`${event.code || 'CONTROL_FAILED'}: ${event.message || 'The agent control could not be used.'}`);
      client?.querySite();
      render(); return;
    case 'CONFIRM_SENT':
      confirmStatus = `You ${event.accept ? 'confirmed' : 'rejected'} the action once. Waiting for OpenHands to continue.`;
      if (pending) { pending.confirmChoice = event.accept ? 'confirm' : 'reject'; pending.liveRevision = (pending.liveRevision || 0) + 1; }
      notice(confirmStatus);
      render(); return;
    case 'CONFIRM_SEEN':
      confirmStatus = '';
      if (pending) { pending.confirmChoice = event.accept ? 'confirm' : 'reject'; pending.liveRevision = (pending.liveRevision || 0) + 1; }
      notice(`You ${event.accept ? 'confirmed' : 'rejected'} the action in the OpenHands tab. Tracking continues.`);
      render(); return;
    case 'CONFIRM_ERROR':
      confirmStatus = '';
      if (pending && event.requestId === pending.id) { pending.confirmState = event.message; pending.liveRevision = (pending.liveRevision || 0) + 1; }
      notice(`${event.code || 'CONFIRM_FAILED'}: ${event.message}`);
      render(); return;
    case 'ERROR':
      if (!event.requestId) {
        state = 'error';
        if (pending) { pending.status = 'error'; releaseTurnAttachments(pending); }
        notice(`${event.code ? `${event.code}: ` : ''}${event.message}`);
        render();
        return;
      }
      break;
    case 'CANCELLED': {
      const turn = pending;
      if (turn && (!event.requestId || event.requestId === turn.id)) {
        releaseTurnAttachments(turn);
        turn.status = 'cancelled';
        turn.outcomeText = 'Tracking stopped in this panel. OpenHands may still be working on it; stop the agent from the bar above if you want it to stop.';
        pending = null;
        state = client?.ready ? 'ready' : 'error';
        clearStagedFiles();
        notice('Stopped tracking this reply. Nothing was resent and nothing was clicked in OpenHands.');
      }
      render(); return;
    }
    default: break;
  }

  const turn = pending;
  if (!turn || event.requestId !== turn.id) return;
  switch (event.type) {
    case 'SENDING':
      state = 'sending'; turn.status = 'sending'; turn.phase = '';
      break;
    case 'STAGED':
      turn.phase = 'upload';
      break;
    case 'WATCHING':
      turn.phase = '';
      break;
    case 'SENT_WORKING':
      releaseTurnAttachments(turn);
      clearStagedFiles();
      state = 'waiting'; turn.status = 'waiting'; turn.acceptedAt ||= Date.now(); turn.lastActivityAt = Date.now();
      notice(`OpenHands took your message (${event.evidence || 'it is working'}) but has not drawn it in the conversation yet — normal while a new conversation starts up. Waiting with no time limit. To stop waiting: Stop tracking.`);
      break;
    case 'ACCEPTED':
      releaseTurnAttachments(turn);
      clearStagedFiles();
      state = 'waiting'; turn.status = 'waiting'; turn.userId = event.userMessageId;
      turn.acceptedAt ||= Date.now(); turn.lastActivityAt = Date.now();
      notice('OpenHands accepted your message. Live activity appears below; the final reply stays separate.');
      break;
    case 'LIVE_UPDATE': {
      const now = Date.now();
      if ((event.text || '') !== (turn.live?.text || '')) turn.textChangedAt = now;
      turn.lastActivityAt = now;
      turn.acceptedAt ||= now;
      turn.live = {
        text: event.text || '', rich: event.rich || null, steps: event.steps || [], activity: event.activity || '',
        thinking: event.thinking || 0, generating: !!event.generating, paused: !!event.paused,
        confirmation: event.confirmation || null, pending: event.pending || [], state: event.state || null
      };
      turn.steps = event.steps || turn.steps;
      if (event.state) turn.state = event.state;
      if (event.confirmation && confirmationState(event.confirmation) === 'answerable' && !turn.confirmNoticed) {
        turn.confirmNoticed = true;
        notice('OpenHands asks whether to continue with an action. Confirm or Reject below — nothing is chosen for you.');
      }
      if (event.paused && !turn.pauseHold) { turn.pauseHold = true; }
      if (!event.paused) turn.pauseHold = false;
      turn.liveRevision = (turn.liveRevision || 0) + 1;
      break;
    }
    case 'BLOCKED':
      // A transient security verification, not a failure: keep the turn alive and say why it paused.
      turn.securityHold = true;
      turn.lastActivityAt = Date.now();
      state = 'waiting'; turn.status = 'waiting';
      notice(`${event.code}: ${event.message} Tracking is paused, not stopped — it resumes on its own once the verification passes in the OpenHands tab.`);
      break;
    case 'SECURITY_CLEARED':
      turn.securityHold = false;
      turn.lastActivityAt = Date.now();
      notice('The OpenHands verification passed. Tracking resumed automatically; nothing was resent.');
      break;
    case 'PAUSED':
      turn.pauseHold = true;
      turn.lastActivityAt = Date.now();
      state = 'waiting'; turn.status = 'waiting';
      notice(`PAUSED: ${event.message}`);
      break;
    case 'RESUMED':
      turn.pauseHold = false;
      turn.lastActivityAt = Date.now();
      notice('The OpenHands agent resumed. Tracking continues automatically; nothing was resent.');
      break;
    case 'URL_BOUND':
      tab.url = event.url;
      notice('OpenHands opened the conversation for this message. The panel is following it.');
      break;
    case 'COMPLETE':
      releaseTurnAttachments(turn);
      clearStagedFiles();
      turn.reply = event.text || '';
      turn.rich = Array.isArray(event.rich) ? event.rich : null;
      turn.fullText = event.fullText || turn.reply;
      turn.steps = event.steps || turn.steps;
      turn.status = 'complete';
      turn.userId = event.userMessageId || turn.userId;
      turn.messageCount = event.messageCount || 0;
      tab.url = event.url || tab.url;
      pending = null;
      state = 'ready';
      confirmStatus = '';
      notice(`Reply received automatically${turn.messageCount > 1 ? ` (${turn.messageCount} messages in this turn)` : ''}.`);
      break;
    case 'ERROR':
      if (turn.resumed && client?.ready) {
        // Re-watching after a reconnect failed (the message is gone after a reload, for example). The
        // connection itself is fine, so finish this turn and keep the panel usable. Nothing is resent.
        releaseTurnAttachments(turn);
        turn.status = 'error'; turn.code = event.code; turn.outcomeText = event.message;
        pending = null; state = 'ready';
        notice(`${event.code}: ${event.message}`);
        break;
      }
      state = 'error';
      turn.status = 'error';
      turn.code = event.code;
      turn.outcomeText = `${event.code || 'ERROR'}: ${event.message}`; // the transcript keeps the coded reason
      if (!event.clicked) restoreUnsentDraft(turn); else { releaseTurnAttachments(turn); clearStagedFiles(); }
      notice(`${event.code}: ${event.message} ${event.clicked ? 'Send was attempted once. Check OpenHands before resending.' : 'No Send click was attempted for this request. Your text may remain in the OpenHands message box.'}`);
      break;
    default:
      break;
  }
  render();
}

// ---- wiring ----------------------------------------------------------------------------------
function action(id, fn) {
  $(id).addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    notice();
    render();
    const operation = ++actionId;
    try { await fn(); }
    catch (error) {
      // Never convert a failure into a manual mode or ask for a pasted reply.
      if (operation === actionId) {
        if (pending || !client?.ready) state = 'error';
        if (pending) pending.status = 'error';
        notice(error.message || 'Unexpected extension error. Check OpenHands before resending.');
      }
    } finally {
      if (operation === actionId) { busy = false; render(); }
    }
  });
}
action('refresh', refresh);
action('connect', () => connect(Number($('tabs').value)));
action('focus', () => rpc('FOCUS_TAB', { tabId: tab.id }));
action('open-conversation', () => rpc('FOCUS_TAB', { tabId: tab.id }));
action('open', () => rpc('OPEN_SITE', { url: `${SITE_ORIGIN}/` }));
action('open-list', () => rpc('OPEN_SITE', { url: `${SITE_ORIGIN}/conversations` }));
action('reconnect', async () => {
  if (!tab) return;
  if (pending && !await askConfirm('Reconnect and stop tracking?',
    'Reconnecting drops the current tracking of this reply. The message stays in OpenHands and its task keeps running; the panel will not resend anything.',
    'Reconnect', 'Keep tracking')) return;
  const id = tab.id, url = tab.url;
  if (await askClear('Reconnecting clears this panel’s transcript. Your OpenHands conversation is unchanged.')) {
    for (const turn of turns) releaseTurnAttachments(turn);
    turns = [];
  }
  pending = null;
  tab = { ...tab, id, url };
  await connect(id);
});
action('disconnect', async () => {
  if (await askClear('Disconnecting clears this panel’s transcript and stops tracking. Your OpenHands conversation is unchanged, and a task already sent keeps running there.')) clear();
});
$('connection-cancel').addEventListener('click', () => {
  if (!['connecting', 'reconnecting'].includes(state)) return;
  actionId++;
  epoch++;
  closeClient();
  stopRecovery();
  clearHistoryRequest();
  if (awakeTab !== null) keepTabAwake(awakeTab, false);
  if (pending) interrupt(pending, 'Connection setup cancelled. Nothing was resent; check OpenHands for any accepted message.');
  busy = false;
  state = tab ? 'error' : 'disconnected';
  notice('Connection setup cancelled. Your local draft and transcript are kept.');
  render();
});
$('connection-focus').addEventListener('click', () => {
  if (tab) rpc('FOCUS_TAB', { tabId: tab.id }).catch(error => notice(error.message));
});
$('cancel').addEventListener('click', () => {
  if (!pending || busy) return;
  const turn = pending;
  if (turn.status === 'error') {
    // Dismiss the stopped card. The turn keeps its coded reason in the transcript, the composer opens up
    // again, and nothing is resent; checking OpenHands first is the user's call, as the notice says.
    pending = null;
    state = client?.ready ? 'ready' : 'error';
    notice('Stopped card dismissed. The turn keeps its coded reason in the transcript; nothing was resent.');
    render();
    return;
  }
  try { client?.cancel(turn.id); } catch { /* reported by the connection */ }
  releaseTurnAttachments(turn);
  turn.status = 'cancelled';
  turn.outcomeText = 'Tracking stopped in this panel. OpenHands may still be working on it.';
  pending = null;
  state = client?.ready ? 'ready' : 'error';
  notice('Stopped tracking this reply locally. Nothing was clicked in OpenHands; use Stop agent if you want the task to stop.');
  render();
});
for (const id of ['tabs', 'confirmed', 'authorize']) $(id).addEventListener('change', render);

// ---- boot ------------------------------------------------------------------------------------
setSheet(true); // Disconnected on open: show the connection setup.
(async function boot() {
  render();
  try {
    const list = await refresh();
    // One obvious candidate is preselected so connecting is a single click; nothing is connected yet.
    if (list.length === 1) $('tabs').value = String(list[0].id);
    else if (list.length > 1) {
      const active = list.find(item => item.active);
      if (active) $('tabs').value = String(active.id);
    }
  } catch (error) {
    notice(error.message || 'The extension worker could not list OpenHands tabs.');
  }
  render();
})();
window.addEventListener('pagehide', () => {
  // The panel is closing: release the tab lease and drop the port so the page side cleans up at once.
  epoch++;
  closeClient();
  stopRecovery();
  if (awakeTab !== null) keepTabAwake(awakeTab, false);
});
