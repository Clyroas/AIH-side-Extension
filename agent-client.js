// Panel-side connection. The panel holds a DIRECT port to the OpenHands tab's top-frame content script
// (chrome.tabs.connect from this extension page); the MV3 service worker is only used for short one-shot
// requests (attach/inject, staged-file grants, tab management). That is what keeps a conversation alive
// while Chrome suspends the idle worker.
//
// This class owns transport concerns only — versions, timeouts, heartbeats, and turning a lost port into a
// single coded event. All policy about what a reply means lives in panel.js and agent-dom.js.
import { PORT_NAME, VERSION, withTimeout } from './core.js';

export const ADAPTER_VERSION = VERSION;
export const HEARTBEAT_MS = 10000;
// Requests made while a Send is being prepared must not wait forever: the panel would otherwise sit in
// "Sending…" holding staged bytes in memory. Every budget is well below the point where a user would retry
// by hand.
export const ATTACH_TIMEOUT_MS = 20000;
export const GRANT_TIMEOUT_MS = 10000;
export const HANDSHAKE_TIMEOUT_MS = 15000;
// While OpenHands shows a transient notice (security verification, a confirmation, a reconnecting
// workspace) or has not finished hydrating its composer, give a human time to clear it — bounded, never
// reset by repeated WAITING messages.
export const NOTICE_TIMEOUT_MS = 120000;
export const SILENT_PORT_MS = 90000;

export class AgentClient {
  // `timeouts` exists so tests can exercise the failed-worker paths without waiting out the real budgets;
  // the panel always uses the defaults.
  constructor(tabId, onEvent, expectedUrl, timeouts = {}) {
    this.closed = false; this.ready = false; this.silent = false; this.onEvent = onEvent; this.tabId = tabId;
    this.port = null; this.documentId = '';
    this.timeouts = {
      attach: timeouts.attach ?? ATTACH_TIMEOUT_MS,
      grant: timeouts.grant ?? GRANT_TIMEOUT_MS,
      handshake: timeouts.handshake ?? HANDSHAKE_TIMEOUT_MS,
      notice: timeouts.notice ?? NOTICE_TIMEOUT_MS,
      silent: timeouts.silent ?? SILENT_PORT_MS
    };
    this.readiness = new Promise((resolve, reject) => { this.resolve = resolve; this.reject = reject; });
    this.readiness.catch(() => {}); // callers await it; avoid unhandled rejections after close
    // Attachment has its own budget: do not spend the handshake budget before a port exists. Deferring the
    // start also guarantees the caller has assigned its client reference before any callback can fire,
    // even if Chrome throws synchronously (an extension context invalidated by an update).
    Promise.resolve().then(() => this.start(expectedUrl)).catch(error => {
      if (!this.closed) this.lost(error?.message || 'The connection could not start.');
    });
  }

