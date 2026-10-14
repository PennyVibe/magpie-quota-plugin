import { constants } from 'node:fs';
import { mkdir, open, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GatewayError, normalizeAddress, validateKey } from '../lib/gateway';
import type { Connection } from '../lib/types';

// Retain the legacy field only to read existing connection files.
export type SavedConnection = Connection & { key: string; upstreamEnabled?: boolean };
type State = { revision: string; activeId: string | null; connections: SavedConnection[] };
export function dataDirectory() {
  return process.env.MAGPIE_QUOTA_DATA_DIR ?? (process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'MagpieQuota')
    : join(homedir(), 'Library', 'Application Support', 'MagpieQuota'));
}
export const publicConnection = ({ id, name, baseUrl }: SavedConnection) => ({ id, name, baseUrl });
export class ConnectionStore {
  constructor(readonly directory = dataDirectory()) {}
  async read(): Promise<State> {
    try {
      const directory = await lstat(this.directory);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw Error();
      const filename = join(this.directory, 'connections.json');
      const before = await lstat(filename);
      if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024) throw Error();
      // O_NOFOLLOW is unavailable on Windows; compare path and opened-file identities as well.
      const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 1024 * 1024 || stat.dev !== before.dev || stat.ino !== before.ino) throw Error();
        const s = JSON.parse(await file.readFile('utf8')) as State;
        const after = await lstat(filename);
        if (!after.isFile() || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino) throw Error();
        if (!s || typeof s.revision !== 'string' || !Array.isArray(s.connections) || s.connections.length > 50 ||
            (s.activeId !== null && typeof s.activeId !== 'string')) throw Error();
        for (const c of s.connections) {
          if (typeof c.id !== 'string' || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 80 ||
              normalizeAddress(c.baseUrl) !== c.baseUrl || validateKey(c.key) !== c.key || c.name.includes(c.key) || c.baseUrl.includes(c.key) ||
              (c.upstreamEnabled !== undefined && typeof c.upstreamEnabled !== 'boolean')) throw Error();
        }
        if (new Set(s.connections.map(c => c.id)).size !== s.connections.length ||
            (s.activeId !== null && !s.connections.some(c => c.id === s.activeId))) throw Error();
        return s;
      } finally { await file.close(); }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { revision: 'empty', activeId: null, connections: [] };
      throw new GatewayError('storage', '无法安全读取本机连接文件；请检查文件权限和格式。');
    }
  }
  async update(expected: string, operation: (state: State) => void) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.directory)).isDirectory() || (await lstat(this.directory)).isSymbolicLink()) throw new GatewayError('storage', '连接目录必须为真实目录。');
    const lock = join(this.directory, 'connections.lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch { throw new GatewayError('conflict', '另一个插件实例正在保存连接；请稍后重试。若进程崩溃遗留锁，请确认全部实例已关闭再删除锁目录。'); }
    const temporary = join(this.directory, `.connections-${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      if (state.revision !== expected) throw new GatewayError('conflict', '连接已在其他页面更新，请重新载入连接页。');
      operation(state); state.revision = randomUUID();
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(state)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, join(this.directory, 'connections.json'));
      return state;
    } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true }); }
  }
}
