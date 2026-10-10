'use strict';
// Bootstrap only: this file intentionally runs on the host's older system Node.
// It never downloads a runtime, sources shell profiles, or changes host settings.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const { atLeast, compatibleRuntime, runtimeRequirement } = require('./runtime-support.cjs');
function version(value) { const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim()); return match ? match.slice(1).map(Number) : null; }
function compatible(value) { return atLeast(value, [22, 13, 0]); }
function installedRuntime() {
  if (compatibleRuntime(process.platform, process.versions)) return process.execPath;
  const windows = process.platform === 'win32';
  const candidates = windows
    ? [process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'nodejs/node.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs/nodejs/node.exe'), process.env.NVM_SYMLINK && path.join(process.env.NVM_SYMLINK, 'node.exe')].filter(Boolean)
    : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/opt/local/bin/node'];
  const directory = windows ? process.env.NVM_HOME : path.join(os.homedir(), '.nvm/versions/node');
  try {
    const versions = fs.readdirSync(directory).filter(item => version(item) && compatible(item));
    versions.sort((left, right) => { const a = version(left), b = version(right); for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return b[index] - a[index]; return 0; });
    candidates.push(...versions.slice(0, 20).map(item => path.join(directory, item, windows ? 'node.exe' : 'bin/node')));
  } catch { /* A missing nvm installation is normal. */ }
  for (const candidate of [...new Set(candidates)]) {
    if (candidate === process.execPath || !fs.existsSync(candidate)) continue;
    const result = childProcess.spawnSync(candidate, ['-p', 'JSON.stringify({node:process.versions.node,uv:process.versions.uv})'], { encoding: 'utf8', timeout: 1500, maxBuffer: 1024, windowsHide: true });
    try { if (result.status === 0 && compatibleRuntime(process.platform, JSON.parse(result.stdout))) return candidate; }
    catch { /* Invalid output is not a compatible installed runtime. */ }
  }
  return null;
}
if (process.platform !== 'darwin' && (process.platform !== 'win32' || process.arch !== 'x64')) { process.stderr.write('Magpie 额度看板支持 macOS 13+ 或 Windows 11 x64。\n'); process.exit(1); }
const executable = installedRuntime();
if (!executable) { process.stderr.write('Magpie 额度看板' + runtimeRequirement(process.platform) + '请自行安装兼容运行时，或将 MCP command 指向其绝对路径。插件不会自动下载运行时。\n'); process.exit(1); }
const child = childProcess.spawn(executable, [path.join(__dirname, 'server.mjs')], { stdio: 'inherit', cwd: __dirname, windowsHide: true });
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => child.kill(signal));
child.on('error', () => { process.stderr.write('Magpie 额度看板无法启动随包 MCP 运行时。\n'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = typeof code === 'number' ? code : signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1; });
