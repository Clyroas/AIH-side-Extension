import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

// The staging helper is serialized into OpenHands' MAIN world by the worker. It is evaluated here inside a
// jsdom window with two deliberate stand-ins, both documented: jsdom has no DataTransfer constructor and no
// writable native `files` setter, so the harness provides a minimal DataTransfer and a prototype setter
// that records what was assigned. The refusal paths need neither.
const source = readFileSync(new URL('../stage-main.js', import.meta.url), 'utf8');
const MB = 1024 * 1024;
const TOKEN = '11111111-2222-4333-8444-555555555555';

function open(marker = TOKEN) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://app.all-hands.dev/conversations/abc', runScripts: 'outside-only' });
  const { window } = dom;
  const input = window.document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = '*/*';
  input.setAttribute('data-testid', 'upload-image-input');
  if (marker) input.setAttribute('data-oh-side-stage', marker);
  window.document.body.append(input);
  const assigned = [];
  window.DataTransfer = class DataTransfer {
    constructor() { this.items = { add: file => assigned.push(file) }; }
    get files() { return assigned; }
  };
  Object.defineProperty(window.HTMLInputElement.prototype, 'files', {
    configurable: true,
    get() { return this.__files || null; },
    set(value) { this.__files = value; }
  });
  window.eval(`${source.replace('export async function', 'async function')}; globalThis.__stage = openHandsSideStageFiles;`);
  return { window, input, assigned, stage: request => window.__stage(request) };
}
// The helper re-checks the decoded size against the size the panel reported, so both are supplied here.
const file = (name, type, text) => ({ name, type, size: Buffer.byteLength(text), data: Buffer.from(text, 'utf8').toString('base64') });
const raw = (name, type, bytes) => ({ name, type, size: bytes.length, data: Buffer.from(bytes).toString('base64') });
const fresh = () => Date.now() + 9000;

test('an expired or malformed request inserts nothing', async () => {
  const page = open();
  const expired = await page.stage({ token: TOKEN, expiresAt: Date.now() - 1, files: [file('a.txt', 'text/plain', 'x')] });
  assert.equal(expired.ok, false);
  const farFuture = await page.stage({ token: TOKEN, expiresAt: Date.now() + 60000, files: [file('a.txt', 'text/plain', 'x')] });
  assert.equal(farFuture.ok, false);
  const badToken = await page.stage({ token: 'nope', expiresAt: fresh(), files: [file('a.txt', 'text/plain', 'x')] });
  assert.equal(badToken.ok, false);
  const tooMany = await page.stage({ token: TOKEN, expiresAt: fresh(), files: Array.from({ length: 9 }, (_, i) => file(`a${i}.txt`, 'text/plain', 'x')) });
  assert.equal(tooMany.ok, false);
  assert.equal(page.input.files, null);
});

