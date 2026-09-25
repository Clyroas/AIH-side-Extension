// Attaches the page adapter to one OpenHands tab and verifies what landed. Every failure here is a coded
// AttachmentError with a user-actionable message, and nothing on this path can type or click anything.
import { isOpenHands, samePage, VERSION } from './core.js';

export const ADAPTER_VERSION = VERSION;

export class AttachmentError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function attachAgent(tabId, expectedUrl) {
  if (!Number.isInteger(tabId)) throw new AttachmentError('INVALID_TAB', 'Choose an OpenHands tab first.');
  if (!chrome.scripting?.executeScript)
    throw new AttachmentError('EXTENSION_UPDATE_REQUIRED', `The scripting API is unavailable. Reload OpenHands Side Panel in chrome://extensions and confirm version ${ADAPTER_VERSION} with the scripting permission.`);
  if (!await chrome.permissions.contains({ origins: ['https://app.all-hands.dev/*'] }))
    throw new AttachmentError('SITE_ACCESS_REQUIRED', 'Chrome has not granted OpenHands site access. Open chrome://extensions → OpenHands Side Panel → Details → Site access and allow https://app.all-hands.dev, then reconnect. Do not grant access to all sites.');

  const before = await chrome.tabs.get(tabId);
  if (!isOpenHands(before.url)) throw new AttachmentError('WRONG_ORIGIN', 'The selected tab is not on https://app.all-hands.dev. Open your OpenHands tab and select it again.');
  if (expectedUrl && !samePage(before.url, expectedUrl))
    throw new AttachmentError('TAB_NAVIGATED', 'The selected OpenHands tab navigated before connection. Choose the conversation you want to drive and reconnect.');

  let injected;
  try {
    // Only packaged code, the selected tab's top frame, and Chrome's isolated world. Injection is
    // idempotent (the content script re-registers itself) and cannot send a message.
    injected = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED',
      files: ['attachment-policy.js', 'agent-dom.js', 'agent-content.js']
    });
  } catch (error) {
    throw new AttachmentError('CONTENT_SCRIPT_INJECTION_FAILED', `Chrome could not attach the page adapter to tab ${tabId}. Browser detail: ${error.message || 'unknown injection error'}. Check this extension's OpenHands site access, any Chrome or organization policy, and that the tab is a normal https://app.all-hands.dev page. Nothing was typed or clicked.`);
  }
  const documentId = injected?.find(result => result.frameId === 0)?.documentId;
  if (!documentId)
    throw new AttachmentError('DOCUMENT_NOT_FOUND', 'Chrome did not return the OpenHands top-frame document ID after attachment. Reload the OpenHands tab and reconnect. Nothing was typed or clicked.');

  let checks;
  try {
    checks = await chrome.scripting.executeScript({
      target: { tabId, documentIds: [documentId] }, world: 'ISOLATED',
      func: version => ({
        version: globalThis.__OH_SIDE_REGISTRATION__?.version || null,
        domVersion: globalThis.OpenHandsSideDOM?.version || null,
        attachmentsVersion: globalThis.OpenHandsSideAttachments?.version || null,
        expected: version
      }),
      args: [ADAPTER_VERSION]
    });
  } catch (error) {
    throw new AttachmentError('DOCUMENT_CHANGED', `The OpenHands document became unavailable during attachment. Browser detail: ${error.message || 'document changed'}. Wait for the page to finish loading and reconnect; nothing was typed or clicked.`);
  }
  const result = checks?.[0]?.result;
  if (result?.version !== ADAPTER_VERSION || result?.domVersion !== ADAPTER_VERSION || result?.attachmentsVersion !== ADAPTER_VERSION)
    throw new AttachmentError('SCRIPT_REGISTRATION_FAILED', `The bundled page adapter did not register version ${ADAPTER_VERSION} (it reported ${result?.version || 'nothing'}). Reload the extension and the OpenHands tab. This is an attachment problem, not an OpenHands reply timeout. Nothing was typed or clicked.`);

  const after = await chrome.tabs.get(tabId);
  if (!isOpenHands(after.url) || !samePage(after.url, before.url))
    throw new AttachmentError('TAB_NAVIGATED', 'OpenHands navigated during connection. Reconnect to the conversation you want to drive; nothing was typed or clicked.');
  return { documentId, url: after.url };
}
