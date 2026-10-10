import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listFiles, pluginName, validateMarketplace } from './marketplace-files.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'dist/private-marketplace');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const expected = await validateMarketplace(source, version, true);
const temporary = await mkdtemp(path.join(tmpdir(), 'Magpie Git 分发验证 '));
function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr || `${command} failed`);
  return result.stdout;
}
try {
  const repository = path.join(temporary, 'repository');
  const extracted = path.join(temporary, '检出 目录');
  await cp(source, repository, { recursive: true });
  await writeFile(path.join(temporary, 'empty-ignore'), '');
  // Synthetic local artifacts prove the distribution's ignore rules without using real credentials.
  for (const file of ['connections.json', '.env.fixture', 'node_modules/synthetic.txt', 'outputs/synthetic.txt']) {
    await mkdir(path.dirname(path.join(repository, file)), { recursive: true });
    await writeFile(path.join(repository, file), 'synthetic verification fixture\n');
  }
  const git = args => run('git', ['-c', `core.excludesFile=${path.join(temporary, 'empty-ignore')}`, '-c', 'core.autocrlf=true', ...args], repository);
  git(['init', '--quiet']);
  git(['add', '--all']);
  assert.deepEqual(git(['ls-files', '-z']).split('\0').filter(Boolean).sort(), expected, 'Git must deliver hidden configs and exclude local artifacts.');
  // A Git tree archive verifies delivery without creating a commit or touching the source index.
  const tree = git(['write-tree']).trim();
  const windows = process.platform === 'win32';
  const archive = path.join(temporary, windows ? 'marketplace.zip' : 'marketplace.tar');
  git(['archive', windows ? '--format=zip' : '--format=tar', `--output=${archive}`, tree]);
  await mkdir(extracted);
  if (windows) {
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:MAGPIE_MARKETPLACE_ARCHIVE, $env:MAGPIE_MARKETPLACE_DESTINATION)"], temporary, {
      ...process.env, MAGPIE_MARKETPLACE_ARCHIVE: archive, MAGPIE_MARKETPLACE_DESTINATION: extracted,
    });
  } else run('tar', ['-xf', archive, '-C', extracted], temporary);
  assert.deepEqual(await listFiles(extracted), expected);
  for (const file of expected) assert.deepEqual(await readFile(path.join(extracted, file)), await readFile(path.join(source, file)), `Git changed distributed bytes: ${file}`);
  await validateMarketplace(extracted, version, true);
  const verification = spawnSync(process.execPath, [path.join(root, 'scripts/verify-local.mjs'), path.join(extracted, 'plugins', pluginName, 'server/launch.cjs')], { stdio: 'inherit', windowsHide: true });
  assert.equal(verification.status, 0, 'Git-delivered plugin must pass actual STDIO verification.');
  const fixture = path.join(temporary, 'sync-boundary');
  await cp(source, fixture, { recursive: true });
  await cp(source, path.join(fixture, 'dist/private-marketplace'), { recursive: true });
  await mkdir(path.join(fixture, 'scripts'));
  for (const file of ['sync-marketplace.mjs', 'marketplace-files.mjs']) await cp(path.join(root, 'scripts', file), path.join(fixture, 'scripts', file));
  await cp(path.join(root, 'package.json'), path.join(fixture, 'package.json'));
  const check = args => spawnSync(process.execPath, [path.join(fixture, 'scripts/sync-marketplace.mjs'), ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(check(['--check']).status, 0);
  const published = path.join(fixture, 'plugins', pluginName, 'server/runtime-support.cjs');
  const original = await readFile(published);
  await writeFile(published, Buffer.concat([original, Buffer.from('\n// synthetic stale artifact\n')]));
  const stale = check(['--check']);
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /Published file is stale/);
  await writeFile(published, original);
  const unknown = path.join(fixture, 'plugins', pluginName, 'synthetic-unknown.txt');
  await writeFile(unknown, 'preserve this synthetic user file\n');
  const refused = check([]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Unknown plugin files exist/);
  assert.equal(await readFile(unknown, 'utf8'), 'preserve this synthetic user file\n');
  assert.deepEqual(await readFile(published), original);
  await rm(unknown);
  assert.equal(check(['--check']).status, 0);
  console.log(`Git marketplace verified: ${version} (${expected.length} files, ignored synthetic artifacts, extracted STDIO).`);
  console.log('Sync boundaries verified: stale same-version artifact rejected; unknown user file preserved.');
} finally { await rm(temporary, { recursive: true, force: true }); }
