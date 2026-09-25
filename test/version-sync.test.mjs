import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

// The version is a handshake: the worker checks the content script's registration, the panel checks the
// READY event's adapterVersion, and the docs name the supported frontend. All of those read the same
// string, so the copies must never drift.
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const files = JSON.parse(read('extension-files.json'));

test('every copy of the version agrees', () => {
  const version = manifest.version;
  assert.match(version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, version);
  const declared = new RegExp(`VERSION = '${version.replace(/\./g, '\\.')}'`);
  for (const file of ['core.js', 'agent-dom.js', 'agent-content.js', 'attachment-policy.js'])
    assert.match(read(file), declared, `${file} declares a different version`);
  // The panel side imports it, so it cannot drift: agent-client.js has no copy of its own.
  assert.match(read('agent-client.js'), /import \{ PORT_NAME, VERSION, withTimeout \} from '\.\/core\.js';/);
  assert.match(read('agent-client.js'), /export const ADAPTER_VERSION = VERSION;/);
  assert.equal(/VERSION = '([^']+)'/.exec(read('agent-client.js')), null);
  assert.match(read('panel.html'), new RegExp(`<title>OpenHands Side Panel · ${version}</title>`));
  assert.match(read('panel.html'), new RegExp(`id="version">v${version}<`));
  assert.match(read('manifest.json'), new RegExp(`OpenHands Side Panel · ${version}`));
});

test('the port name and origins agree across worker, content script and panel', () => {
  const core = read('core.js');
  const port = /PORT_NAME = '([^']+)'/.exec(core)?.[1];
  assert.ok(port);
  assert.match(read('agent-content.js'), new RegExp(`PORT_NAME = '${port}'`));
  assert.match(read('agent-client.js'), /PORT_NAME/);
  const origin = /SITE_ORIGIN = '([^']+)'/.exec(core)?.[1];
  assert.equal(origin, 'https://app.all-hands.dev');
  assert.match(read('manifest.json'), new RegExp(`https://app\\.all-hands\\.dev/\\*`));
  assert.match(read('agent-dom.js'), new RegExp(`ORIGIN = '${origin}'`));
});

test('the packaged file list matches the manifest and the repository', () => {
  for (const file of files) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} is listed but missing`);
  const referenced = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
    ...manifest.content_scripts.flatMap(entry => entry.js)
  ];
  for (const file of referenced) assert.ok(files.includes(file), `${file} is in the manifest but not in the package list`);
  // Dev-only material must never ship.
  for (const forbidden of ['dev/preview.html', 'dev/preview.js', 'eslint.config.mjs', 'package.json'])
    assert.equal(files.includes(forbidden), false);
});

test('the docs name the OpenHands frontend the selectors were verified against', () => {
  const doc = read('docs/selectors.md');
  assert.match(doc, /All-Hands-AI\/OpenHands/);
  assert.match(doc, /data-testid/);
});
