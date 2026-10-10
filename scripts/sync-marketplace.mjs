import assert from 'node:assert/strict';
import { cp, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogFile, generatedFiles, listFiles, pluginFiles, pluginName, validateCatalog, validateMarketplace, validatePlugin } from './marketplace-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'dist/private-marketplace');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const plugin = `plugins/${pluginName}`;
const check = process.argv.includes('--check');
await validateMarketplace(source, version, true);
await validateCatalog(root);
const existing = await listFiles(path.join(root, plugin));
assert.ok(existing.every(file => pluginFiles.includes(file)), 'Unknown plugin files exist; preserve and inspect them before syncing.');
// Static manifests and icons are source files, never overwritten by synchronization.
for (const file of pluginFiles.filter(file => !generatedFiles.includes(file))) {
  assert.deepEqual(await readFile(path.join(root, plugin, file)), await readFile(path.join(source, plugin, file)), `Source changed since packaging: ${file}`);
}
if (!check) {
  for (const file of generatedFiles) {
    await mkdir(path.dirname(path.join(root, plugin, file)), { recursive: true });
    await cp(path.join(source, plugin, file), path.join(root, plugin, file));
  }
}
await validatePlugin(path.join(root, plugin), version);
for (const file of [catalogFile, ...pluginFiles.map(file => `${plugin}/${file}`)]) {
  const published = await readFile(path.join(root, file));
  const built = await readFile(path.join(source, file));
  if (file === `${plugin}/server/runtime.json`) {
    // The shared JavaScript works on both platforms; this records the publishing build.
    const contract = bytes => {
      const info = JSON.parse(bytes.toString('utf8'));
      for (const field of ['platform', 'arch', 'macOS', 'windows', 'libuv']) delete info[field];
      return info;
    };
    assert.deepEqual(contract(published), contract(built), 'Published runtime contract differs from the build.');
  } else assert.deepEqual(published, built, `Published file is stale; run marketplace:sync: ${file}`);
}
console.log(`Repository marketplace ${check ? 'checked' : 'synced'}: ${version}`);
