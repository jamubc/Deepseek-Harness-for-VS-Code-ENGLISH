'use strict';
/**
 * Managed auth proxy unit tests (no VS Code or real dsh required).
 * Run: node test/auth-proxy.test.js
 * Covers:
 *  1) extractTokenParam with various inputs
 *  2) Control group: bare address straight to the new dsh (simulated) returns 401
 *  3) After the proxy + onToken: / returns 200, POST /api returns 200 (the Cookie is injected by the proxy)
 *  4) dsh restart on the same port (new token + new secret): the old Cookie goes stale → automatic re-exchange → 200
 *  5) SSE streaming is forwarded without buffering (chunks arrive separately)
 *  6) WebSocket upgrade passthrough (Cookie injected, data in both directions)
 *  7) localhost origin (tab isolation) exchanges its own Cookie per authority
 */
const http = require('http');
const crypto = require('crypto');
const net = require('net');
const assert = require('assert');
const path = require('path');
const Module = require('module');

// ---------------- vscode stub ----------------
const FAKE_DSH_URL = 'http://127.0.0.1:31117';
const vscodeStub = {
  workspace: {
    getConfiguration: () => ({ get: (k, d) => (k === 'dshPanel.url' ? FAKE_DSH_URL : d) }),
    workspaceFolders: []
  },
  env: { remoteName: undefined },
  window: { showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }) },
  Uri: { parse: (u) => ({ toString: () => u }) }
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return origLoad.apply(this, arguments);
};

const ext = require(path.join(__dirname, '..', 'extension.js'));
const { ensureAuthProxy, learnDshToken, extractTokenParam } = ext.__internals;

// ---------------- simulated new-version dsh web authentication ----------------
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

class FakeDsh {
  constructor() {
    this.secret = b64url(crypto.randomBytes(32));
    this.token = b64url(crypto.randomBytes(32));
    this.minted = new Map(); // authority -> cookie value
    this.server = http.createServer((req, res) => this.onRequest(req, res));
    this.server.on('upgrade', (req, socket) => this.onUpgrade(req, socket));
  }
  listen(port) {
    return new Promise((done) => this.server.listen(port, '127.0.0.1', done));
  }
  close() {
    return new Promise((done) => this.server.close(done));
  }
  indexHtml() { return '<!DOCTYPE html><html><body>FAKE-DSH-INDEX</body></html>'; }
  onRequest(req, res) {
    const authority = String(req.headers.host || '');
    const url = new URL(req.url, 'http://x');
    const given = url.searchParams.getAll('token');
    if (url.pathname === '/' && given.length > 0) {
      if (req.method === 'GET' && given.length === 1 && given[0] === this.token && authority) {
        const value = 'v1.' + b64url(crypto.randomBytes(16)) + '.' + b64url(crypto.randomBytes(32));
        this.minted.set(authority, `dsh-auth-${authority}=${value}`);
        res.writeHead(303, {
          'cache-control': 'no-store',
          location: '/',
          'set-cookie': `dsh-auth-${authority}=${value}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict`
        });
        res.end();
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
      return;
    }
    if (this.isAuthed(req, authority)) {
      if (url.pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(this.indexHtml());
        return;
      }
      if (url.pathname === '/api/echo' && req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, echoed: Buffer.concat(chunks).toString('utf8'), host: authority }));
        });
        return;
      }
      if (url.pathname === '/api/stream' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        let i = 0;
        const timer = setInterval(() => {
          i += 1;
          res.write('data: chunk-' + i + '\n\n');
          if (i >= 3) { clearInterval(timer); res.end(); }
        }, 150);
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
      return;
    }
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh web authentication required; reopen the URL printed by dsh web.\n');
  }
  isAuthed(req, authority) {
    const raw = req.headers.cookie;
    if (!raw || !authority) return false;
    const expected = this.minted.get(authority);
    if (!expected) return false;
    return String(raw).split(/;\s*/).includes(expected);
  }
  onUpgrade(req, socket) {
    const authority = String(req.headers.host || '');
    if (!this.isAuthed(req, authority)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nconnection: close\r\n\r\n');
      socket.end();
      return;
    }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(Buffer.concat([Buffer.from('pong:'), d])));
    socket.on('error', () => socket.destroy());
  }
}

// ---------------- helpers ----------------
// Short-lived agent for tests: keep-alive is disabled so server.close() is not held up by idle connections.
const testAgent = new http.Agent({ keepAlive: false, maxSockets: 8 });
function request(port, method, reqPath, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: reqPath, method, agent: testAgent,
      headers: body ? { ...headers, 'content-length': Buffer.byteLength(body) } : headers
    }, (res) => {
      const chunks = [];
      const times = [];
      res.on('data', (c) => { chunks.push(c); times.push(Date.now()); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), times }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, name) {
  if (!cond) { console.error('  ✗ ' + name); throw new Error('Assertion failed: ' + name); }
  passed += 1;
  console.log('  ✓ ' + name);
}

