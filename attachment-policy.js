// Pure attachment rules, shared by the panel UI, the page adapter and the tests.
//
// The limits mirror what OpenHands itself enforces (frontend/src/utils/file-validation.ts:
// MAX_FILE_SIZE = MAX_TOTAL_SIZE = 3 MB, `<input type="file" multiple accept="*/*">`), so the panel can
// refuse an oversized pick up front instead of letting the site swallow it into an error toast after
// Send was already clicked. On top of that, this extension only ever stages text-like and image files:
// bytes come from an explicit user pick in the panel, and an allowlist keeps an accidental binary out of
// a page-context write.
//
// Dual format: an ESM module for the extension pages and a window global for the classic content script.
(() => {
  'use strict';

  const VERSION = '1.0.0';
  if (globalThis.OpenHandsSideAttachments?.version === VERSION) return;

  const MB = 1024 * 1024;
  const ATTACHMENT_POLICY = Object.freeze({
    maxFiles: 8,
    maxBytes: 3 * MB,        // OpenHands: per file
    maxTotalBytes: 3 * MB,   // OpenHands: all attachments combined
    accept: '*/*',           // what the site's input declares
    // Extension → canonical MIME. Source-code types are included because OpenHands is a coding agent
    // and its own input accepts them.
    types: Object.freeze({
      // images (the site routes these through its image pipeline)
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif',
      // documents
      pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown',
      csv: 'text/csv', tsv: 'text/tab-separated-values', log: 'text/plain', rtf: 'text/rtf',
      // markup / data
      html: 'text/html', htm: 'text/html', xml: 'application/xml', svg: 'image/svg+xml', css: 'text/css',
      json: 'application/json', jsonl: 'application/json', yaml: 'text/yaml', yml: 'text/yaml',
      toml: 'text/toml', ini: 'text/plain', conf: 'text/plain', env: 'text/plain', properties: 'text/plain',
      // code
      js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', jsx: 'text/javascript',
      ts: 'text/typescript', tsx: 'text/typescript', py: 'text/x-python', rb: 'text/x-ruby',
      go: 'text/x-go', rs: 'text/x-rust', java: 'text/x-java', kt: 'text/x-kotlin', c: 'text/x-c',
      h: 'text/x-c', cpp: 'text/x-c++', hpp: 'text/x-c++', cc: 'text/x-c++', cs: 'text/x-csharp',
      php: 'text/x-php', swift: 'text/x-swift', scala: 'text/x-scala', sh: 'text/x-shellscript',
      bash: 'text/x-shellscript', zsh: 'text/x-shellscript', sql: 'text/x-sql', r: 'text/x-r',
      lua: 'text/x-lua', pl: 'text/x-perl', ex: 'text/x-elixir', exs: 'text/x-elixir', dart: 'text/x-dart',
      vue: 'text/html', svelte: 'text/html', diff: 'text/x-diff', patch: 'text/x-diff'
    })
  });
  const MIME_TYPES = Object.freeze([...new Set(Object.values(ATTACHMENT_POLICY.types))]);
  // Common files a coding agent is asked about that carry no extension at all.
  const EXTENSIONLESS = Object.freeze(['makefile', 'dockerfile', 'license', 'readme', 'notice', 'authors',
    'changelog', 'contributors', 'gemfile', 'rakefile', 'procfile', 'justfile', 'taskfile', '.gitignore',
    '.dockerignore', '.editorconfig', '.npmrc', '.env']);
  // Never staged, even though the site's input would accept them: opaque binaries cannot be reviewed and
  // an archive is usually a mistake rather than an attachment.
  const BLOCKED_EXT = Object.freeze(['exe', 'dll', 'so', 'dylib', 'bin', 'msi', 'dmg', 'pkg', 'apk', 'ipa',
    'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'iso', 'img', 'class', 'jar', 'war', 'pyc',
    'pyd', 'node', 'wasm', 'o', 'a', 'db', 'sqlite', 'sqlite3']);
  // Filenames are validated by code point, not by a regex with control characters: a regex literal for
  // NUL..US would be a control-character regex, and names like that are exactly what we must refuse.
  const NAME_FORBIDDEN = /[\/\\:*?"<>|]/;
  const validName = name => {
    const value = String(name);
    if (!value || value.length > 240 || NAME_FORBIDDEN.test(value)) return false;
    for (const ch of value) { const code = ch.codePointAt(0); if (code < 0x20 || code === 0x7f) return false; }
    return true;
  };

  const canonicalMime = type => {
    const value = String(type || '').toLowerCase().trim();
    return value === 'application/javascript' ? 'text/javascript' : value;
  };
  const extensionOf = name => String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';

  // Accept attributes may be extensions (.png), MIME types (image/png) or the generic 'file' / '*/*'.
  function isAcceptedToken(token) {
    const value = String(token).trim().toLowerCase();
    if (!value || value === 'file' || value === '*/*' || value === 'image/*' || value === 'text/*') return true;
    if (/^\.[a-z0-9]+$/.test(value)) return Object.hasOwn(ATTACHMENT_POLICY.types, value.slice(1));
    return MIME_TYPES.includes(value);
  }
  function acceptAllows(accept) {
    const tokens = String(accept || '').split(/[,\s]+/).filter(Boolean);
    return tokens.every(isAcceptedToken);
  }
  function acceptsFile(accept, file) {
    if (!acceptAllows(accept)) return false;
    const tokens = String(accept || '').toLowerCase().split(/[,\s]+/).filter(Boolean);
    const type = canonicalMime(file?.type) || attachmentKind(file?.name, file?.type);
    return !tokens.length || tokens.some(token => token === 'file' || token === '*/*' ||
      (token.startsWith('.') ? String(file?.name || '').toLowerCase().endsWith(token)
        : token.endsWith('/*') ? type.startsWith(token.slice(0, -1)) : canonicalMime(token) === type));
  }
  // The MIME this extension will hand the page: derived from the name first (browsers report
  // application/octet-stream for plenty of real text files), then from the declared type.
  function attachmentKind(name = '', type = '') {
    const ext = extensionOf(name);
    if (Object.hasOwn(ATTACHMENT_POLICY.types, ext)) return ATTACHMENT_POLICY.types[ext];
    const mime = canonicalMime(type);
    if (MIME_TYPES.includes(mime)) return mime;
    if (!ext && EXTENSIONLESS.includes(String(name).toLowerCase().trim())) return 'text/plain';
    return '';
  }
  const isImage = type => canonicalMime(type).startsWith('image/');

  // `existing` is the byte total already sitting in the OpenHands composer (chips the user attached
  // there by hand), so the combined 3 MB limit is honoured rather than only this pick's total.
  function validateAttachments(files = [], { existing = [], limit = ATTACHMENT_POLICY.maxFiles } = {}) {
    const accepted = [], rejected = [];
    const capacity = Math.max(0, Math.min(ATTACHMENT_POLICY.maxFiles, Number.isInteger(limit) ? limit : 0));
    let total = [...existing].reduce((sum, item) => sum + (Number(item?.size) || 0), 0);
    for (const [sourceIndex, file] of Array.from(files).entries()) {
      const name = String(file?.name || '').trim();
      const ext = extensionOf(name);
      if (!validName(name)) { rejected.push({ name: name || 'Unnamed file', reason: 'The filename is missing, too long or contains characters OpenHands cannot store.' }); continue; }
      if (BLOCKED_EXT.includes(ext)) { rejected.push({ name, reason: `${ext.toUpperCase()} files are never staged. Attach it in the OpenHands tab if you need it there.` }); continue; }
      const type = attachmentKind(name, file.type);
      if (!type) { rejected.push({ name, reason: 'This type is not in the supported list (text, code, markup and images only).' }); continue; }
      const size = Number(file?.size);
      if (!Number.isSafeInteger(size) || !(size > 0)) { rejected.push({ name, reason: 'The file is empty or has no readable size.' }); continue; }
      if (size > ATTACHMENT_POLICY.maxBytes) { rejected.push({ name, reason: `The file is larger than ${Math.round(ATTACHMENT_POLICY.maxBytes / MB)} MB, which OpenHands refuses.` }); continue; }
      if (accepted.length >= capacity) { rejected.push({ name, reason: `Only ${capacity} files fit in one message.` }); continue; }
      if (total + size > ATTACHMENT_POLICY.maxTotalBytes) {
        rejected.push({ name, reason: `OpenHands caps all attachments at ${Math.round(ATTACHMENT_POLICY.maxTotalBytes / MB)} MB combined; this file would exceed it.` });
        continue;
      }
      total += size;
      accepted.push({ name, type, size, sourceIndex, image: isImage(type) });
    }
    return { accepted, rejected, totalBytes: total };
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    return btoa(binary);
  }
  function base64ToBytes(text) {
    const binary = atob(String(text));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }
  // Re-validates what crossed the port: the panel is trusted for intent, never for bytes.
  function decodeAttachment(item) {
    if (!item || typeof item.name !== 'string' || typeof item.type !== 'string' || typeof item.data !== 'string')
      throw new Error('Invalid encoded attachment.');
    if (item.data.length > 4 * Math.ceil(ATTACHMENT_POLICY.maxBytes / 3))
      throw new Error(`Encoded attachment exceeds ${Math.round(ATTACHMENT_POLICY.maxBytes / MB)} MB.`);
    const bytes = base64ToBytes(item.data);
    const { accepted, rejected } = validateAttachments([{ name: item.name, type: item.type, size: bytes.byteLength }]);
    if (rejected.length) throw new Error(rejected[0].reason);
    if (accepted[0].type !== item.type) throw new Error('The attachment type does not match its filename.');
    return { name: accepted[0].name, type: accepted[0].type, bytes, image: accepted[0].image };
  }
  function formatBytes(size) {
    const value = Number(size);
    if (!Number.isFinite(value) || value < 0) return 'unknown size';
    if (value < 1024) return `${value} B`;
    if (value < MB) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
    return `${(value / MB).toFixed(1)} MB`;
  }

  globalThis.OpenHandsSideAttachments = Object.freeze({
    version: VERSION, ATTACHMENT_POLICY, MIME_TYPES, EXTENSIONLESS, BLOCKED_EXT, validName,
    isAcceptedToken, acceptAllows, acceptsFile, attachmentKind, isImage, canonicalMime,
    validateAttachments, decodeAttachment, bytesToBase64, base64ToBytes, formatBytes
  });
})();
