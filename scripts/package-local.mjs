import { cp, mkdir, readFile, writeFile, readdir, lstat, access, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
const name = 'magpie-quota-local';
const source = path.join(root, 'plugins', name);
const distribution = path.join(root, 'dist/local-plugin');
const destination = path.join(distribution, 'plugins', name);
const portable = JSON.parse(await readFile(path.join(source, 'plugin.json'), 'utf8'));
const compatibility = JSON.parse(await readFile(path.join(source, '.codex-plugin/plugin.json'), 'utf8'));
const runtime = JSON.parse(await readFile('dist/local/runtime.json', 'utf8'));
const packageInfo = JSON.parse(await readFile('package.json', 'utf8'));
const supported = (process.platform === 'darwin' && ['arm64', 'x64'].includes(process.arch)) || (process.platform === 'win32' && process.arch === 'x64');
if (!supported || runtime.name !== name || runtime.platform !== process.platform || runtime.arch !== process.arch || runtime.version !== portable.version || runtime.version !== packageInfo.version || runtime.nativeHelper !== null || runtime.credentialStorage !== 'plaintext JSON' || (process.platform === 'win32' && runtime.libuv !== '>=1.51.0')) {
  throw Error('请先在当前平台为相同版本完整构建运行时。');
}
if (portable.name !== name || compatibility.name !== name || portable.version !== compatibility.version) throw Error('Plugin identity and compatibility overlay must match.');
if (!/^\d+\.\d+\.\d+$/.test(portable.version)) throw Error('Use a semantic release version.');
if (portable.extensions['com.openai'].interface.shortDescription.length > 30) throw Error('Plugin subtitle exceeds 30 characters.');
const runtimeFiles = ['server.mjs', 'launch.cjs', 'runtime-support.cjs', 'runtime.json', 'THIRD_PARTY_NOTICES.txt'];
for (const file of runtimeFiles) await access(path.join('dist/local', file));
const files = [];
async function scan(directory, relative = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(relative, entry.name), full = path.join(directory, entry.name);
    if ((await lstat(full)).isSymbolicLink()) throw Error(`Symlinks are not distributable: ${name}`);
    if (entry.isDirectory()) await scan(full, name); else files.push(name);
  }
}
await scan(source);
if (files.some(file => /(^|\/)(?:node_modules|\.env[^/]*|\.app\.json|connections\.json|connections\.lock|\.connections-[^/]*\.tmp)(\/|$)/.test(file.replaceAll('\\', '/')))) throw Error('Template contains forbidden runtime dependencies or credential/app configuration.');
for (const file of files) if ((await readFile(path.join(source, file), 'utf8')).includes('[TODO:')) throw Error(`Unfilled scaffold placeholder: ${file}`);
// 打包目录是生成产物；重建可避免旧版本及其他平台的 helper 残留。
await rm(distribution, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });
await mkdir(path.join(destination, 'server'), { recursive: true });
for (const file of runtimeFiles) await cp(path.join(root, 'dist/local', file), path.join(destination, 'server', file));
await cp(path.join(root, 'README.md'), path.join(destination, 'README.md'));
await cp(path.join(root, 'docs'), path.join(destination, 'docs'), { recursive: true });
// 保留本机已注册的来源目录，但不将 marketplace 包装进个人导入包。
await mkdir(path.join(distribution, '.agents/plugins'), { recursive: true });
await cp(path.join(root, '.agents/plugins/marketplace.json'), path.join(distribution, '.agents/plugins/marketplace.json'));
for (const file of ['mcp.json', '.mcp.json']) {
  const configuration = JSON.parse(await readFile(path.join(destination, file), 'utf8'));
  const server = configuration.mcpServers[name];
  if (server.type !== 'stdio' || server.command !== 'node' || server.args[0] !== '${PLUGIN_ROOT}/server/launch.cjs' || server.env || server.url) throw Error('Unexpected local MCP configuration.');
}
const platformLabel = process.platform === 'win32' ? 'Windows-x64' : process.arch === 'arm64' ? 'Mac-Apple-Silicon' : 'Mac-Intel';
const suffix = `${portable.version}-${platformLabel}`;
const archives = [];
if (process.platform === 'darwin') {
  const archive = path.join(root, 'dist', `Magpie-${suffix}.tar.gz`);
  const tar = spawnSync('tar', ['-czf', archive, '-C', path.join(distribution, 'plugins'), name], { stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });
  if (tar.status !== 0) throw Error('归档创建失败。');
  archives.push(archive);
} else {
  const archive = path.join(root, 'dist', `Magpie-${suffix}.zip`);
  await rm(archive, { force: true });
  // 显式使用 ZIP 标准路径，避免旧版 .NET 写入反斜杠导致跨平台导入失败。
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const zipScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$source = $env:MAGPIE_PACKAGE_SOURCE
$archive = [System.IO.Compression.ZipFile]::Open($env:MAGPIE_PACKAGE_ARCHIVE, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($file in [System.IO.Directory]::GetFiles($source, '*', [System.IO.SearchOption]::AllDirectories)) {
    $entry = $file.Substring($source.Length + 1).Replace([char]92, [char]47)
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file, $entry, [System.IO.Compression.CompressionLevel]::Optimal)
  }
} finally {
  $archive.Dispose()
}`;
  const zip = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', zipScript], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, MAGPIE_PACKAGE_SOURCE: path.join(distribution, 'plugins'), MAGPIE_PACKAGE_ARCHIVE: archive },
  });
  if (zip.status !== 0) throw Error('Windows ZIP 创建失败。');
  archives.push(archive);
}
for (const archive of archives) {
  const hash = createHash('sha256').update(await readFile(archive)).digest('hex');
  await writeFile(`${archive}.sha256`, `${hash}  ${path.basename(archive)}\n`);
  console.log(`Archive: ${archive}`);
}
console.log(`Local plugin: ${destination}\nMarketplace (not registered): ${path.join(distribution, '.agents/plugins/marketplace.json')}`);
