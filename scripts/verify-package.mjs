import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const info = JSON.parse(await readFile('package.json', 'utf8'));
const label = process.platform === 'win32' ? 'Windows-x64' : process.arch === 'arm64' ? 'Mac-Apple-Silicon' : 'Mac-Intel';
const archive = resolve(process.argv[2] ?? `dist/Magpie-${info.version}-${label}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`);
const expected = (await readFile(`${archive}.sha256`, 'utf8')).split(/\s+/)[0];
assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), expected);
const directory = await mkdtemp(join(tmpdir(), 'magpie-unpacked-'));
try {
  const extraction = archive.endsWith('.zip') ? spawnSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:MAGPIE_VERIFY_ARCHIVE,$env:MAGPIE_VERIFY_DIRECTORY)"],
    { stdio: 'inherit', env: { ...process.env, MAGPIE_VERIFY_ARCHIVE: archive, MAGPIE_VERIFY_DIRECTORY: directory }, windowsHide: true },
  ) : spawnSync('tar', ['-xzf', archive, '-C', directory], { stdio: 'inherit' });
  assert.equal(extraction.status, 0);
  const root = join(directory, 'magpie-quota-local');
  for (const file of ['plugin.json', '.codex-plugin/plugin.json', '.mcp.json', 'mcp.json', 'server/launch.cjs', 'server/server.mjs', 'docs/upstream-contract.md']) await lstat(join(root, file));
  const scan = async dir => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Package must not contain symlinks');
      assert.ok(!/^(?:connections\.json|connections\.lock|node_modules|\.env.*|\.connections-.*\.tmp)$/.test(entry.name));
      if (entry.isDirectory()) await scan(join(dir, entry.name));
    }
  };
  await scan(root);
  const verify = spawnSync(process.execPath, [resolve('scripts/verify-local.mjs'), join(root, 'server/launch.cjs')], { stdio: 'inherit' });
  assert.equal(verify.status, 0);
  console.log(`Unpacked archive verified: ${archive}\nSHA256: ${expected}`);
} finally { await rm(directory, { recursive: true, force: true }); }