test('the marker must name exactly one live input', async () => {
  const none = open(null);
  assert.equal((await none.stage({ token: TOKEN, expiresAt: fresh(), files: [file('a.txt', 'text/plain', 'x')] })).ok, false);
  const page = open();
  const twin = page.window.document.createElement('input');
  twin.type = 'file';
  twin.setAttribute('data-oh-side-stage', TOKEN);
  page.window.document.body.append(twin);
  const result = await page.stage({ token: TOKEN, expiresAt: fresh(), files: [file('a.txt', 'text/plain', 'x')] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /replaced, cancelled or duplicated/);
});

test('unsupported types, oversize files and the 3 MB combined cap are refused in the page', async () => {
  // One page per case: a refusal that reaches the insertion step consumes the single-use marker, which is
  // exactly what makes a late retry impossible.
  const exe = open();
  const executable = await exe.stage({ token: TOKEN, expiresAt: fresh(), files: [file('tool.exe', 'application/x-msdownload', 'x')] });
  assert.equal(executable.ok, false);
  assert.match(executable.reason, /supported types/);
  assert.equal(exe.input.files, null, 'nothing was inserted');
  assert.equal(exe.input.getAttribute('data-oh-side-stage'), TOKEN, 'the grant survives a pre-insertion refusal');

  const big = open();
  const oversize = await big.stage({ token: TOKEN, expiresAt: fresh(), files: [raw('big.txt', 'text/plain', Buffer.alloc(3 * MB + 8, 65))] });
  assert.equal(oversize.ok, false);
  // Either the transport cap or the 3 MB file cap refuses it; both are refusals, never a partial insert.
  assert.match(oversize.reason, /3 MB|supported types/);
  assert.equal(big.input.files, null);

  const empty = open();
  const zero = await empty.stage({ token: TOKEN, expiresAt: fresh(), files: [file('a.txt', 'text/plain', '')] });
  assert.equal(zero.ok, false);
  assert.match(zero.reason, /empty or larger than 3 MB/);

  const pair = open();
  const combined = await pair.stage({
    token: TOKEN, expiresAt: fresh(),
    files: [raw('a.txt', 'text/plain', Buffer.alloc(2 * MB, 120)), raw('b.txt', 'text/plain', Buffer.alloc(2 * MB, 121))]
  });
  assert.equal(combined.ok, false);
  assert.match(combined.reason, /3 MB combined/);
  assert.equal(pair.input.files, null);
});

test('a restricted page input is honoured rather than overridden', async () => {
  const page = open();
  page.input.accept = '.pdf';
  const refused = await page.stage({ token: TOKEN, expiresAt: fresh(), files: [file('a.txt', 'text/plain', 'x')] });
  assert.equal(refused.ok, false);
  const page2 = open();
  page2.input.accept = '.weird!format';
  const unknown = await page2.stage({ token: TOKEN, expiresAt: fresh(), files: [file('a.weird!format', 'text/plain', 'x')] });
  assert.equal(unknown.ok, false);
});

test('a single-file input refuses a multi-file staging', async () => {
  const page = open();
  page.input.multiple = false;
  const result = await page.stage({ token: TOKEN, expiresAt: fresh(), files: [file('a.txt', 'text/plain', 'x'), file('b.txt', 'text/plain', 'y')] });
  assert.equal(result.ok, false);
  assert.match(result.reason, /only one file/);
});

test('the happy path assigns a native FileList, consumes the marker and reports what landed', async () => {
  const page = open();
  const events = [];
  page.input.addEventListener('change', () => events.push('change'));
  page.input.addEventListener('input', () => events.push('input'));
  const result = await page.stage({
    token: TOKEN, expiresAt: fresh(),
    files: [file('notes.md', 'text/markdown', '# hi'), file('shot.png', 'image/png', 'png')]
  });
  assert.equal(result.ok, true);
  // The result object comes from the page realm, so it is spread into this one before a deep comparison.
  assert.deepEqual([...result.files].map(item => item.name), ['notes.md', 'shot.png']);
  assert.deepEqual([...result.files].map(item => item.size), [4, 3]);
  assert.deepEqual([...page.input.files].map(item => item.name), ['notes.md', 'shot.png']);
  assert.equal(page.input.files[0] instanceof page.window.File, true);
  // The grant is single-use: the marker is gone before any page event fired.
  assert.equal(page.input.getAttribute('data-oh-side-stage'), null);
  assert.deepEqual(events, ['input', 'change']);
  // The native setter was used, so no own property shadows later page or user changes.
  assert.equal(Object.hasOwn(page.input, 'files'), false);
  page.input.files = null;
  assert.equal(page.input.files, null);
});

test('a cancelled marker cannot be reused by a late helper', async () => {
  const page = open();
  page.input.removeAttribute('data-oh-side-stage');
  const result = await page.stage({ token: TOKEN, expiresAt: fresh(), files: [file('a.txt', 'text/plain', 'x')] });
  assert.equal(result.ok, false);
});
