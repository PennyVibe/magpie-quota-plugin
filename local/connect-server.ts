import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { GatewayError, normalizeAddress, parseQuota, problem, readGateway, validateKey } from '../lib/gateway';
import { ConnectionStore, publicConnection } from './store';
import type { Runtime } from './runtime';

const secret = () => randomBytes(32).toString('base64url');
const matches = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
type Authority = { cookie: string; csrf: string; expires: number; revision: string | null };
export class ConnectServer {
  private tokens = new Map<string, number>();
  private authority: Authority | null = null;
  private cookie = `magpie_${randomBytes(12).toString('hex')}`;
  private stopping = false;
  private server = createServer((req, res) => {
    void this.handle(req, res).catch(() => this.reply(res, 500, { error: '本机连接服务暂不可用。' }));
  });
  constructor(private store: ConnectionStore, private runtime: Runtime, private html: string) {
    this.server.requestTimeout = 15000; this.server.headersTimeout = 10000; this.server.maxHeadersCount = 30;
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    });
    return this;
  }
  get origin() {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw Error('Closed');
    return `http://127.0.0.1:${address.port}`;
  }
  issueConnectionUrl() {
    if (this.stopping) throw Error('Closed');
    for (const [token, expires] of this.tokens) if (expires <= Date.now()) this.tokens.delete(token);
    while (this.tokens.size >= 8) this.tokens.delete(this.tokens.keys().next().value!);
    const token = secret(); this.tokens.set(token, Date.now() + 120000);
    return `${this.origin}/connect?bootstrap=${token}`;
  }
  private headers(res: ServerResponse) {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
  }
  private reply(res: ServerResponse, status: number, data: unknown) {
    if (res.destroyed || res.writableEnded) return;
    this.headers(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data));
  }
  private page(res: ServerResponse) {
    this.headers(res);
    const hashes = [...this.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`);
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src ${hashes.join(' ')}; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(this.html);
  }
  private ensure(a: Authority, csrf: string, res: ServerResponse) {
    if (this.stopping || this.authority !== a || a.expires <= Date.now() || !matches(a.csrf, csrf) || res.destroyed)
      throw new GatewayError('expired', '连接页授权已过期或已被替换，请从看板重新打开。');
  }
  private async body(req: IncomingMessage) {
    if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] ?? '')) throw new GatewayError('input', '请求格式无效。');
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of req) { size += chunk.length; if (size > 16384) throw new GatewayError('input', '请求过大。'); chunks.push(chunk); }
    try {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error();
      return body as Record<string, unknown>;
    } catch { throw new GatewayError('input', '请求格式无效。'); }
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.headers.host !== new URL(this.origin).host) return this.reply(res, 403, { error: '请求主机无效。' });
    const url = new URL(req.url ?? '/', this.origin);
    if (url.origin !== this.origin) return this.reply(res, 403, { error: '请求地址无效。' });
    if (req.method === 'GET' && url.pathname === '/connect' && url.searchParams.size === 1) {
      const token = url.searchParams.get('bootstrap') ?? '', expires = this.tokens.get(token); this.tokens.delete(token);
      if (!expires || expires <= Date.now()) return this.reply(res, 401, { error: '入口已过期或已使用。' });
      this.authority = { cookie: secret(), csrf: secret(), expires: Date.now() + 600000, revision: null };
      res.setHeader('Set-Cookie', `${this.cookie}=${this.authority.cookie}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600`);
      return this.page(res);
    }
    if (url.search) return this.reply(res, 404, { error: '路径无效。' });
    const a = this.authority, cookies = (req.headers.cookie ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(`${this.cookie}=`));
    if (!a || a.expires <= Date.now() || cookies.length !== 1 || !matches(cookies[0].slice(this.cookie.length + 1), a.cookie))
      return this.reply(res, 401, { error: '页面授权已过期，请从看板重新打开。' });
    if ((req.headers.origin && req.headers.origin !== this.origin) ||
        (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site']))))
      return this.reply(res, 403, { error: '请求来源无效。' });
    if (req.method === 'GET' && url.pathname === '/connect') return this.page(res);
    if (req.method === 'GET' && url.pathname === '/api/connections') {
      const csrf = secret(); a.csrf = csrf; a.revision = null;
      const state = await this.store.read(); this.ensure(a, csrf, res); a.revision = state.revision;
      return this.reply(res, 200, { csrf, revision: state.revision, activeId: state.activeId, connections: state.connections.map(publicConnection) });
    }
    if (req.method !== 'POST' || url.pathname !== '/api/connections') return this.reply(res, 404, { error: '路径无效。' });
    const csrf = req.headers['x-csrf-token'];
    if (req.headers.origin !== this.origin || typeof csrf !== 'string' || !matches(csrf, a.csrf))
      return this.reply(res, 403, { error: '页面授权验证失败。' });
    try {
      const body = await this.body(req); this.ensure(a, csrf, res);
      const expected = a.revision;
      if (expected === null) throw new GatewayError('conflict', '请先载入连接列表。');
      if (body.action === 'add') {
        if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 80 || typeof body.address !== 'string')
          throw new GatewayError('input', '请填写连接名称和网关地址。');
        const key = validateKey(body.key), name = body.name.trim(), baseUrl = normalizeAddress(body.address);
        if (name.includes(key) || baseUrl.includes(key)) throw new GatewayError('input', '连接名称与地址不能包含 Gateway key。');
        const quota = parseQuota(await readGateway(baseUrl, key, 'limit'));
        this.ensure(a, csrf, res);
        await this.store.update(expected, state => {
          this.ensure(a, csrf, res);
          if (state.connections.length >= 50) throw new GatewayError('input', '最多保存 50 个连接。');
          const id = randomUUID(); state.connections.push({ id, name, baseUrl, key, upstreamEnabled: body.upstreamEnabled === true }); state.activeId = id;
        });
        this.runtime.invalidate(); a.revision = null;
        return this.reply(res, 200, { ok: true, limited: quota.limited });
      }
      if (!['select', 'remove', 'upstream'].includes(String(body.action)) || typeof body.id !== 'string') throw new GatewayError('input', '操作无效。');
      if (body.action === 'upstream' && typeof body.enabled !== 'boolean') throw new GatewayError('input', '请明确选择是否展示共享供应商额度。');
      await this.store.update(expected, state => {
        this.ensure(a, csrf, res);
        if (!state.connections.some(c => c.id === body.id)) throw new GatewayError('input', '连接已不存在。');
        if (body.action === 'upstream') state.connections.find(c => c.id === body.id)!.upstreamEnabled = body.enabled as boolean;
        else if (body.action === 'select') state.activeId = body.id as string;
        else {
          state.connections = state.connections.filter(c => c.id !== body.id);
          if (state.activeId === body.id) state.activeId = null;
        }
      });
      this.runtime.invalidate(); a.revision = null;
      this.reply(res, 200, { ok: true });
    } catch (e) { this.reply(res, e instanceof GatewayError && e.code === 'conflict' ? 409 : 400, { error: problem(e).message }); }
  }
  async close() {
    this.stopping = true; this.authority = null; this.tokens.clear(); this.runtime.invalidate();
    this.server.closeAllConnections(); await new Promise<void>(resolve => this.server.close(() => resolve()));
  }
}