  async start(expectedUrl) {
    if (this.closed) return;
    let attached;
    try {
      const result = await withTimeout(
        chrome.runtime.sendMessage({ type: 'ATTACH', tabId: this.tabId, expectedUrl }),
        this.timeouts.attach,
        `The extension worker did not answer the connection request within ${Math.round(this.timeouts.attach / 1000)} seconds. It may have been restarted or updated; reload the OpenHands tab and reconnect. Nothing was sent.`);
      if (!result?.ok)
        throw Object.assign(new Error(result?.error || 'The extension worker did not respond. Reload the extension and the OpenHands tab.'), { code: result?.code || 'CONNECTION_FAILED' });
      attached = result.value;
    } catch (error) {
      if (this.closed) return;
      this.fail(`${error.code || 'CONNECTION_FAILED'}: ${error.message}`);
      this.close();
      this.onEvent({ type: 'ERROR', code: error.code || 'CONNECTION_FAILED', message: error.message, clicked: false });
      return;
    }
    if (this.closed) return;
    this.documentId = attached.documentId;
    this.lastInbound = Date.now();
    this.armHandshake(this.timeouts.handshake);
    try {
      this.port = chrome.tabs.connect(this.tabId, { name: PORT_NAME, documentId: attached.documentId });
    } catch (error) {
      this.lost(`Chrome could not open a connection to the OpenHands tab (${error.message}).`);
      return;
    }
    this.port.onMessage.addListener(event => this.handle(event));
    this.port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message;
      this.lost(`The OpenHands tab connection closed.${detail ? ' Browser detail: ' + detail : ''}`);
    });
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      this.checkHealth();
      try { this.port.postMessage({ type: 'PING' }); } catch { this.lost('The OpenHands tab connection closed.'); }
    }, HEARTBEAT_MS);
    this.post({ type: 'PROBE' });
  }

  // A port that stops answering is reported once, so the panel can say "the tab is not responding" instead
  // of showing a stale reply. Recovery is the same as any other loss: the next inbound message clears it.
  checkHealth() {
    if (this.ready && !this.closed && !this.silent && Date.now() - this.lastInbound > this.timeouts.silent) {
      this.silent = true;
      this.onEvent({ type: 'TRANSPORT_HEALTH', responsive: false });
    }
  }
  armHandshake(ms) {
    clearTimeout(this.timeout);
    this.timeout = setTimeout(() => {
      if (this.closed || this.ready) return;
      const message = 'Connection setup timed out. Open the OpenHands tab, clear any notice it is showing, then reconnect. Nothing was sent.';
      this.fail(`ADAPTER_HANDSHAKE_TIMEOUT: ${message}`);
      this.close();
      this.onEvent({ type: 'ERROR', code: 'ADAPTER_HANDSHAKE_TIMEOUT', message, clicked: false });
    }, ms);
  }

  handle(event) {
    if (this.closed || !event || typeof event.type !== 'string') return;
    this.lastInbound = Date.now();
    if (this.silent) { this.silent = false; this.onEvent({ type: 'TRANSPORT_HEALTH', responsive: true }); }
    if (event.type === 'READY') {
      if (event.adapterVersion !== ADAPTER_VERSION) {
        const message = `Wrong content-script version (tab reports ${event.adapterVersion || 'nothing'}, panel expects ${ADAPTER_VERSION}). Reload the OpenHands tab after updating the extension, then reconnect.`;
        this.fail(message);
        this.onEvent({ type: 'ERROR', code: 'VERSION_MISMATCH', message, clicked: false });
        this.close();
        return;
      }
      this.ready = true;
      this.applySiteInfo(event);
      clearTimeout(this.timeout);
      this.resolve(event);
    }
    if (event.type === 'SITE_INFO' || event.type === 'PONG') this.applySiteInfo(event);
    // Give a human time to clear a transient notice, but never wait forever and never reset on repeats.
    if (event.type === 'WAITING' && !this.ready && !this.waitingForNotice) {
      this.waitingForNotice = true;
      this.armHandshake(this.timeouts.notice);
    }
    if (event.type === 'SENDING') this.inputKind = event.inputKind || this.inputKind;
    if (event.type === 'ERROR' && !this.ready) this.fail(`${event.code || 'CONNECTION_FAILED'}: ${event.message}`);
    this.onEvent(event);
  }
  // The page facts the panel header and its Send guard are built from. Every field is optional: an older
  // or partially hydrated page reports less, and the panel must show "unknown" rather than invent a value.
  applySiteInfo(event) {
    this.inputKind = typeof event.inputKind === 'string' ? event.inputKind : (this.inputKind || 'unknown');
    this.uploadKind = typeof event.uploadKind === 'string' ? event.uploadKind : (this.uploadKind || 'none');
    this.fileInputCount = Number.isInteger(event.fileInputCount) ? event.fileInputCount : (this.fileInputCount ?? 0);
    this.historyCount = Number.isInteger(event.historyCount) ? event.historyCount : (this.historyCount ?? 0);
    this.status = typeof event.status === 'string' ? event.status : (this.status ?? '');
    this.statusKind = typeof event.statusKind === 'string' ? event.statusKind : (this.statusKind ?? 'none');
    this.busy = typeof event.busy === 'boolean' ? event.busy : this.busy;
    this.confirmationPending = typeof event.confirmationPending === 'boolean' ? event.confirmationPending : this.confirmationPending;
    this.conversationId = typeof event.conversationId === 'string' ? event.conversationId : (this.conversationId ?? '');
    this.conversationName = typeof event.conversationName === 'string' ? event.conversationName : (this.conversationName ?? '');
    this.pageKind = event.pageKind === 'conversation' ? 'conversation' : 'home';
    this.blocked = typeof event.blocked === 'string' ? event.blocked : '';
    if (event.state && typeof event.state === 'object') this.state = event.state;
    // A semantic capability snapshot (see core.js capabilitySummary). Absent on older adapters, in which
    // case the panel reports that no check was sent instead of inventing one.
    if (event.capabilities && typeof event.capabilities === 'object') this.capabilities = event.capabilities;
    if (typeof event.url === 'string') this.url = event.url;
  }

  querySite() { this.post({ type: 'SITE' }); }

  // Unexpected loss (tab reloaded, discarded or closed). The panel decides whether to reattach; this class
  // never reconnects on its own, because an automatic reconnect could resume tracking the wrong document.
  lost(message) {
    if (this.closed) return;
    const wasReady = this.ready;
    this.fail(message);
    this.close();
    this.onEvent({ type: 'BRIDGE_LOST', code: 'CONNECTION_LOST', message, wasReady });
  }
  post(message) {
    if (this.closed || !this.port) throw new Error('The OpenHands connection is not ready.');
    this.port.postMessage(message);
  }
  fail(message) { clearTimeout(this.timeout); this.reject(new Error(message)); }

  async send(requestId, prompt, url, attachments) {
    if (this.closed || !this.ready || this.silent)
      throw new Error('The OpenHands adapter is not responding. Open the OpenHands tab before sending.');
    if (attachments?.length) {
      // A single-use, 20-second permission for the page-context file insertion of this one Send. Bounded,
      // so a restarting worker cannot leave the panel stuck with bytes still staged.
      let grant;
      try {
        grant = await withTimeout(
          chrome.runtime.sendMessage({ type: 'STAGE_GRANT', tabId: this.tabId, documentId: this.documentId }),
          this.timeouts.grant,
          `The extension worker did not confirm the staged files within ${Math.round(this.timeouts.grant / 1000)} seconds. Reload the OpenHands tab and try again. Nothing was sent.`);
      } catch (error) {
        if (error?.name === 'TimeoutError') throw error;
        throw new Error(`The extension worker could not confirm the staged files (${error?.message || 'no response'}). Reload this panel and the OpenHands tab, then try again. Nothing was sent.`);
      }
      if (!grant?.ok) throw new Error(grant?.error || 'The staged files could not be prepared. Nothing was sent.');
      if (this.closed || !this.ready) throw new Error('The OpenHands connection closed before sending. Nothing was sent.');
    }
    this.post({ type: 'SEND', requestId, prompt, url, ...(attachments?.length ? { attachments } : {}) });
  }
  // Resume tracking an already-accepted message after a reconnect or a page reload. Strictly read-only:
  // this path never writes the composer and never clicks.
  watch(requestId, prompt, url, { hadAttachments = false, baseline = [] } = {}) {
    if (this.closed || !this.ready) throw new Error('The OpenHands connection is not ready.');
    this.post({
      type: 'WATCH', requestId, prompt, url, hadAttachments: !!hadAttachments,
      baseline: Array.isArray(baseline) ? baseline.filter(id => typeof id === 'string').slice(0, 400) : []
    });
  }
  // Answer OpenHands' "Do you want to continue with this action?" card: one click, exactly one direction.
  confirm(requestId, accept) {
    if (this.closed || !this.ready) throw new Error('The OpenHands connection is not ready.');
    if (typeof accept !== 'boolean') throw new Error('Choose Confirm or Reject.');
    this.post({ type: 'CONFIRM', requestId, accept });
  }
  // Explicit agent-level passthrough: 'stop' the running agent or 'resume' a paused one. One click on
  // OpenHands' own control, decided by the user in the panel — never automatic, never retried.
  control(name) {
    if (this.closed || !this.ready) throw new Error('The OpenHands connection is not ready.');
    if (name !== 'stop' && name !== 'resume') throw new Error('Unknown agent control.');
    this.post({ type: 'CONTROL', control: name });
  }
  loadHistory(requestId, url) {
    if (this.closed || !this.ready) throw new Error('The OpenHands connection is not ready.');
    this.post({ type: 'LOAD_HISTORY', requestId, url });
  }
  cancel(requestId) {
    if (this.closed) return;
    try { this.port?.postMessage({ type: 'CANCEL', requestId }); } catch { /* already closed */ }
    this.revokeStage();
  }
  // Best effort and never throws: this runs from teardown paths (cancel, close, connection lost), where a
  // synchronous "Extension context invalidated" error would break the caller instead of merely skipping a
  // stale grant the worker drops on its own after 20 seconds.
  revokeStage() {
    if (!this.documentId) return;
    try { chrome.runtime.sendMessage({ type: 'STAGE_REVOKE', tabId: this.tabId, documentId: this.documentId })?.catch(() => {}); }
    catch { /* extension context already gone */ }
  }
  shutdown() {
    this.closed = true; this.ready = false;
    clearInterval(this.heartbeat); clearTimeout(this.timeout);
  }
  close() {
    if (this.closed) return;
    this.shutdown();
    this.reject(new Error('OpenHands connection closed.'));
    try { this.port?.disconnect(); } catch { /* already closed */ }
    this.revokeStage();
  }
}
