// Serialized into OpenHands' main world exactly once, for an explicitly approved, single-use staged-file
// send. It reads only this extension's own marker attribute and the bytes handed to it. It never touches
// page storage, account data, credentials, network or OpenHands internals — the only page interaction is
// the site's own `<input type="file" data-testid="upload-image-input">` and the change event React listens
// for (frontend/src/components/features/chat/components/hidden-file-input.tsx).
//
// Limits are re-checked here rather than trusted from the isolated world: 8 files, 3 MB each, 3 MB total
// (frontend/src/utils/file-validation.ts).
export async function openHandsSideStageFiles(request) {
  'use strict';
  const fail = reason => ({ ok: false, reason });
  const MAX_FILES = 8, MAX_BYTES = 3 * 1024 * 1024;
  const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/svg+xml',
    'application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/rtf',
    'text/html', 'application/xml', 'text/css', 'application/json', 'text/yaml', 'text/toml',
    'text/javascript', 'text/typescript', 'text/x-python', 'text/x-ruby', 'text/x-go', 'text/x-rust',
    'text/x-java', 'text/x-kotlin', 'text/x-c', 'text/x-c++', 'text/x-csharp', 'text/x-php', 'text/x-swift',
    'text/x-scala', 'text/x-shellscript', 'text/x-sql', 'text/x-r', 'text/x-lua', 'text/x-perl',
    'text/x-elixir', 'text/x-dart', 'text/x-diff'];
  // Filenames are validated by code point, so no control-character regex literal is needed here.
  const NAME_FORBIDDEN = /[\/\\:*?"<>|]/;
  const validName = name => {
    const value = String(name);
    if (!value || value.length > 240 || NAME_FORBIDDEN.test(value)) return false;
    for (const ch of value) { const code = ch.codePointAt(0); if (code < 0x20 || code === 0x7f) return false; }
    return true;
  };
  try {
    const token = String(request?.token || ''), expiresAt = request?.expiresAt;
    const files = Array.isArray(request?.files) ? request.files : null;
    if (!/^[\da-f-]{36}$/i.test(token) || !files?.length || files.length > MAX_FILES ||
        !Number.isFinite(expiresAt) || Date.now() >= expiresAt || expiresAt > Date.now() + 30000)
      return fail('The staging request is malformed or expired.');
    const matches = [...document.querySelectorAll(`input[type="file"][data-oh-side-stage="${token}"]`)];
    if (matches.length !== 1) return fail('The staged file input was replaced, cancelled or duplicated.');
    const input = matches[0];
    if (input.disabled || input.closest('[inert]')) return fail('The page file input is unavailable.');
    if (files.length > 1 && !input.multiple) return fail('The page file input accepts only one file.');
    // The site declares accept="*/*"; anything narrower is only honoured if every token is understood.
    const tokens = String(input.accept || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
    const known = value => ['file', '*/*', 'image/*', 'text/*'].includes(value) ||
      (value.startsWith('.') ? /^[a-z0-9]+$/.test(value.slice(1)) : TYPES.includes(value));
    if (!tokens.every(known)) return fail('The page file input has restrictions this version does not recognize.');
    const canonical = type => (type === 'application/javascript' ? 'text/javascript' : type);
    const accepts = (name, type) => !tokens.length || tokens.some(value => value === 'file' || value === '*/*' ||
      (value.startsWith('.') ? name.toLowerCase().endsWith(value)
        : value.endsWith('/*') ? type.startsWith(value.slice(0, -1)) : canonical(value) === canonical(type)));

    const transfer = new DataTransfer();
    let total = 0;
    for (const item of files) {
      const name = item?.name, type = canonical(String(item?.type || ''));
      if (typeof name !== 'string' || !validName(name.trim()) || !TYPES.includes(type) ||
          typeof item.data !== 'string' || item.data.length > 4 * Math.ceil(MAX_BYTES / 3) || !accepts(name, type))
        return fail('A staged file does not match the supported types or the page input.');
      const binary = atob(item.data), bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      if (!bytes.length || bytes.length > MAX_BYTES) return fail('A staged file was empty or larger than 3 MB.');
      total += bytes.length;
      if (total > MAX_BYTES) return fail('The staged files exceed the 3 MB combined limit OpenHands enforces.');
      transfer.items.add(new File([bytes], name, { type }));
    }

    // Re-check immediately before touching the input. There is no await between here and the insertion.
    if (Date.now() >= expiresAt || !input.isConnected || input.getAttribute('data-oh-side-stage') !== token)
      return fail('The staging request expired or was cancelled.');
    input.removeAttribute('data-oh-side-stage'); // consume the grant before dispatching any page event
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files')?.set;
    if (!setter) return fail('This browser has no supported file input setter.');
    setter.call(input, transfer.files); // a native FileList: no own-property shadow, nothing retained
    const seen = [...input.files].map(file => ({ name: file.name, size: file.size, type: file.type }));
    if (seen.length !== files.length || seen.some((file, i) => file.name !== files[i].name || file.size !== files[i].size))
      return fail('The page file input did not report the staged files.');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true })); // useFileHandling → handleFileInputChange
    // This acknowledges native insertion into the composer, not completion of OpenHands' own upload.
    return { ok: true, files: seen };
  } catch {
    return fail('The file staging step failed in the page.');
  }
}
