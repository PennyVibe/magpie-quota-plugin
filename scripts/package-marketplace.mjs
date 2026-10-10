import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pluginName, runtimeFiles, templateFiles, validateMarketplace } from './marketplace-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'dist/local-plugin');
const destination = path.join(root, 'dist/private-marketplace');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await validateMarketplace(source, version);
for (const file of runtimeFiles) {
  assert.deepEqual(
    await readFile(path.join(source, 'plugins', pluginName, 'server', file)),
    await readFile(path.join(root, 'dist/local', file)),
    `Packaged runtime is stale; run local:package: ${file}`,
  );
}
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of templateFiles) {
  await mkdir(path.dirname(path.join(destination, file)), { recursive: true });
  await cp(path.join(root, file), path.join(destination, file));
}
await cp(path.join(source, 'plugins'), path.join(destination, 'plugins'), { recursive: true });
await validateMarketplace(destination, version, true);
console.log(`Git marketplace built: ${destination}\nVersion: ${version}`);
