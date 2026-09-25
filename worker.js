// MV3 service worker. Deliberately thin: the panel holds a DIRECT port to the OpenHands tab's content
// script, so Chrome suspending this idle worker can never drop a conversation. What remains here are the
// things only a worker can do — inject and verify the page adapter, relay a single-use file-staging grant,
// list and focus tabs, and open OpenHands.
//
// There is no credential access, no private API call, no network request and no retained conversation
// state in this file. Staged file bytes exist only for the duration of one relay call.
import { openHandsSideStageFiles } from './stage-main.js';
import { attachAgent } from './attachment.js';
import { HOME_URL, SITE_ORIGIN, VERSION, isOpenHands, isChatUrl } from './core.js';

// Single-use grants for page-context file insertion, issued only to the pinned content script of the
// OpenHands tab that an explicit staged-file Send was relayed to. Bytes are never stored, logged, cached
// or sent anywhere else, and each grant is consumed on first use.
const STAGE_WINDOW_MS = 20000;
const stageGrants = new Map(); // `${tabId}:${documentId}` -> expiry timestamp

function pruneGrants() {
  const now = Date.now();
  for (const [key, until] of stageGrants) if (until <= now) stageGrants.delete(key);
}
function releaseDocument(documentId) {
  for (const key of [...stageGrants.keys()]) if (key.endsWith(`:${documentId}`)) stageGrants.delete(key);
}

// ---- requests from the content script (staging only) -----------------------------------------
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === 'CLEAR_STAGE') { if (sender.documentId) releaseDocument(sender.documentId); respond({ ok: true }); return; }
  if (message?.type !== 'STAGE_FILES') return;
  const tabId = sender.tab?.id, documentId = sender.documentId;
  const deny = (code, error) => { respond({ ok: false, code, error }); return false; };
  if (!Number.isInteger(tabId) || sender.frameId !== 0 || !documentId || !isOpenHands(sender.url))
    return deny('STAGE_UNBOUND', 'The staging request did not come from the connected OpenHands top frame. Nothing was inserted.');
  pruneGrants();
  const key = `${tabId}:${documentId}`;
  if (!stageGrants.has(key)) return deny('STAGE_UNBOUND', 'No pending staged-file send is attached to this OpenHands document. Nothing was inserted.');
  const grantExpiry = stageGrants.get(key);
  stageGrants.delete(key); // single use: another attempt needs a fresh explicit Send
  if (!Number.isFinite(message.expiresAt) || message.expiresAt <= Date.now())
    return deny('STAGE_EXPIRED', 'The staged-file request expired. Nothing was inserted.');
  const expiresAt = Math.min(message.expiresAt, grantExpiry);
  const files = Array.isArray(message.files) ? message.files : [];
  // OpenHands caps attachments at 3 MB per file and 3 MB combined; ~4 MB of base64 covers that with room
  // for the encoding overhead. Anything larger is refused before it reaches the page.
  const MAX_ENCODED = 4 * Math.ceil((3 * 1024 * 1024) / 3);
  if (!files.length || files.length > 8 || !/^[\da-f-]{36}$/i.test(String(message.token || '')) ||
      files.some(file => typeof file?.name !== 'string' || typeof file?.type !== 'string' ||
        typeof file?.data !== 'string' || file.data.length > MAX_ENCODED))
    return deny('INVALID_ATTACHMENT', 'The staged files were rejected before reaching the page. Nothing was inserted.');
  (async () => {
    const results = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, world: 'MAIN',
      func: openHandsSideStageFiles, args: [{ token: message.token, expiresAt, files }]
    });
    return { ok: true, value: results?.find(entry => entry.frameId === 0)?.result ?? null };
  })().then(respond, error => respond({ ok: false, code: 'STAGE_FAILED', error: error?.message || 'Chrome could not run the staging step. Nothing was inserted.' }));
  return true; // the response is asynchronous
});

// ---- lifecycle -------------------------------------------------------------------------------
async function configure() {
  // The toolbar icon opens the docked side panel next to the OpenHands tab.
  try { await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }); }
  catch (error) { console.warn('Side panel unavailable:', error.message); }
}
chrome.runtime.onInstalled.addListener(configure);
chrome.runtime.onStartup.addListener(configure);

// Fallback only: Chrome fires onClicked when the side panel cannot be opened from the icon (for example
// while another panel owns the window). Opening it for the current window is still a user gesture.
chrome.action.onClicked.addListener(async tab => {
  try { await chrome.sidePanel.open({ windowId: tab.windowId }); }
  catch (error) { console.warn('Side panel could not be opened:', error.message); }
});

const isPanelPage = url => url === chrome.runtime.getURL('panel.html');

