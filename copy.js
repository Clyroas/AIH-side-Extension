// Copy buttons: reply text (as Markdown) and code blocks. Write-only and only on the user's click — this
// extension never reads the clipboard, and nothing is ever pasted into OpenHands this way (the composer is
// written with execCommand('insertText') inside the page, which the site itself listens for).
const LABEL_MS = 1600;

// Legacy path for the case Chrome refuses the async clipboard (an unfocused panel, or a browser build
// without the API). Uses a throwaway textarea inside the extension page, never inside OpenHands.
function legacyCopy(doc, text) {
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0;pointer-events:none';
  doc.body.append(area);
  area.select();
  let ok = false;
  try { ok = doc.execCommand('copy'); } catch { ok = false; }
  area.remove();
  return ok;
}

export async function copyText(text, button) {
  const doc = button.ownerDocument;
  const label = button.dataset.label || button.textContent;
  button.dataset.label = label;
  clearTimeout(button.copyTimer);
  const value = String(text ?? '');
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(value); ok = true; }
  } catch { ok = false; }
  if (!ok) ok = legacyCopy(doc, value);
  button.textContent = ok ? 'Copied' : 'Copy failed';
  button.dataset.state = ok ? 'ok' : 'error';
  if (!ok) button.title = 'Chrome did not allow the copy. Select the text and press Ctrl+C (⌘C on Mac).';
  button.copyTimer = setTimeout(() => {
    button.textContent = label;
    delete button.dataset.state;
    if (!ok) button.removeAttribute('title');
  }, LABEL_MS);
  return ok;
}
