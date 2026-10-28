#!/usr/bin/env node
// ローカル確認用サーバー（依存パッケージなし）
//   node scripts/dev-server.mjs                 # 静的サイトのみ（混雑共有は「準備中」表示）
//   node scripts/dev-server.mjs --with-api      # メモリ保存の混雑APIも起動（再起動で消える検証用）
//   PORT=8080 node scripts/dev-server.mjs
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handle, createMemoryStore } from '../worker/src/logic.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(ROOT, 'site');
const WITH_API = process.argv.includes('--with-api');
const PORT = Number(process.env.PORT) || 8787;

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8',
};

export async function startServer({ port = PORT, withApi = WITH_API, quiet = false } = {}) {
  const store = createMemoryStore();
  const facilityIds = new Set(JSON.parse(await readFile(join(ROOT, 'worker/src/facility-ids.json'), 'utf8')).ids);
  const env = { RATE_LIMIT_SECRET: 'local-dev-only', ALLOWED_ORIGINS: '' };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (withApi && url.pathname.startsWith('/api/')) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const body = chunks.length ? Buffer.concat(chunks) : undefined;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
        headers.set('CF-Connecting-IP', req.socket.remoteAddress ?? 'local');
        const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
        const r = await handle(request, { env, store, facilityIds });
        res.writeHead(r.status, Object.fromEntries(r.headers));
        res.end(Buffer.from(await r.arrayBuffer()));
        return;
      }
      if (url.pathname === '/config.js' && withApi) {
        res.writeHead(200, { 'Content-Type': TYPES['.js'], 'Cache-Control': 'no-store' });
        res.end(`window.FUJISAWA_LENS_CONFIG = { crowdingApiBase: location.origin, crowdingApiLabel: "ローカル検証用のAPIに接続中です（報告はこのPCのメモリにのみ保存され、再起動で消えます）。" };\n`);
        return;
      }
      let p = decodeURIComponent(url.pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(SITE, p));
      if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
      const s = await stat(file).catch(() => null);
      if (!s || !s.isFile()) { res.writeHead(404, { 'Content-Type': TYPES['.txt'] }).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(await readFile(file));
    } catch (e) {
      res.writeHead(500).end();
      if (!quiet) console.error(e);
    }
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  if (!quiet) console.log(`http://127.0.0.1:${server.address().port}/  （混雑API: ${withApi ? 'メモリ版を起動' : '未設定'}）`);
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) startServer();
