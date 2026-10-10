import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export const pluginName = 'magpie-quota-local';
export const catalogFile = '.agents/plugins/marketplace.json';
export const runtimeFiles = ['server.mjs', 'launch.cjs', 'runtime-support.cjs', 'runtime.json', 'THIRD_PARTY_NOTICES.txt'];
export const generatedFiles = ['README.md', 'docs/upstream-contract.md', 'docs/validation.md', ...runtimeFiles.map(file => `server/${file}`)];
export const templateFiles = [catalogFile, '.gitignore', '.gitattributes', 'README.md'];
export const pluginFiles = ['plugin.json', 'mcp.json', '.codex-plugin/plugin.json', '.mcp.json', 'assets/icon.svg', ...generatedFiles];

export async function listFiles(directory, prefix = '') {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    assert.ok(entry.isFile() || entry.isDirectory(), `Only regular files and directories are distributable: ${relative}`);
    if (entry.isDirectory()) files.push(...await listFiles(path.join(directory, entry.name), `${relative}/`));
    else files.push(relative);
  }
  return files.sort();
}

export async function validateCatalog(directory) {
  const catalog = JSON.parse(await readFile(path.join(directory, catalogFile), 'utf8'));
  assert.equal(catalog.name, 'magpie-local');
  assert.equal(catalog.plugins.length, 1);
  assert.equal(catalog.plugins[0].name, pluginName);
  assert.deepEqual(catalog.plugins[0].source, { source: 'local', path: `./plugins/${pluginName}` });
}

export async function validatePlugin(directory, version) {
  assert.deepEqual(await listFiles(directory), [...pluginFiles].sort(), 'Plugin must contain complete runtime files and no extras.');
  const json = async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'));
  const portable = await json('plugin.json');
  const compatibility = await json('.codex-plugin/plugin.json');
  const runtime = await json('server/runtime.json');
  for (const info of [portable, compatibility, runtime]) {
    assert.equal(info.name, pluginName);
    assert.equal(info.version, version, 'Distributed versions must match the source.');
  }
  assert.equal(runtime.nativeHelper, null);
  assert.equal(runtime.credentialStorage, 'plaintext JSON');
  assert.ok((runtime.platform === 'darwin' && ['arm64', 'x64'].includes(runtime.arch)) || (runtime.platform === 'win32' && runtime.arch === 'x64'));
  if (runtime.platform === 'win32') assert.equal(runtime.libuv, '>=1.51.0');
  for (const file of ['mcp.json', '.mcp.json']) {
    const config = await json(file);
    assert.deepEqual(config.mcpServers, {
      [pluginName]: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server/launch.cjs'], cwd: '${PLUGIN_ROOT}' },
    });
  }
}

export async function validateMarketplace(directory, version, standalone = false) {
  const expected = [
    ...(standalone ? templateFiles : [catalogFile]),
    ...pluginFiles.map(file => `plugins/${pluginName}/${file}`),
  ].sort();
  assert.deepEqual(await listFiles(directory), expected, 'Marketplace contains missing or unexpected files.');
  await validateCatalog(directory);
  await validatePlugin(path.join(directory, 'plugins', pluginName), version);
  return expected;
}