// ---------------- test cases ----------------
async function main() {
  console.log('[1] extractTokenParam');
  ok(extractTokenParam('http://127.0.0.1:3080/?token=abcABC012-_xyz90') === 'abcABC012-_xyz90', 'token extracted from a full URL');
  ok(extractTokenParam('dsh web: http://127.0.0.1:3080/?token=TOKEN123 (LAN: http://192.168.1.2:3080/?token=TOKEN123)') === 'TOKEN123', 'token extracted from a whole line');
  ok(extractTokenParam('PLAIN_TOKEN_abcd12345678') === 'PLAIN_TOKEN_abcd12345678', 'bare token');
  ok(extractTokenParam('http://127.0.0.1:3080/') === null, 'no token returns null');
  ok(extractTokenParam('') === null, 'empty input');

  const dsh = new FakeDsh();
  await dsh.listen(31117);

  console.log('[2] Control group: bare address straight to the new dsh → 401');
  const direct = await request(31117, 'GET', '/');
  ok(direct.status === 401, 'direct / returns 401');
  ok(/authentication required/.test(direct.body), '401 message matches');

  console.log('[3] proxy + token → invisible authentication');
  const proxy = await ensureAuthProxy();
  ok(proxy !== null, 'local managed proxy created (production entry point ensureAuthProxy)');
  ok(!learnDshToken('http://127.0.0.1:3080/'), 'a link without a token is not learned');
  ok(learnDshToken('dsh web: ' + FAKE_DSH_URL + '/?token=' + dsh.token), 'token learned from the stdout line');
  await proxy.waitAuthed(3000);
  ok(proxy.hasCookieForBase(), 'Cookie exchanged for the 127.0.0.1 origin');
  const pport = proxy.port();
  const viaProxy = await request(pport, 'GET', '/');
  ok(viaProxy.status === 200 && /FAKE-DSH-INDEX/.test(viaProxy.body), 'GET / through the proxy returns the 200 home page');
  const echo = await request(pport, 'POST', '/api/echo', { body: JSON.stringify({ hello: 'dsh' }), headers: { 'content-type': 'application/json' } });
  ok(echo.status === 200 && JSON.parse(echo.body).echoed === '{"hello":"dsh"}', 'POST /api/echo through the proxy works');
  ok(JSON.parse(echo.body).host === '127.0.0.1:' + pport, 'upstream sees Host = proxy authority (fence consistent)');

  console.log('[4] dsh restart on the same port (new token + new secret) → automatic 401 re-exchange');
  await dsh.close(); // simulate the dsh process exiting
  const dsh2 = new FakeDsh(); // new process: new token/secret
  await dsh2.listen(31117);
  ok(learnDshToken(FAKE_DSH_URL + '/?token=' + dsh2.token), 'new token learned (stdout after the restart)');
  await sleep(50);
  const afterRestart = await request(pport, 'GET', '/');
  ok(afterRestart.status === 200 && /FAKE-DSH-INDEX/.test(afterRestart.body), 'stale Cookie triggers an automatic re-exchange and the retry succeeds');
  const echo2 = await request(pport, 'POST', '/api/echo', { body: '2', headers: { 'content-type': 'text/plain' } });
  ok(echo2.status === 200, 'the API keeps working after the restart');

  console.log('[5] SSE streaming is forwarded without buffering');
  const t0 = Date.now();
  const stream = await request(pport, 'GET', '/api/stream');
  const spread = stream.times[stream.times.length - 1] - t0;
  ok(stream.status === 200 && stream.body.includes('chunk-3'), 'stream content is complete');
  ok(spread >= 300, 'chunks arrive separately (total ' + spread + 'ms ≥ 300ms, not buffered as a whole)');

  console.log('[6] WebSocket upgrade passthrough');
  const wsResult = await new Promise((resolve) => {
    const sock = net.connect(pport, '127.0.0.1');
    let buf = '';
    let phase = 'handshake';
    const fail = () => resolve({ ok: false });
    sock.setTimeout(3000, fail);
    sock.on('error', fail);
    sock.on('connect', () => {
      sock.write(
        'GET /ws HTTP/1.1\r\nHost: 127.0.0.1:' + pport + '\r\nUpgrade: websocket\r\n' +
        'Connection: Upgrade\r\nSec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\nSec-WebSocket-Version: 13\r\n\r\n'
      );
    });
    sock.on('data', (d) => {
      if (phase === 'handshake') {
        buf += d.toString('utf8');
        if (buf.includes('101')) {
          phase = 'data';
          sock.write(Buffer.from('hello-ws'));
        }
      } else {
        const s = d.toString('utf8');
        if (s.startsWith('pong:hello-ws')) { sock.destroy(); resolve({ ok: true }); }
      }
    });
    sock.on('close', () => { if (phase !== 'done') resolve({ ok: false }); });
  });
  ok(wsResult.ok, 'WS handshake 101 + Cookie injected + data in both directions');

  console.log('[7] localhost origin (tab isolation) exchanges independently');
  const viaLocalhost = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: pport, path: '/', method: 'GET', agent: testAgent, headers: { host: 'localhost:' + pport } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
  ok(viaLocalhost.status === 200 && /FAKE-DSH-INDEX/.test(viaLocalhost.body), 'Host=localhost origin is exchanged automatically and passes');

  // Shutdown does not trust a graceful exit (idle keep-alive connections can hold up the server.close callback):
  // a timeout fallback plus a forced exit keeps the test process deterministic.
  await Promise.race([
    Promise.all([proxy.close().catch(() => {}), dsh2.close().catch(() => {})]),
    sleep(1500)
  ]);
  console.log('\nAll passed: ' + passed + ' assertions ✓');
  process.exit(0);
}

main().then(() => process.exit(0), (e) => {
  console.error(e);
  process.exit(1);
});
