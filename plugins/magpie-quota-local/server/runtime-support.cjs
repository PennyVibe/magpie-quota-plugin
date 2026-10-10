'use strict';
// Shared by the old-Node bootstrap, build scripts and bundled server.
function atLeast(value, minimum) {
  if (typeof value !== 'string') return false;
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value.trim());
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) return false;
  for (let index = 0; index < minimum.length; index++) {
    if (parts[index] > minimum[index]) return true;
    if (parts[index] < minimum[index]) return false;
  }
  return true;
}
function compatibleRuntime(platform, runtime) {
  // Older Windows libuv reports inconsistent file identities for lstat/fstat.
  return !!runtime && atLeast(runtime.node, [22, 13, 0]) &&
    (platform !== 'win32' || atLeast(runtime.uv, [1, 51, 0]));
}
function runtimeRequirement(platform) {
  return platform === 'win32'
    ? 'Windows 需要已安装的 Node.js >=22.13.0 且内置 libuv >=1.51.0（例如 Node.js 22.17.0；早期 23.x/24.x 也可能不兼容）。'
    : '需要已安装的 Node.js >=22.13.0。';
}
module.exports = { atLeast, compatibleRuntime, runtimeRequirement };
