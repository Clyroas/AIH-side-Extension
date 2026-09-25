// Panel-only attachment ownership. Metadata is never an identity: a File is only ever re-found through the
// object the user picked, never by matching a name or a size again later.
import './attachment-policy.js'; // Registers OpenHandsSideAttachments (the same text the page adapter loads).

const A = globalThis.OpenHandsSideAttachments;

// `already` is what the panel has staged for this message, so OpenHands' 3 MB combined cap is checked
// against the whole pick, not each file on its own.
export function selectAttachments(files, already = []) {
  const originals = Array.from(files || []);
  const held = (Array.isArray(already) ? already : []).map(item => ({ size: Number(item?.size) || 0 }));
  const { accepted, rejected, totalBytes } = A.validateAttachments(originals, {
    existing: held,
    limit: Math.max(0, A.ATTACHMENT_POLICY.maxFiles - held.length)
  });
  return {
    accepted: accepted.map(({ sourceIndex, ...meta }) => ({ ...meta, file: originals[sourceIndex] })),
    rejected,
    totalBytes
  };
}

// Read the picked bytes and encode them for the one transport hop (panel → content script → main world).
// The result is held only until the send is accepted or refused; see releaseTurnAttachments.
export async function encodeAttachments(items) {
  const payload = [];
  for (const item of items) {
    let buffer;
    try { buffer = await item.file.arrayBuffer(); }
    catch (error) { throw new Error(`“${item.name}” could not be read (${error?.message || 'unknown error'}). Nothing was sent.`); }
    const bytes = new Uint8Array(buffer);
    if (bytes.byteLength !== item.size)
      throw new Error(`“${item.name}” changed size while it was being read. Nothing was sent; pick the file again.`);
    payload.push({ name: item.name, type: item.type, data: A.bytesToBase64(bytes) });
  }
  return payload;
}

// JS cannot guarantee memory erasure. Drop the references and blank the transport strings; never retain
// encoded bytes in the conversation history that outlives the turn.
export function releaseTurnAttachments(turn) {
  if (!turn) return;
  if (turn.payload) for (const item of turn.payload) item.data = '';
  turn.payload = null;
  turn.files = null;
}

// Only call when no Send click was attempted. Staging may already have touched the OpenHands composer;
// restoring a local draft is not permission to retry the send automatically.
export function restoreTurnAttachments(turn) {
  const files = (turn?.files || []).map((file, index) => ({ ...turn.attachments?.[index], file }));
  releaseTurnAttachments(turn);
  return files;
}
