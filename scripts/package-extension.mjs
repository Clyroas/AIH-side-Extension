// Copies exactly the allow-listed files into dist/ so a packaged build can never pick up the dev preview,
// the test suite, the docs or node_modules. Fails before writing anything if a listed file is missing.
//
//   npm run package:extension   →   dist/openhands-side-panel-<version>/
import { readFile, mkdir, copyFile, rm } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
const files = JSON.parse(await readFile(resolve(root, 'extension-files.json'), 'utf8'));
if (!/^\d+(?:\.\d+){0,3}$/.test(manifest.version)) throw new Error('Invalid extension version');

const output = resolve(root, 'dist', `openhands-side-panel-${manifest.version}`);
const prefix = root.endsWith(sep) ? root : root + sep;
for (const file of files) {
  if (typeof file !== 'string' || !/^[a-zA-Z0-9._/-]+$/.test(file) || file.split('/').includes('..'))
    throw new Error(`Unsafe package path: ${file}`);
  const source = resolve(root, file);
  if (!source.startsWith(prefix)) throw new Error(`Package path escaped the repository: ${file}`);
  await readFile(source); // fail before altering the output if an allow-listed file is missing
}

// Every file the manifest references must be on the list, or Chrome would refuse to load the package.
const referenced = [
  manifest.background?.service_worker,
  manifest.side_panel?.default_path,
  manifest.action?.default_icon ? Object.values(manifest.action.default_icon) : [],
  Object.values(manifest.icons || {}),
  ...(manifest.content_scripts || []).flatMap(entry => entry.js || [])
].flat().filter(Boolean);
for (const file of referenced)
  if (!files.includes(file)) throw new Error(`manifest.json references ${file}, which is not in extension-files.json`);

await rm(output, { recursive: true, force: true });
for (const file of files) {
  const target = resolve(output, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(resolve(root, file), target);
}
console.log(`Packaged ${files.length} allow-listed files in ${output}`);
