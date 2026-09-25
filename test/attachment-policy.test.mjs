import test from 'node:test';
import assert from 'node:assert/strict';
import '../attachment-policy.js';

const A = globalThis.OpenHandsSideAttachments;
const MB = 1024 * 1024;

test('the policy mirrors what OpenHands itself enforces', () => {
  // frontend/src/utils/file-validation.ts: MAX_FILE_SIZE = MAX_TOTAL_SIZE = 3 MB; the hidden input
  // declares accept="*/*" and multiple.
  assert.equal(A.ATTACHMENT_POLICY.accept, '*/*');
  assert.equal(A.ATTACHMENT_POLICY.maxBytes, 3 * MB);
  assert.equal(A.ATTACHMENT_POLICY.maxTotalBytes, 3 * MB);
  assert.equal(A.ATTACHMENT_POLICY.maxFiles, 8);
});

test('accepts text, code, markup and images — the files a coding agent is asked about', () => {
  const { accepted, rejected } = A.validateAttachments([
    { name: 'tests.py', type: 'application/octet-stream', size: 10 }, // browsers mis-type source files
    { name: 'shot.png', type: 'image/png', size: 10 },
    { name: 'Makefile', type: '', size: 10 },
    { name: 'notes.md', type: 'text/markdown', size: 10 },
    { name: 'diff.patch', type: 'text/plain', size: 10 }
  ]);
  assert.equal(accepted.length, 5);
  assert.equal(rejected.length, 0);
  assert.equal(accepted[0].type, 'text/x-python');
  assert.equal(accepted[2].type, 'text/plain'); // extensionless known names get a sensible type
  assert.equal(accepted[1].image, true);
});

test('refuses binaries and archives with a reason that says what to do instead', () => {
  const { accepted, rejected } = A.validateAttachments([
    { name: 'bundle.zip', type: 'application/zip', size: 10 },
    { name: 'tool.exe', type: 'application/x-msdownload', size: 10 },
    { name: 'data.sqlite3', type: 'application/octet-stream', size: 10 }
  ]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 3);
  assert.match(rejected[0].reason, /never staged/);
});

test('the 3 MB per-file and combined caps are enforced before the site sees them', () => {
  const { accepted, rejected } = A.validateAttachments([
    { name: 'big.txt', type: 'text/plain', size: 3 * MB + 1 },
    { name: 'a.txt', type: 'text/plain', size: 2 * MB },
    { name: 'b.txt', type: 'text/plain', size: 2 * MB } // combined would be 4 MB > 3 MB
  ]);
  assert.deepEqual(accepted.map(item => item.name), ['a.txt']);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason, /larger than 3 MB/);
  assert.match(rejected[1].reason, /3 MB combined/);
});

test('already-staged bytes count against the combined cap', () => {
  const { accepted, rejected } = A.validateAttachments(
    [{ name: 'more.txt', type: 'text/plain', size: 2 * MB }],
    { existing: [{ size: 2 * MB }], limit: 8 });
  assert.equal(accepted.length, 0);
  assert.match(rejected[0].reason, /3 MB combined/);
});

test('the file count cap reports the overflow without losing the accepted files', () => {
  const files = Array.from({ length: 10 }, (_, i) => ({ name: `f${i}.txt`, type: 'text/plain', size: 1 }));
  const { accepted, rejected } = A.validateAttachments(files);
  assert.equal(accepted.length, 8);
  assert.equal(rejected.length, 2);
  assert.match(rejected[0].reason, /Only 8 files/);
});

test('hostile and empty names are refused', () => {
  const { rejected } = A.validateAttachments([
    { name: '', type: 'text/plain', size: 5 },
    { name: 'a/b.txt', type: 'text/plain', size: 5 },
    { name: 'weird\u0000.txt', type: 'text/plain', size: 5 },
    { name: 'empty.txt', type: 'text/plain', size: 0 },
    { name: `${'x'.repeat(241)}.txt`, type: 'text/plain', size: 5 }
  ]);
  assert.equal(rejected.length, 5);
});

test('the site input accept="*/*" allows every policy type', () => {
  assert.equal(A.acceptAllows('*/*'), true);
  assert.equal(A.acceptsFile('*/*', { name: 'x.py', type: 'text/x-python' }), true);
  assert.equal(A.acceptAllows('image/png,.md'), true);
  assert.equal(A.acceptAllows('.exe'), false); // not in the extension allowlist
});

test('decodeAttachment re-validates bytes crossing the port and round-trips', () => {
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const data = A.bytesToBase64(bytes);
  const decoded = A.decodeAttachment({ name: 'bin.txt', type: 'text/plain', data });
  assert.deepEqual([...decoded.bytes], [1, 2, 3, 250]);
  assert.deepEqual([...A.base64ToBytes(data)], [1, 2, 3, 250]);
  assert.throws(() => A.decodeAttachment({ name: 'x.txt', type: 'text/plain', data: '!!!' }), /Invalid encoded|reason|atob|character/i);
  assert.throws(() => A.decodeAttachment({ name: 'x.exe', type: 'application/x-msdownload', data: A.bytesToBase64(new Uint8Array([1])) }), /never staged/);
  assert.throws(() => A.decodeAttachment({ name: 'x.txt', type: 'text/plain', data: 'A'.repeat(4 * Math.ceil(3 * MB / 3) + 4) }), /3 MB/);
});

test('formatBytes is honest about unknown sizes', () => {
  assert.equal(A.formatBytes(512), '512 B');
  assert.equal(A.formatBytes(2048), '2.0 KB');
  assert.equal(A.formatBytes(5 * MB), '5.0 MB');
  assert.equal(A.formatBytes(-1), 'unknown size');
  assert.equal(A.formatBytes(Number.NaN), 'unknown size');
});
