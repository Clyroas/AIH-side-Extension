// The page-side half of the connection. Runs in Chrome's isolated world on app.all-hands.dev, owns the
// port to the panel, and is the only code that reads or drives the OpenHands DOM.
//
// Fail-closed rules that shape every path below: never guess, never retry a click, never resend, one
// confirmation click at a time, exact matches over fallbacks, and a coded visible error instead of a
// silent degradation.
(() => {
  'use strict';

  const VERSION = '1.0.0';
  const PORT_NAME = 'oh-side-panel-v1';
  const runtime = chrome.runtime;

  // A content script can be injected twice (declared in the manifest AND by the worker on attach, or
  // again after an extension update). The newest registration wins and the old one is disposed, so two
  // adapters can never fight over one page.
  const previous = globalThis.__OH_SIDE_REGISTRATION__;
  if (previous?.version === VERSION && previous.isAlive?.()) return;
  try { previous?.dispose?.(); } catch { /* old, already-invalidated context */ }

  const D = globalThis.OpenHandsSideDOM;
  if (!D || D.version !== VERSION) {
    // Without the matching DOM layer nothing can be read safely. Report and stay inert.
    try {
      chrome.runtime.onConnect.addListener(port => {
        if (port.name !== PORT_NAME) return;
        port.postMessage({ type: 'ERROR', code: 'ADAPTER_MISSING', adapterVersion: VERSION, clicked: false,
          message: 'The OpenHands DOM layer did not load with this content script. Reload the extension and the OpenHands tab, then reconnect. Nothing was typed or clicked.' });
        port.disconnect();
      });
    } catch { /* nothing usable to report through */ }
    return;
  }

  let owner = null, transaction = null, lastHeartbeat = 0, timer = null, observer = null;
  let scanQueued = false, scanTimer = null, lastScanAt = 0, probingPort = null;
  // Liveness comes from the port itself (it closes with the panel or the page). The lease only guards
  // against a silent panel, and is long enough to survive Chrome's once-a-minute timer throttling.
  const LEASE_MS = 5 * 60 * 1000;
  const MIN_SCAN_MS = 120;
  const ACK_TIMEOUT_MS = 15000;
  const IDLE_SETTLE_MS = 1200;
  const SECURITY_WAIT_MS = 120000;
  const CONFIRM_TIMEOUT_MS = 10000;
  const STAGE_TIMEOUT_MS = 10000;
  const ENABLE_TIMEOUT_MS = 4000;
  // A moment of odd page state is not a reason to stop: OpenHands swaps a streaming bubble for the
  // final message row, drains its optimistic queue, and re-groups tool cards while a turn runs.
  const SETTLE_MS = { PROMPT_MISMATCH: 8000, CONVERSATION_CHANGED: 5000, AMBIGUOUS_TURN: 5000 };

  const consumed = new Set();
  const documentId = crypto.randomUUID();
  const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });

  function emit(message) {
    try { owner?.postMessage({ ...message, documentId, adapterVersion: VERSION }); }
    catch { cleanup(); }
  }
  function stopTransaction() {
    const old = transaction;
    transaction = null;
    old?.abort?.abort();
    clearStaging(old);
  }
  function cleanup() {
    stopTransaction();
    observer?.disconnect(); observer = null;
    clearTimeout(scanTimer); scanTimer = null; scanQueued = false;
    clearInterval(timer); timer = null;
    const old = owner; owner = null;
    try { old?.disconnect(); } catch { /* already closed */ }
  }
  function error(error, tx = transaction) {
    emit({
      type: 'ERROR', requestId: tx?.requestId || null, code: error.code || 'ADAPTER_ERROR',
      message: error.code ? error.message : 'The OpenHands DOM adapter failed. Inspect the OpenHands tab. No retry was attempted.',
      clicked: !!tx?.clicked, accepted: !!tx?.userId
    });
    if (transaction === tx) stopTransaction();
  }

  // ---- staged files --------------------------------------------------------------------------
  // Bytes live only for the duration of one explicit Send. The marker is removed on every exit path so
  // a delayed page-context helper can never reuse a grant.
  function clearStaging(tx) {
    if (!tx) return;
    if (tx.stageToken) {
      for (const input of document.querySelectorAll('input[type="file"][data-oh-side-stage]'))
        if (input.getAttribute('data-oh-side-stage') === tx.stageToken) input.removeAttribute('data-oh-side-stage');
      tx.stageToken = null;
      try { chrome.runtime.sendMessage({ type: 'CLEAR_STAGE' }).catch(() => {}); } catch { /* context closing */ }
    }
    for (const item of tx.staged || []) item.bytes = new Uint8Array(0);
    tx.staged = [];
  }
  function stageResponse(promise, tx) {
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => { clearTimeout(deadline); tx.abort.signal.removeEventListener('abort', cancel); fn(value); };
      const cancel = () => finish(reject, new D.DomError('CANCELLED', 'Staging cancelled. Check the OpenHands composer; nothing was retried.'));
      const deadline = setTimeout(() => finish(reject, new D.DomError('STAGE_TIMEOUT',
        'File staging did not answer within 10 seconds. No Send click was attempted. Check the OpenHands composer before trying again.')), STAGE_TIMEOUT_MS);
      tx.abort.signal.addEventListener('abort', cancel, { once: true });
      if (tx.abort.signal.aborted) cancel();
      Promise.resolve(promise).then(value => finish(resolve, value), reject);
    });
  }
  function attachmentsFor(list) {
    if (list === undefined || list === null) return [];
    if (!Array.isArray(list) || !list.length) D.fail('INVALID_ATTACHMENT', 'Attachments must be a short list of user-picked files.');
    const A = globalThis.OpenHandsSideAttachments;
    if (!A) D.fail('ADAPTER_ERROR', 'The attachment policy failed to load. No message was sent.');
    if (list.length > A.ATTACHMENT_POLICY.maxFiles) D.fail('INVALID_ATTACHMENT', `Only ${A.ATTACHMENT_POLICY.maxFiles} files can accompany one message.`);
    return list.map(item => {
      try { return A.decodeAttachment(item); }
      catch (e) { return D.fail('INVALID_ATTACHMENT', e.message); }
    });
  }
  async function stageAttachments(tx, field) {
    const A = globalThis.OpenHandsSideAttachments;
    const meta = tx.staged.map(item => ({ name: item.name, type: item.type, size: item.bytes.byteLength }));
    const request = D.stageRequestFor(field, document, meta);
    tx.stageToken = request.token;
    const expiresAt = Date.now() + STAGE_TIMEOUT_MS;
    emit({ type: 'STAGED', requestId: tx.requestId, count: tx.staged.length });
    const payload = tx.staged.map(item => ({ name: item.name, type: item.type, data: A.bytesToBase64(item.bytes) }));
    let response;
    try {
      response = await stageResponse(chrome.runtime.sendMessage({ type: 'STAGE_FILES', token: request.token, expiresAt, files: payload }), tx);
    } catch (e) {
      D.fail(e.code || 'STAGE_FAILED', `The extension worker could not stage the files (${e?.message || 'no response'}).`);
    } finally {
      // Erase the base64 copies whether the call succeeded, failed or was cancelled.
      for (const item of payload) item.data = '';
      payload.length = 0;
    }
    if (transaction !== tx || !owner) return false;
    if (!response?.ok) D.fail(response?.code || 'STAGE_FAILED', `${response?.error || 'The files could not be placed in the OpenHands composer.'} Nothing was sent; the extension did not retry or fall back.`);
    const stage = response.value;
    if (!stage?.ok) D.fail('STAGE_REJECTED', `${stage?.reason || 'The OpenHands upload control did not accept the staged files.'} Nothing was sent; attach the files in OpenHands instead.`);
    if (stage.files?.length !== tx.staged.length || stage.files.some((file, index) => file.name !== tx.staged[index].name || file.size !== tx.staged[index].bytes.byteLength))
      D.fail('STAGE_MISMATCH', 'The OpenHands upload control reported different files than were staged. Nothing was sent; check the OpenHands tab.');
    // From here the page may print its own attachment chips beside the prompt; allow only that suffix.
    tx.attachmentLabels = true;
    await sleep(300); // let the site react (it may echo chips or re-render the composer)
    if (transaction !== tx || !owner) return false;
    if (!D.uploadsFor(field).input) D.fail('UPLOAD_CHANGED', 'OpenHands replaced its upload input right after staging. Nothing was sent; re-attach the files in OpenHands.');
    if (!composerMatches(tx, field)) D.fail('COMPOSER_CHANGED', 'The message box changed while the files were inserted. Your text and files remain in OpenHands; nothing was sent by the extension.');
    return true;
  }

  // ---- turn helpers --------------------------------------------------------------------------
  function composerMatches(tx, field) { return D.promptMatches(tx, D.composerText(field)); }
  // After the one Send click: signs that OpenHands took the message even though it has not drawn the
  // final row yet (the optimistic bubble, the Stop control, or a cleared message box all count). Once
  // seen, it stays seen.
  function sentEvidence(tx) {
    if (tx.sentEvidence) return tx.sentEvidence;
    let evidence = '';
    try {
      const pending = D.pendingRows().find(row => D.promptMatches(tx, row.text));
      if (pending) evidence = pending.status === 'error' ? '' : 'OpenHands queued your message';
    } catch { /* a pending read is only evidence, never a failure */ }
    if (!evidence && D.running()) evidence = 'OpenHands shows its Stop control';
    if (!evidence && !D.samePage(location.href, tx.url)) evidence = 'OpenHands opened the conversation';
    if (!evidence) {
      try {
        if (!composerMatches(tx, D.composer())) evidence = 'your text left the OpenHands message box';
      } catch { evidence = 'OpenHands replaced its message box'; }
    }
    return (tx.sentEvidence = evidence);
  }
  // The launcher routes to /conversations/<id> after the first message. Allow exactly one such move,
  // only while nothing has been drawn yet or the drawn row is still ours, and only to a chat page.
  function checkUrl(tx, result) {
    if (D.samePage(location.href, tx.url)) return;
    const kind = D.pageKind();
    if (!tx.urlAssigned && !tx.baseline.length && (kind === 'conversation' || kind === 'home') &&
        (result.accepted || !result.complete)) {
      tx.url = location.href; tx.urlAssigned = true;
      emit({ type: 'URL_BOUND', requestId: tx.requestId, url: tx.url, conversationId: D.conversationId() });
      return;
    }
    D.fail('CONVERSATION_CHANGED', 'The OpenHands address changed without a verified continuation of this turn. Capture stopped. Check the OpenHands tab before sending again.');
  }
  function publishLive(tx, result) {
    if (!result.accepted) {
      const signature = JSON.stringify({ pending: result.pending || [], state: result.state || null });
      if (signature !== tx.liveSignature) {
        tx.liveSignature = signature;
        emit({ type: 'LIVE_UPDATE', requestId: tx.requestId, text: '', rich: null, steps: [], activity: '',
          thinking: 0, generating: !!result.state?.running, confirmation: null, pending: result.pending || [],
          state: result.state || null, accepted: false });
      }
      return;
    }
    tx.turnIds = result.turnIds || tx.turnIds;
    const data = {
      text: result.liveText || '',
      rich: result.liveRich || null,
      steps: result.steps || [],
      activity: result.activity || '',
      thinking: result.thinking || 0,
      generating: !!result.generating,
      paused: !!result.paused,
      confirmation: result.confirmation || null,
      messageCount: result.messageCount || 0,
      state: result.state || null,
      accepted: true
    };
    const signature = JSON.stringify(data);
    if (signature !== tx.liveSignature) { tx.liveSignature = signature; emit({ type: 'LIVE_UPDATE', requestId: tx.requestId, ...data }); }
  }

  // ---- transient holds -----------------------------------------------------------------------
  // A security verification is transient: the user clears it in the tab and the page returns to normal.
  // Treating it as fatal stopped capture for good and made the panel look broken after the human had
  // already passed it. The loop holds the in-flight turn, tells the panel once, and resumes by itself on
  // the next scan after the notice disappears. Rate limits, sign-in walls and site errors stay fatal.
  function holdForSecurity(tx) {
    const notice = D.securityNotice?.() || '';
    if (notice) {
      if (!tx.securityHold) {
        tx.securityHold = true; tx.securityHoldSince = Date.now();
        emit({ type: 'BLOCKED', requestId: tx.requestId, code: 'SECURITY_CHECK', message: notice, clicked: !!tx.clicked, accepted: !!tx.userId });
      }
      return true;
    }
    if (tx.securityHold) {
      tx.securityHold = false;
      // A pause must not spend the "did OpenHands take the message?" budget.
      if (Number.isFinite(tx.ackDeadline)) tx.ackDeadline += Date.now() - (tx.securityHoldSince || Date.now());
      tx.securityHoldSince = 0; tx.idleSince = 0; tx.completeAt = 0; tx.completedText = '';
      emit({ type: 'SECURITY_CLEARED', requestId: tx.requestId, clicked: !!tx.clicked, accepted: !!tx.userId });
    }
    return false;
  }
  // Bounded wait before a Send: the panel is already in "Sending…" holding staged bytes, so this cannot
  // poll forever. Sending into a live challenge is refused, never retried.
  async function waitOutSecurity(tx) {
    if (!(D.securityNotice?.() || '')) return;
    const deadline = Date.now() + SECURITY_WAIT_MS;
    while (transaction === tx && owner && (D.securityNotice?.() || '')) {
      if (!tx.securityHold) {
        tx.securityHold = true;
        emit({ type: 'BLOCKED', requestId: tx.requestId, code: 'SECURITY_CHECK', message: 'OpenHands is showing a security verification.', clicked: false, accepted: false });
      }
      if (Date.now() >= deadline)
        D.fail('SECURITY_CHECK', 'A security verification is still showing after two minutes. Complete it in the OpenHands tab, then send again. No Send click was attempted.');
      await sleep(300);
    }
    if (tx.securityHold) {
      tx.securityHold = false;
      emit({ type: 'SECURITY_CLEARED', requestId: tx.requestId, clicked: false, accepted: false });
    }
  }
  // Pausing the agent is also transient: the user can resume it in OpenHands (or with the panel's own
  // Resume passthrough). Tracking is held, not stopped, and the deadline budget is shifted the same way.
  function holdForPause(tx, result) {
    const paused = !!result.paused && !result.complete;
    if (paused) {
      if (!tx.pauseHold) {
        tx.pauseHold = true; tx.pauseHoldSince = Date.now();
        emit({ type: 'PAUSED', requestId: tx.requestId, message: 'The OpenHands agent is paused or stopped. Tracking is held; it resumes on its own if you resume the agent in the OpenHands tab.', accepted: !!tx.userId });
      }
      return true;
    }
    if (tx.pauseHold) {
      tx.pauseHold = false;
      if (Number.isFinite(tx.ackDeadline)) tx.ackDeadline += Date.now() - (tx.pauseHoldSince || Date.now());
      tx.pauseHoldSince = 0; tx.idleSince = 0; tx.completeAt = 0; tx.completedText = '';
      emit({ type: 'RESUMED', requestId: tx.requestId, accepted: !!tx.userId });
    }
    return false;
  }

  // ---- the scan loop -------------------------------------------------------------------------
  function scan() {
    const tx = transaction;
    if (!owner || !tx || !tx.clicked) return;
    lastScanAt = Date.now();
    try {
      if (holdForSecurity(tx)) return;   // before checkBlocks: a verification is transient, not fatal
      D.checkBlocks();
      let result;
      try {
        result = D.matchTurn(tx);
        tx.unclearSince = 0;
      } catch (e) {
        const grace = SETTLE_MS[e?.code] || 0;
        if (grace) {
          tx.unclearSince ||= Date.now();
          if (Date.now() - tx.unclearSince < grace) { tx.completedText = ''; tx.completeAt = 0; tx.idleSince = 0; return; }
        }
        throw e;
      }
      checkUrl(tx, result);
      if (holdForPause(tx, result)) return;
      if (result.accepted && !tx.userId) {
        tx.userId = result.userId; tx.userEl = result.userEl || null;
        emit({ type: 'ACCEPTED', requestId: tx.requestId, userMessageId: tx.userId });
      }
      if (result.userEl) tx.userEl = result.userEl;
      publishLive(tx, result);

      if (!result.accepted && Date.now() > tx.ackDeadline) {
        // OpenHands took the message but is still working before it draws it: keep waiting, no limit.
        const evidence = sentEvidence(tx);
        if (!evidence)
          D.fail('SEND_NOT_CONFIRMED', 'Send was clicked once, but after 15 seconds OpenHands showed no sign of taking the message: it is not in the conversation, its queue is empty, the message box still holds it, and the agent is not working. Check OpenHands before sending again; do not assume it failed.');
        if (!tx.workingNotified) { tx.workingNotified = true; emit({ type: 'SENT_WORKING', requestId: tx.requestId, evidence }); }
      }

      // Completion must be stable: OpenHands re-renders between tool calls, swaps its streaming bubble
      // for the final message row, and briefly removes its Stop control while a finish event lands.
      // Both the finished text and the idle state have to hold for the settle window.
      if (result.complete && result.text && !tx.confirmInFlight) {
        const now = Date.now();
        tx.idleSince ||= now;
        if (tx.completedText !== result.text) { tx.completedText = result.text; tx.completeAt = now; }
        if (now - tx.completeAt >= IDLE_SETTLE_MS && now - tx.idleSince >= IDLE_SETTLE_MS) {
          emit({
            type: 'COMPLETE', requestId: tx.requestId, userMessageId: tx.userId,
            text: result.text, rich: result.rich || null, fullText: result.fullText || result.text,
            steps: result.steps || [], messageCount: result.messageCount || 0,
            url: tx.url, conversationId: D.conversationId(), status: result.state?.status || ''
          });
          stopTransaction();
        }
      } else {
        tx.completedText = ''; tx.completeAt = 0;
        if (!result.complete) tx.idleSince = 0;
      }
    } catch (e) { error(e, tx); }
  }
  // OpenHands mutates the page constantly while it streams, and every scan reads layout to decide what
  // is visible. Pending scans are coalesced to at most one per MIN_SCAN_MS; the 300 ms timer and the
  // panel's heartbeats keep capture moving regardless.
  function queueScan() {
    if (scanQueued) return;
    scanQueued = true;
    const wait = Math.max(0, MIN_SCAN_MS - (Date.now() - lastScanAt));
    if (!wait) { queueMicrotask(() => { scanQueued = false; scan(); }); return; }
    scanTimer = setTimeout(() => { scanTimer = null; scanQueued = false; scan(); }, wait);
  }

  // ---- confirmation --------------------------------------------------------------------------
  // One click on OpenHands' own Confirm/Reject control, only while the card is actually up, only once
  // per request, and only after the page is verified to be the same conversation. Never both, never a
  // keyboard shortcut, never a retry.
  // One click on OpenHands' own Confirm/Reject control: only while the card is actually up, only once per
  // card, and only after the page is verified to be the same conversation. Never both directions, never a
  // keyboard shortcut, never a retry. It also works with no tracked turn, so a confirmation the user
  // started in the OpenHands tab can be answered from the panel.
  let confirmInFlight = false;
  async function respondToConfirmation(message) {
    const tx = transaction;
    if (!owner) return;
    const requestId = tx?.requestId ?? null;
    if (typeof message.accept !== 'boolean')
      return emit({ type: 'CONFIRM_ERROR', requestId, code: 'INVALID_CHOICE', message: 'Choose Confirm or Reject.', attempted: false });
    const accept = message.accept;
    if (confirmInFlight || (tx && tx.confirmChoice))
      return emit({ type: 'CONFIRM_ERROR', requestId, code: 'CONFIRM_ALREADY_ANSWERED', message: 'A confirmation answer is already in flight or this one was already answered. Nothing else was clicked.', attempted: false });
    let attempted = false;
    try {
      if (tx ? holdForSecurity(tx) : (D.securityNotice?.() || ''))
        D.fail('SECURITY_CHECK', 'OpenHands is showing a security verification. Clear it in the OpenHands tab first; nothing was clicked.');
      D.checkBlocks();
      if (tx && !D.samePage(location.href, tx.url)) D.fail('CONVERSATION_CHANGED', 'OpenHands navigated before the confirmation answer. Nothing was clicked.');
      const card = D.confirmationCard();
      if (!card?.ready) D.fail('CONFIRM_UNAVAILABLE', 'OpenHands is not asking for a confirmation right now. Nothing was clicked.');
      const button = accept ? card.confirm : card.reject;
      if (!button || !D.enabled(button)) D.fail('CONFIRM_UNAVAILABLE', `The OpenHands ${accept ? 'Confirm' : 'Reject'} control is not available. Nothing was clicked.`);
      confirmInFlight = true;
      if (tx) { tx.confirmInFlight = true; tx.confirmChoice = accept ? 'confirm' : 'reject'; }
      attempted = true;
      button.click();
      emit({ type: 'CONFIRM_SENT', requestId, accept });
      const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
      while (owner) {
        if (!D.confirmationCard()) break;
        if (Date.now() >= deadline)
          D.fail('CONFIRM_NOT_APPLIED', `The ${accept ? 'Confirm' : 'Reject'} control was clicked once, but OpenHands is still showing the question. Answer it in the OpenHands tab; it will not be clicked again.`);
        await sleep(150);
      }
      if (tx) { tx.idleSince = 0; tx.completeAt = 0; tx.completedText = ''; }
    } catch (e) {
      if (attempted || ['SECURITY_CHECK', 'RATE_LIMIT', 'SIGN_IN_REQUIRED', 'OPENHANDS_ERROR', 'CONVERSATION_CHANGED'].includes(e.code)) { error(e, tx); return; }
      emit({ type: 'CONFIRM_ERROR', requestId, code: e.code || 'CONFIRM_FAILED', message: e.message || 'The confirmation could not be answered. Nothing was clicked.', attempted });
    } finally {
      confirmInFlight = false;
      if (tx) { tx.confirmInFlight = false; tx.liveSignature = ''; }
      if (owner) scan();
    }
  }

  // ---- agent controls ------------------------------------------------------------------------
  // Explicit passthrough to OpenHands' own agent controls: Stop the running agent, or Resume a paused one.
  // One click on the site's own control, only while that control is visible and usable, never a retry and
  // never both. Stopping is what ends a runaway turn, so it is allowed mid-transaction; the turn then goes
  // through the same paused hold as a stop clicked in the tab.
  const CONTROL_TIMEOUT_MS = 8000;
  async function respondToControl(message) {
    const name = message.control === 'stop' ? 'stop' : message.control === 'resume' ? 'resume' : '';
    if (!name) return emit({ type: 'CONTROL_ERROR', code: 'INVALID_CONTROL', message: 'Unknown agent control.', attempted: false });
    const tx = transaction;
    let attempted = false;
    try {
      if (tx ? holdForSecurity(tx) : (D.securityNotice?.() || ''))
        D.fail('SECURITY_CHECK', 'OpenHands is showing a security verification. Clear it in the OpenHands tab first; nothing was clicked.');
      D.checkBlocks();
      if (tx && !D.samePage(location.href, tx.url)) D.fail('CONVERSATION_CHANGED', 'OpenHands navigated before the control was used. Nothing was clicked.');
      const find = name === 'stop' ? D.stopButton : D.resumeButton;
      const button = find(document);
      if (!D.enabled(button))
        D.fail(name === 'stop' ? 'STOP_UNAVAILABLE' : 'RESUME_UNAVAILABLE',
          name === 'stop'
            ? 'OpenHands is not showing a usable Stop control right now, so the agent was not stopped. Use Stop in the OpenHands tab if it is running.'
            : 'OpenHands is not showing a usable Resume control right now, so the agent was not resumed. Use Play in the OpenHands tab.');
      if (name === 'resume' && D.running()) D.fail('AGENT_BUSY', 'OpenHands is already working, so there is nothing to resume. Nothing was clicked.');
      attempted = true;
      button.click();
      emit({ type: 'CONTROL_SENT', control: name, requestId: tx?.requestId || null });
      const gone = name === 'stop' ? D.stopButton : D.resumeButton;
      const deadline = Date.now() + CONTROL_TIMEOUT_MS;
      while (owner) {
        if (!D.enabled(gone(document))) break;
        if (Date.now() >= deadline)
          D.fail(name === 'stop' ? 'STOP_NOT_APPLIED' : 'RESUME_NOT_APPLIED',
            `The ${name === 'stop' ? 'Stop' : 'Resume'} control was clicked once, but OpenHands is still showing it. Check the OpenHands tab; it will not be clicked again.`);
        await sleep(150);
      }
      if (tx) { tx.idleSince = 0; tx.completeAt = 0; tx.completedText = ''; tx.liveSignature = ''; }
      if (owner) scan();
    } catch (e) {
      if (attempted || ['SECURITY_CHECK', 'RATE_LIMIT', 'SIGN_IN_REQUIRED', 'OPENHANDS_ERROR', 'CONVERSATION_CHANGED'].includes(e.code)) { error(e, tx); return; }
      emit({ type: 'CONTROL_ERROR', code: e.code || 'CONTROL_FAILED', message: e.message || 'The agent control could not be used. Nothing was clicked.', attempted, requestId: tx?.requestId || null });
    }
  }

  // Passive: notice the user answering in the OpenHands tab so the turn keeps being tracked correctly.
  function onPageClick(event) {
    const tx = transaction;
    if (!event.isTrusted || !owner || !tx?.clicked || tx.confirmChoice) return;
    const button = event.target?.closest?.('[data-testid="action-confirm-button"],[data-testid="action-reject-button"]');
    if (!button) return;
    tx.confirmChoice = button.matches('[data-testid="action-confirm-button"]') ? 'confirm' : 'reject';
    tx.liveSignature = '';
    emit({ type: 'CONFIRM_SEEN', requestId: tx.requestId, accept: tx.confirmChoice === 'confirm' });
    queueScan();
  }

  // ---- send ----------------------------------------------------------------------------------
  async function send(message) {
    if (transaction) return emit({ type: 'ERROR', requestId: message.requestId, code: 'BUSY', message: 'This tab is already tracking a request.', clicked: false });
    if (typeof message.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(message.requestId) ||
        typeof message.prompt !== 'string' || !message.prompt.trim() || message.prompt.length > 30000)
      return emit({ type: 'ERROR', requestId: message.requestId, code: 'INVALID_REQUEST', message: 'Invalid prompt or request ID.', clicked: false });
    // Exactly-once per request id: a panel that retries after a timeout must never cause a second send.
    if (consumed.has(message.requestId))
      return emit({ type: 'ERROR', requestId: message.requestId, code: 'DUPLICATE_REQUEST', message: 'This request was already attempted. It will not be sent again.', clicked: false });
    consumed.add(message.requestId);
    if (consumed.size > 128) consumed.delete(consumed.values().next().value);

    const tx = { requestId: message.requestId, prompt: message.prompt.trim(), url: location.href, clicked: false, abort: new AbortController(), baseline: [], staged: [] };
    transaction = tx;
    try {
      if (!D.samePage(message.url, location.href)) D.fail('CONVERSATION_CHANGED', 'The OpenHands tab is on a different conversation now. Reconnect before sending.');
      await waitOutSecurity(tx);
      if (transaction !== tx || !owner) return;
      // Snapshot the transcript BEFORE anything is typed, so a later change of context is detectable.
      const prepared = D.preflight();
      tx.baseline = prepared.list.map(D.signature);
      tx.baselineCount = tx.baseline.length;
      D.checkBlocks();
      if (!D.samePage(location.href, tx.url)) D.fail('CONVERSATION_CHANGED', 'OpenHands navigated before insertion. No message was sent.');
      if (JSON.stringify(D.rows().map(D.signature)) !== JSON.stringify(tx.baseline))
        D.fail('CONVERSATION_CHANGED', 'The OpenHands conversation changed before insertion. No message was sent.');
      const field = prepared.field;
      emit({ type: 'SENDING', requestId: tx.requestId, inputKind: 'contenteditable' });
      if (transaction !== tx || !owner) return;
      D.writeComposer(field, tx.prompt);
      try {
        tx.staged = attachmentsFor(message.attachments);
        message.attachments = null;
      } catch (e) { tx.staged = []; D.fail(e.code || 'INVALID_ATTACHMENT', e.message); }
      if (tx.staged.length && !(await stageAttachments(tx, field))) return;
      if (transaction !== tx || !owner) return;

      // The site enables Send from its own input handler; give that a moment, verifying the page on
      // every pass so nothing else can change unnoticed while we wait.
      const deadline = Date.now() + ENABLE_TIMEOUT_MS;
      let button;
      do {
        await sleep(80);
        if (transaction !== tx || !owner) return;
        D.checkBlocks();
        if (!D.samePage(location.href, tx.url)) D.fail('CONVERSATION_CHANGED', 'OpenHands navigated before Send. No Send click was attempted.');
        if (JSON.stringify(D.rows().map(D.signature)) !== JSON.stringify(tx.baseline))
          D.fail('CONVERSATION_CHANGED', 'The OpenHands transcript changed before Send. No Send click was attempted.');
        if (!field.isConnected || !composerMatches(tx, field)) D.fail('COMPOSER_CHANGED', 'The OpenHands message box changed before Send. No Send click was attempted.');
        if (D.composer() !== field) D.fail('COMPOSER_CHANGED', 'OpenHands replaced its message box before Send. No Send click was attempted.');
        if (D.running()) D.fail('AGENT_BUSY', 'OpenHands started working before Send. No Send click was attempted.');
        if (D.awaitingConfirmation()) D.fail('CONFIRMATION_PENDING', 'OpenHands asked you to confirm an action before Send. Answer it first; no Send click was attempted.');
        button = D.sendButton(document, field);
      } while (!D.enabled(button) && Date.now() < deadline);
      if (!D.enabled(button))
        D.fail('SEND_UNAVAILABLE', 'The OpenHands Send control stayed unavailable. Your text may remain in its message box, but no Send click was attempted. Check sign-in, workspace state or model configuration in the tab.');

      // Exactly one click. No Enter fallback, no retry on any failure or disconnect.
      tx.clicked = true;
      tx.ackDeadline = Date.now() + ACK_TIMEOUT_MS;
      button.click();
      scan();
    } catch (e) {
      if (transaction === tx) error(e, tx);
    } finally {
      clearStaging(tx);
    }
  }

  // Resume tracking a message OpenHands already accepted (after a panel reconnect or a page reload).
  // Strictly read-only: no composer write and no click on this path, and the usual attribution rules
  // apply. Without a live element to anchor on, the row is found by its content and context.
  function watch(message) {
    if (transaction) return emit({ type: 'ERROR', requestId: message.requestId, code: 'BUSY', message: 'This tab is already tracking a request.', clicked: false });
    try {
      if (typeof message.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(message.requestId) ||
          typeof message.prompt !== 'string' || !message.prompt.trim())
        D.fail('INVALID_REQUEST', 'Invalid resume request.');
      if (message.url && !D.samePage(message.url, location.href))
        D.fail('CONVERSATION_CHANGED', 'The OpenHands tab is now on a different conversation, so this reply can no longer be tracked here. Read it in OpenHands; nothing was resent.');
      D.checkBlocks();
      const tx = {
        requestId: message.requestId, prompt: message.prompt.trim(), url: location.href, clicked: true,
        resumed: true, abort: new AbortController(), staged: [],
        baseline: Array.isArray(message.baseline) ? message.baseline.filter(id => typeof id === 'string').slice(0, 400) : [],
        attachmentLabels: !!message.hadAttachments,
        ackDeadline: Infinity   // the message was accepted before the reconnect; there is nothing to wait for
      };
      const found = D.locateTurn(tx);
      if (!found.row)
        D.fail('WATCH_UNAVAILABLE', 'Your message is no longer visible in the OpenHands tab, so its reply cannot be tracked here. Read it in OpenHands; nothing was resent.');
      tx.userId = found.row.id; tx.userEl = found.row.el;
      transaction = tx;
      emit({ type: 'WATCHING', requestId: tx.requestId, userMessageId: tx.userId });
      scan();
    } catch (e) {
      emit({ type: 'ERROR', requestId: message.requestId, code: e.code || 'WATCH_UNAVAILABLE', message: e.message, clicked: false });
    }
  }

  // ---- read-only requests --------------------------------------------------------------------
  function loadHistory(message) {
    const requestId = typeof message.requestId === 'string' ? message.requestId.slice(0, 80) : '';
    try {
      if (message.url && !D.samePage(message.url, location.href)) D.fail('URL_CHANGED', 'The OpenHands conversation changed. Reconnect before loading its history.');
      const snapshot = D.historyTurns();
      emit({ type: 'HISTORY', requestId, url: location.href, ...snapshot });
    } catch (e) {
      emit({ type: 'HISTORY_ERROR', requestId, code: e.code || 'HISTORY_FAILED', message: e.message || 'Earlier messages could not be read. Nothing was changed in OpenHands.' });
    }
  }
  function siteInfo() {
    let info;
    try { info = D.inspectControls(); }
    catch (e) { info = { inputKind: 'unavailable', blocked: e.code ? `${e.code}: ${e.message}` : e.message }; }
    let state = null;
    try { state = D.publicState(D.siteState()); } catch { /* a diagnostic must never break the connection */ }
    let caps = null;
    try { caps = D.capabilities(); } catch { /* ditto */ }
    let history = 0;
    try { history = D.historyCount(); } catch { /* ditto */ }
    return { ...info, state, capabilities: caps, historyCount: history, url: location.href };
  }

  // ---- handshake -----------------------------------------------------------------------------
  async function probe(port) {
    if (probingPort === port) return;
    probingPort = port;
    // A conversation that is still starting or hydrating has no editable message box yet: allow 12 s.
    // While a transient notice (a security verification, a modal) covers it, wait without a deadline —
    // the user clears it and the same loop reaches READY, which is how the panel learns the site passed
    // verification instead of never finding out.
    let deadline = Date.now() + 12000, waiting = '';
    try {
      while (owner === port) {
        try {
          const info = siteInfo();
          emit({ type: 'READY', ...info, historyCount: info.historyCount });
          return;
        } catch (e) {
          const transient = e.code === 'SECURITY_CHECK' || e.code === 'SITE_DISCONNECTED' || e.code === 'CONFIRMATION_PENDING';
          if (transient || ['COMPOSER_NOT_FOUND', 'COMPOSER_UNAVAILABLE', 'SEND_BUTTON_NOT_FOUND'].includes(e.code)) {
            if (transient || Date.now() < deadline) {
              if (waiting !== e.message) { waiting = e.message; emit({ type: 'WAITING', code: e.code, message: e.message }); }
              if (transient) deadline = Date.now() + 12000;
              await sleep(400);
              continue;
            }
          }
          error(e, null);
          return;
        }
      }
    } finally { if (probingPort === port) probingPort = null; }
  }

  // Using a port the other end already closed throws. That is the only reliable sign that the previous
  // panel is gone but this page has not been told yet: the panel closes its port and reconnects
  // immediately, and the disconnect arrives here asynchronously. Without this check a reconnect that
  // wins that race is refused with TAB_IN_USE and the session ends until the user reconnects by hand.
  function portAlive(port) {
    try { port.postMessage({ type: 'PING' }); return true; } catch { return false; }
  }

  const onConnect = port => {
    if (port.name !== PORT_NAME || port.sender?.id !== chrome.runtime.id) return;
    if (owner && !portAlive(owner)) cleanup();  // the old panel is gone: let this connection take over
    if (owner) {
      port.postMessage({ type: 'ERROR', code: 'TAB_IN_USE', adapterVersion: VERSION, clicked: false,
        message: 'Another OpenHands Side Panel is connected to this tab. Disconnect it first.' });
      port.disconnect();
      return;
    }
    owner = port;
    lastHeartbeat = Date.now();
    document.addEventListener('click', onPageClick, true);
    observer = new MutationObserver(queueScan);
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['data-testid', 'data-pending-status', 'title', 'aria-expanded', 'aria-label', 'disabled', 'aria-disabled', 'hidden', 'contenteditable']
    });
    timer = setInterval(() => {
      if (Date.now() - lastHeartbeat > LEASE_MS) return cleanup();
      scan();
    }, 300);
    port.onDisconnect.addListener(() => { if (owner === port) cleanup(); });
    port.onMessage.addListener(message => {
      if (owner !== port) return;
      lastHeartbeat = Date.now();   // any message from the panel proves it is still there
      // Each heartbeat also rescans, so capture keeps pace even while this tab's timers are throttled.
      switch (message?.type) {
        case 'PING': emit({ type: 'PONG', ...safeState() }); scan(); break;
        case 'PROBE': probe(port); break;
        case 'SITE': emit({ type: 'SITE_INFO', ...safeState() }); break;
        case 'SEND': send(message); break;
        case 'WATCH': watch(message); break;
        case 'CONFIRM': respondToConfirmation(message); break;
        case 'CONTROL': respondToControl(message); break;
        case 'LOAD_HISTORY': loadHistory(message); break;
        case 'CANCEL': {
          const id = transaction?.requestId;
          if (!message.requestId || message.requestId === id) { stopTransaction(); emit({ type: 'CANCELLED', requestId: id }); }
          break;
        }
        default: break;
      }
    });
  };
  // The heartbeat carries the page state so the panel header stays honest even while idle. It must never
  // be able to break the connection, so every failure collapses to null.
  function safeState() {
    try {
      const state = D.publicState(D.siteState());
      return { url: location.href, state, busy: !!transaction, historyCount: D.historyCount() };
    } catch { return { url: location.href, state: null, busy: !!transaction }; }
  }

  chrome.runtime.onConnect.addListener(onConnect);

  const onPageHide = () => {
    // Before OpenHands accepted the message this is a hard stop. After acceptance the panel reconnects
    // to the reloaded page and re-watches the same message read-only, so no error is raised here.
    if (transaction && !transaction.userId)
      error(new D.DomError('PAGE_RELOADED', 'The OpenHands document closed or reloaded while sending. Capture stopped. Check the tab before sending again.'));
    cleanup();
  };
  window.addEventListener('pagehide', onPageHide);
  // A frozen background tab delivers queued heartbeats after its timers: grant a fresh lease on resume.
  const onResume = () => { if (owner) { lastHeartbeat = Date.now(); queueScan(); } };
  document.addEventListener('resume', onResume);
  document.addEventListener('visibilitychange', onResume);

  globalThis.__OH_SIDE_REGISTRATION__ = {
    version: VERSION,
    isAlive: () => {
      try { return runtime.id === chrome.runtime.id && !!runtime.id && (!runtime.getManifest || runtime.getManifest().version === VERSION); }
      catch { return false; }
    },
    dispose: () => {
      cleanup();
      try { runtime.onConnect.removeListener(onConnect); } catch { /* context already invalid */ }
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('resume', onResume);
      document.removeEventListener('visibilitychange', onResume);
      delete globalThis.__OH_SIDE_REGISTRATION__;
    }
  };
})();
