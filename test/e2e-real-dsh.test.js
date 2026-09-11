'use strict';
/**
 * Real dsh web end-to-end verification (starts a separate local instance that does
 * not affect a dsh already running on this machine).
 * Run: node test/e2e-real-dsh.test.js
 * Flow:
 *  1) spawn `dsh web --host 127.0.0.1 --port <p> --no-open` (the same arguments the extension uses);
 *  2) capture the `dsh web: http://127.0.0.1:<p>/?token=...` authentication link from stdout;
 *  3) control group: a bare address straight to the server → 401 (the new access rules are in effect);
 *  4) ensureAuthProxy + learnDshToken → waitAuthed → hasCookieForBase;
 *  5) GET / through the proxy → 200 home page; POST /api/workspace.create (a real RPC envelope) → 200;
 *  6) cleanup: taskkill ends the test instance.
 */
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const net = require('net');
const assert = require('assert');
const Module = require('module');

const PORT = 3199;
const DSH_URL = 'http://127.0.0.1:' + PORT;

function portFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}

function getJson(port, reqPath, method, body) {
  return new Promise((resolve, reject) => {
    const agent = new http.Agent({ keepAlive: false });
    const req = http.request({
      host: '127.0.0.1', port, path: reqPath, method, agent,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Can dsh write its profile directory?
 *
 * dsh keeps its state under ~/.dsh. When that tree is read-only (a sandboxed or
 * containerised CI runner, for instance) dsh exits immediately with EROFS before it
 * ever prints an authentication link, and this test would report a failure that has
 * nothing to do with the extension. Detect that up front and skip instead, so a
 * green run still means something.
 *
 * @returns {string|null} a human-readable reason to skip, or null when dsh can run
 */
function skipReason() {
  const home = os.homedir();
  const profile = path.join(home, '.dsh');
  const probe = path.join(profile, '.e2e-write-probe');
  try {
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
  } catch (e) {
    return 'dsh cannot write its profile directory (' + profile + '): ' + (e && e.code ? e.code : e.message);
  }
  return null;
}

async function main() {
  const skip = skipReason();
  if (skip) {
    console.log('SKIP: ' + skip);
    console.log('      This test needs a real dsh with a writable ~/.dsh profile.');
    return;
  }

  if (!(await portFree(PORT))) {
    console.error('Port ' + PORT + ' is in use; free it and try again.');
    process.exit(2);
  }

  // ---- vscode stub (settings point at the test instance) ----
  const vscodeStub = {
    workspace: {
      getConfiguration: () => ({
        get: (k, d) => {
          if (k === 'dshPanel.url') return DSH_URL;
          if (k === 'dshPanel.port') return PORT;
          if (k === 'dshPanel.host') return '127.0.0.1';
          return d;
        }
      }),
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
  const { ensureAuthProxy, learnDshToken } = ext.__internals;

  // ---- start a real dsh web (the same spawn approach the extension uses) ----
  console.log('[1] starting dsh web --port ' + PORT + ' --no-open …');
  const child = spawn('dsh', ['web', '--host', '127.0.0.1', '--port', String(PORT), '--no-open'], {
    cwd: os.homedir(),
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let authLine = null;
  let buf = '';
  const authReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no dsh web authentication link captured within 120 seconds')), 120000);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line.trim()) console.log('    | ' + line.slice(0, 160));
        const m = line.match(/dsh web:\s*(\S+)/);
        if (m && /[?&]token=/.test(m[1]) && !authLine) {
          authLine = m[1];
          clearTimeout(timer);
          resolve(authLine);
        }
      }
      if (buf.length > 256 * 1024) buf = '';
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8').trimEnd();
      if (s) console.error('    ! ' + s.slice(0, 160));
    });
    child.on('exit', (code) => {
      if (!authLine) { clearTimeout(timer); reject(new Error('dsh exited early, code=' + code)); }
    });
  });

  let failed = null;
  let killedOwnChild = false; // stage [5] kills the instance we started and has an extension function start a new one
  try {
    const line = await authReady;
    console.log('[2] authentication link captured: ' + line.slice(0, 60) + '…(token truncated)');

    console.log('[3] control group: bare address straight to the real dsh →');
    const direct = await getJson(PORT, '/', 'GET', null);
    console.log('    status=' + direct.status);
    assert.strictEqual(direct.status, 401, 'a bare address should return 401');
    const directApi = await getJson(PORT, '/api/workspace.create', 'POST', JSON.stringify({
      type: 'client-request', rpcId: 'e2e-direct', method: 'workspace.create', payload: { path: os.homedir() }
    }));
    console.log('    /api/workspace.create status=' + directApi.status);
    assert.strictEqual(directApi.status, 401, 'a bare API call should return 401');

    console.log('[4] proxy + stdout token → invisible authentication');
    const proxy = await ensureAuthProxy();
    assert.ok(proxy, 'the proxy should be created');
    assert.ok(learnDshToken(line), 'the token should be learned');
    await proxy.waitAuthed(20000);
    assert.ok(proxy.hasCookieForBase(), 'the Cookie should be exchanged');

    const pport = proxy.port();
    const index = await getJson(pport, '/', 'GET', null);
    console.log('    GET  proxy /            → ' + index.status + ' (' + index.body.length + ' bytes)');
    assert.strictEqual(index.status, 200, 'the home page through the proxy should be 200');
    assert.ok(index.body.length > 200, 'the home page should be the real front-end page');

    const envelope = JSON.stringify({
      type: 'client-request',
      rpcId: 'e2e-' + crypto.randomBytes(3).toString('hex'),
      method: 'workspace/create',
      payload: { args: { request: { path: os.homedir() } } }
    });
    const api = await getJson(pport, '/api/workspace/create', 'POST', envelope);
    console.log('    POST proxy /api/workspace/create → ' + api.status);
    console.log('    ↳ ' + api.body.slice(0, 400));
    assert.strictEqual(api.status, 200, 'the real API through the proxy should be 200 (fence + authentication passed)');
    const apiParsed = JSON.parse(api.body);
    assert.ok(apiParsed.result && apiParsed.result.ok === true, 'the workspace/create operation should succeed: ' + api.body.slice(0, 200));

    // the old dotted endpoint should now be 404 (confirming the new endpoint convention is in effect)
    const legacy = await getJson(pport, '/api/workspace.create', 'POST', envelope.replace('workspace/create', 'workspace.create'));
    console.log('    POST proxy /api/workspace.create (old dotted form) → ' + legacy.status + ' (a new dsh should return 404, which the extension fallback logic absorbs)');

    // session/create: the critical provider path (same shape as the extension createPayload)
    const createEnv = JSON.stringify({
      type: 'client-request',
      rpcId: 'e2e-sc-' + crypto.randomBytes(3).toString('hex'),
      method: 'session/create',
      payload: { args: { request: { cwd: os.homedir() } } }
    });
    const sc = await getJson(pport, '/api/session/create', 'POST', createEnv);
    console.log('    POST proxy /api/session/create → ' + sc.status);
    console.log('    ↳ ' + sc.body.slice(0, 400));
    assert.strictEqual(sc.status, 200, 'session/create through the proxy should be 200');
    const scParsed = JSON.parse(sc.body);
    assert.ok(scParsed.result && scParsed.result.ok === true && scParsed.result.value && scParsed.result.value.sessionId, 'session/create should return a sessionId: ' + sc.body.slice(0, 200));
    const newSid = scParsed.result.value.sessionId;

    // session/page: the provider history polling path (fetchSessionHistory's two-step cursor probe)
    const pageCall = (seq) => JSON.stringify({
      type: 'client-request',
      rpcId: 'e2e-pg-' + crypto.randomBytes(3).toString('hex'),
      method: 'session/page',
      payload: { args: { request: { address: { kind: 'session', sessionId: newSid }, throughSeq: seq, maxMessages: 100 } } }
    });
    let cursor = -1;
    const probe = await getJson(pport, '/api/session/page', 'POST', pageCall(Number.MAX_SAFE_INTEGER));
    const pm = /past cursor (-?\d+)/.exec(probe.body);
    if (pm) cursor = parseInt(pm[1], 10);
    console.log('    POST proxy /api/session/page probe → cursor ' + cursor);
    assert.ok(cursor >= 0, 'a cursor should be parsed out of the error message');
    const pg = await getJson(pport, '/api/session/page', 'POST', pageCall(cursor));
    assert.strictEqual(pg.status, 200, 'session/page through the proxy should be 200');
    const pgParsed = JSON.parse(pg.body);
    assert.ok(pgParsed.result && pgParsed.result.ok === true && Array.isArray(pgParsed.result.value.records), 'session/page should return records: ' + pg.body.slice(0, 200));
    console.log('    POST proxy /api/session/page → ok (records=' + pgParsed.result.value.records.length + ', hasMore=' + pgParsed.result.value.hasMore + ')');

    console.log('[5] real restart scenario (the same path as Restart dsh web in the extension)');
    const tokenBeforeRestart = proxy.token();
    // kill the instance this E2E test started, freeing the port
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killedOwnChild = true;
    }
    for (let i = 0; i < 20; i++) { await sleep(500); if (await portFree(PORT)) break; }
    assert.ok(await portFree(PORT), 'the port should be released');
    // restart through the production function (it waits internally for the "authentication link printed" full-startup signal)
    const restartStart = Date.now();
    const restartOk = await ext.__internals.startDshAndWaitReady(DSH_URL);
    const restartMs = Date.now() - restartStart;
    assert.ok(restartOk, 'startDshAndWaitReady should succeed');
    console.log('    restart ready in ' + restartMs + 'ms');
    assert.notStrictEqual(proxy.token(), tokenBeforeRestart, 'a token from the new process should be captured');
    assert.ok(proxy.hasCookieForBase(), 'the Cookie should be ready after the restart');
    let selfStatus = 0;
    for (let i = 0; i < 15; i++) {
      selfStatus = await proxy.probeSelf(2500);
      if (selfStatus === 200) break;
      await sleep(400);
    }
    assert.strictEqual(selfStatus, 200, 'the proxy self-check should be 200 after the restart (no half-ready window)');
    console.log('    proxy self-check → 200 ✓');

    console.log('\nEnd-to-end verification passed ✓ (cleaning up the test instance)');
  } catch (e) {
    failed = e;
  } finally {
    // Clean up the test instance process tree (clean up before exiting so this finally block always runs).
    // After [5] the port belongs to the new instance the extension function started: find the PID by port as a fallback.
    let killed = false;
    if (process.platform === 'win32' && child.pid && !killedOwnChild) {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
      killed = true;
    } else if (child.pid && !killedOwnChild) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      killed = true;
    }
    if (!killed) {
      // clean up the instance the extension started, by port (Windows: netstat finds the LISTENING PID → taskkill /t)
      const net = require('child_process').execSync('netstat -ano -p tcp', { encoding: 'utf8' });
      const pids = new Set();
      for (const line of net.split(/\r?\n/)) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 5 && parts[0] === 'TCP' && parts[1] === '127.0.0.1:' + PORT && parts[3] === 'LISTENING' && parts[4]) {
          pids.add(parts[4]);
        }
      }
      for (const pid of pids) {
        try { spawn('taskkill', ['/pid', pid, '/t', '/f'], { stdio: 'ignore', windowsHide: true }); } catch { /* noop */ }
      }
      if (process.platform !== 'win32') {
        try { require('child_process').execSync('fuser -k ' + PORT + '/tcp 2>/dev/null || true'); } catch { /* noop */ }
      }
    }
    await sleep(800);
  }
  if (failed) throw failed;
}

const guard = setTimeout(() => {
  console.error('Overall timeout (300s); forcing exit.');
  process.exit(3);
}, 300000);
guard.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

main().then(async () => {
  // shut the proxy down (no trust in a graceful exit; a timeout is the fallback)
  try {
    const { ensureAuthProxy } = ext.__internals;
    // authProxy is a module-level singleton that the process exit releases; this is only here for completeness.
    void ensureAuthProxy;
  } catch { /* noop */ }
  process.exit(0);
}, (e) => {
  console.error('Verification failed:', e && e.message ? e.message : e);
  process.exit(1);
});