// Only these OpenHands addresses may be opened from the panel, and only in a tab that is already on the
// site. Query strings and hashes are refused so no state can be smuggled through a navigation.
function allowedTarget(raw) {
  let target;
  try { target = new URL(String(raw || '')); } catch { return ''; }
  if (target.origin !== SITE_ORIGIN || target.search || target.hash) return '';
  const path = target.pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/conversations') return target.origin + path;
  return /^\/conversations\/[A-Za-z0-9._-]{1,64}$/.test(path) ? target.origin + path : '';
}

// ---- one-shot requests from the panel ---------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || !isPanelPage(sender.url)) return;
  (async () => {
    switch (message?.type) {
      case 'VERSION':
        return { version: VERSION, site: SITE_ORIGIN };
      case 'LIST_TABS': {
        const tabs = await chrome.tabs.query({ url: `${SITE_ORIGIN}/*` });
        return tabs.map(({ id, windowId, title, url, active }) => ({ id, windowId, title, url, active: !!active }));
      }
      case 'GET_TAB':
      case 'FOCUS_TAB': {
        if (!Number.isInteger(message.tabId)) throw new Error('Choose an OpenHands tab.');
        const tab = await chrome.tabs.get(message.tabId);
        if (!isOpenHands(tab.url)) throw new Error('This tab is no longer on OpenHands. Reconnect to a conversation.');
        if (message.type === 'FOCUS_TAB') {
          await chrome.windows.update(tab.windowId, { focused: true });
          await chrome.tabs.update(tab.id, { active: true });
        }
        return { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url, discarded: !!tab.discarded, status: tab.status };
      }
      case 'ATTACH': {
        if (!Number.isInteger(message.tabId)) throw new Error('Choose an OpenHands tab first.');
        const attached = await attachAgent(message.tabId, message.expectedUrl);
        return { documentId: attached.documentId, url: attached.url };
      }
      case 'STAGE_GRANT': {
        // The panel is about to relay a staged-file Send to this exact document: allow one insertion.
        if (!Number.isInteger(message.tabId) || typeof message.documentId !== 'string' || !message.documentId)
          throw new Error('No connected OpenHands document for the staged files.');
        pruneGrants();
        stageGrants.set(`${message.tabId}:${message.documentId}`, Date.now() + STAGE_WINDOW_MS);
        return true;
      }
      case 'STAGE_REVOKE': {
        if (Number.isInteger(message.tabId) && typeof message.documentId === 'string')
          stageGrants.delete(`${message.tabId}:${message.documentId}`);
        return true;
      }
      case 'NAVIGATE_TAB': {
        // Explicit user action from the panel: open the launcher (a new conversation), the conversation
        // list, or return to the connected conversation. Nothing else can be navigated to.
        if (!Number.isInteger(message.tabId)) throw new Error('Choose an OpenHands tab first.');
        const url = allowedTarget(message.url);
        if (!url) throw new Error('Only the OpenHands launcher, the conversation list or the connected conversation can be opened from the panel.');
        const tab = await chrome.tabs.get(message.tabId);
        if (!isOpenHands(tab.url)) throw new Error('This tab is no longer on OpenHands.');
        // A conversation that is still starting hydrates lazily in a background tab, which would leave the
        // panel waiting on a composer that never appears. Foregrounding this one explicit navigation is the
        // same trade-off OpenHands' own links make.
        const win = await chrome.windows.get(tab.windowId);
        const wasMinimized = win.state === 'minimized';
        await chrome.windows.update(tab.windowId, { focused: true, ...(wasMinimized ? { state: 'normal' } : {}) });
        await chrome.tabs.update(tab.id, { url, active: true });
        return { windowId: tab.windowId, wasMinimized, url };
      }
      case 'RESTORE_TAB': {
        const { windowId, wasMinimized } = message || {};
        if (wasMinimized && Number.isInteger(windowId)) await chrome.windows.update(windowId, { state: 'minimized' }).catch(() => {});
        return true;
      }
      case 'OPEN_SITE': {
        const url = allowedTarget(message.url || '/') || HOME_URL;
        if (!isChatUrl(url)) throw new Error('Only an OpenHands chat page can be opened.');
        const tab = await chrome.tabs.create({ url });
        return { id: tab.id, url };
      }
      default:
        throw new Error('Unsupported companion action.');
    }
  })().then(value => respond({ ok: true, value }), error => respond({ ok: false, code: error.code, error: error.message || 'Chrome action failed.' }));
  return true;
});

// There is no long-lived relay here: the panel talks to the content script directly, so this worker being
// suspended while idle cannot drop a conversation.
