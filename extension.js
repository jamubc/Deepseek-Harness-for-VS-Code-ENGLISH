const vscode = require('vscode');
const http = require('http');
const https = require('https');
const os = require('os');
const crypto = require('crypto');
const { spawn, exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
// English language pack (see l10n.js and TERMINOLOGY.md). User-facing strings stay
// in their upstream Chinese form as translation keys so upstream merges stay clean;
// `t()` resolves them to English on every VS Code UI language.
const { t, applyManifestTranslations } = require('./l10n.js');

const VIEW_ID = 'dsh.webview';
const DEFAULT_URL = 'http://127.0.0.1:3080';

// Reference to the current webview view, used by the Refresh command.
let activeView = null;
// The dsh child process started by the extension itself; when reusing an existing service it is neither recorded nor managed.
let managedChild = null;
// Prevents several view instances from triggering startup at the same time.
let ensurePromise = null;
// The resolved dsh invocation: { cmd, prefix }. null means it has not been resolved yet or none is available.
// Prefer the global installation (the dsh command), then the npx cache installation (an npx install does not write to the global PATH).
let dshInvocation = null;
let dshInvocationAt = 0;
// Editor tab mode: the currently open DSH tab panel (null when no tab is open).
let activeTab = null;
// Extension context (globalState persists the session mapping).
let gContext = null;
// Whether the dsh language model provider (DSH (DeepSeek Harness) in the model picker) registered successfully.
let dshModelProviderRegistered = false;
// web browser authentication added in dsh 0.1.2-rc: process launch token (changes on every Restart, learned from stdout).
let dshLaunchToken = null;
// Local managed auth proxy (null = not created or unavailable: Remote scenario / target is not a loopback address).
let authProxy = null;
// Concurrency de-duplication for ensureAuthProxy: created only once when several views/APIs trigger it at the same time.
let authProxyPromise = null;
// Set when an old dsh version does not recognize --no-open (after a quick startup exit, the flag is dropped and startup is retried).
let dshNoOpenBroken = false;
// Whether dsh supports web browser authentication (set to true when the stdout token line is first captured;
// set to false and persisted once it is confirmed to be an old dsh, and the startup wait logic skips accordingly).
let dshAuthCapable;
// Timestamp of the last "dsh web: <url>" print line (printed by both old and new versions, used as the fully-started signal).
let dshBootAnnouncedAt = 0;
// In-process cache of the --no-open support probe result (undefined = not probed).
let dshNoOpenSupported;
// Last time the auth guidance prompt was shown (cooldown, to avoid pestering repeatedly).
let lastAuthPromptAt = 0;
// Reload function for tab mode (to re-render the tab once auth guidance completes).
let tabReloadFn = null;

/**
 * Read the configuration.
 */
function cfg() {
  return vscode.workspace.getConfiguration();
}

function getUrl() {
  return cfg().get('dshPanel.url', DEFAULT_URL);
}

// ── Configuration input sanitization (security hardening: the settings below go through a shell:true child process, so they must be constrained to a safe character set) ──
// Hostname allowlist: IPv4/IPv6 literals and domain names.
const HOST_PATTERN = /^[A-Za-z0-9._:-]+$/;
// shell metacharacters: rejected on sight (both cmd.exe and POSIX sh interpret them).
const SHELL_META_PATTERN = /[&|<>^%!"`;]|\r|\n/;
const DEFAULT_PORT = 3080;

function getHost() {
  const raw = String(cfg().get('dshPanel.host', '127.0.0.1') || '').trim();
  // Anything invalid (shell metacharacters and the like) falls back to the default loopback address, closing startDsh argument injection.
  return HOST_PATTERN.test(raw) ? raw : '127.0.0.1';
}

function getPort() {
  // Integer coercion plus port range validation: closes shell concatenation injection in freePort and argument injection in startDsh.
  const n = Math.floor(Number(cfg().get('dshPanel.port', DEFAULT_PORT)));
  return Number.isFinite(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

/** Sanitize the user-configured command: reject shell metacharacters (spaces are allowed; the Windows shell adds quotes before launch). */
function sanitizeCommand(cmd) {
  const s = String(cmd || '').trim();
  if (!s || SHELL_META_PATTERN.test(s)) return null;
  return s;
}

function getDshCommand() {
  // When an invalid command is configured (metacharacters included), fall back to 'dsh'; a later probe failure naturally lands on the npx fallback.
  return sanitizeCommand(cfg().get('dshPanel.dshCommand', 'dsh')) || 'dsh';
}

/**
 * Run one command and report whether it succeeded (exit code === 0).
 * Runs on the machine where the extension runs — the local machine in a local scenario, the remote server in a Remote/vscode-server scenario.
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function runCommandOk(cmd, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    // Defense in depth (PR #12 idea): cmd comes from getDshCommand() (already sanitized), rejected once more here.
    if (typeof cmd !== 'string' || cmd === '' || SHELL_META_PATTERN.test(cmd)) {
      resolve(false);
      return;
    }
    // Same rules as startDsh: contains spaces and really is an existing file → quote it; multi-token prefix → let the shell tokenize.
    // On POSIX, shell:false passes arguments straight to the process as an array (no interpreter, no injection surface);
    // on Windows, shell:true is required to hit the dsh.cmd shim (on Node ≥18.20 executing
    // .cmd without a shell throws EINVAL, the CVE-2024-27980 hardening), and the injection surface is closed by the sanitization + allowlist above.
    const cmdText = (process.platform === 'win32' && /\s/.test(cmd) && fs.existsSync(cmd)) ? '"' + cmd + '"' : cmd;
    const child = spawn(cmdText, args, {
      shell: process.platform === 'win32',
      stdio: 'ignore',
      windowsHide: true
    });
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    setTimeout(() => {
      try { child.kill(); } catch (_) { /* noop */ }
      finish(false);
    }, timeoutMs);
  });
}

/**
 * Run a command and capture stdout (used to probe dsh capabilities, e.g. `dsh web --help`).
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<string>} stdout (rejects on failure)
 */
function runCommandOutput(cmd, args, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    // Defense in depth (PR #12 idea): same as runCommandOk.
    if (typeof cmd !== 'string' || cmd === '' || SHELL_META_PATTERN.test(cmd)) {
      reject(new Error(t('命令包含 shell 元字符或为空，已拒绝执行')));
      return;
    }
    if (process.platform === 'win32') {
      // Windows: dsh is a .cmd shim and must go through cmd.exe (without a shell it is EINVAL/ENOENT,
      // see the CVE-2024-27980 hardening); cmd/arguments are already sanitized, and file paths with spaces are quoted.
      const quoted = (/\s/.test(cmd) && fs.existsSync(cmd)) ? `"${cmd}"` : cmd;
      exec(`${quoted} ${args.join(' ')}`, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout || ''));
      });
    } else {
      // POSIX: execFile has no shell — arguments go straight to the process as an array (the second layer of defense from PR #12:
      // even if sanitization is bypassed, metacharacters are merely literal file-name characters and cannot inject).
      execFile(cmd, args, {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1024 * 1024
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout || ''));
      });
    }
  });
}

/**
 * Resolve an available dsh invocation and return { cmd, prefix }, or null.
 * 1) the configured dsh command first (default 'dsh', i.e. installed globally via npm and already on the PATH);
 * 2) fall back to the npx cache installation (an npx install only caches into the npx directory and does not write to the global PATH,
 *    so 'dsh' is not on the PATH, but 'npx @deepseek-ai/dsh' still runs).
 * The npx probe uses --no-install: it only checks the local/global/npx caches and does not trigger a download when missing,
 * which preserves the existing flow of showing an install prompt when nothing is installed at all.
 * @returns {Promise<{cmd: string, prefix: string[]} | null>}
 */
async function resolveDshInvocation() {
  const cmd = getDshCommand();
  if (await runCommandOk(cmd, ['--version'])) {
    return { cmd, prefix: [] };
  }
  if (await runCommandOk('npx', ['--no-install', '@deepseek-ai/dsh', '--version'])) {
    return { cmd: 'npx', prefix: ['--yes', '@deepseek-ai/dsh'] };
  }
  return null;
}

/**
 * Install dsh (npm global install). In a remote scenario this runs on the server.
 * @returns {Promise<void>}
 */
function installDsh() {
  return new Promise((resolve, reject) => {
    exec('npm install -g @deepseek-ai/dsh', {
      timeout: 300000,
      windowsHide: true
    }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error((stderr || '').trim() || err.message));
      } else {
        resolve();
      }
    });
  });
}

/**
 * Make sure dsh is installed. When it is missing, prompt the user according to the configuration and install it on their behalf.
 * @returns {Promise<boolean>} whether it is installed and usable in the end.
 */
async function ensureDshInstalled() {
  // An invocation that has already resolved successfully is reused directly (within 15 minutes): this avoids spawning a subprocess to probe
  // dsh/npx on every prompt (repeated probing during concurrent chats slows the extension host and makes the later chat stutter).
  if (dshInvocation && (Date.now() - dshInvocationAt) < 15 * 60 * 1000) {
    return true;
  }
  const inv = await resolveDshInvocation();
  if (inv) {
    dshInvocation = inv;
    dshInvocationAt = Date.now();
    return true;
  }

  if (!cfg().get('dshPanel.autoInstallDsh', true)) {
    return false;
  }

  const choice = await vscode.window.showWarningMessage(
    t('检测到当前环境未安装 DeepSeek Harness (dsh)，是否现在安装？'),
    { modal: true },
    t('安装')
  );
  if (choice !== t('安装')) {
    return false;
  }

  const installed = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: t('正在安装 DeepSeek Harness（npm install -g @deepseek-ai/dsh）…'),
    cancellable: false
  }, async () => {
    try {
      await installDsh();
      return true;
    } catch (e) {
      vscode.window.showErrorMessage(t('DeepSeek Harness 安装失败：{0}', [e.message]));
      return false;
    }
  });

  if (!installed) {
    return false;
  }
  const after = await resolveDshInvocation();
  if (after) {
    dshInvocation = after;
    dshInvocationAt = Date.now();
    return true;
  }
  return false;
}

/**
 * Convert the service address into a display address the webview can reach.
 * In a local scenario the original address is returned; in a Remote/vscode-server scenario, asExternalUri
 * sets up port forwarding automatically (either an address with a local forwarded port or an HTTPS forwarding domain),
 * exposing the remote 3080 locally for the iframe to load.
 * @returns {Promise<string>}
 */
async function resolveDisplayUrl() {
  const url = getUrl();
  try {
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    return external.toString();
  } catch {
    return url;
  }
}

/**
 * Workspace directory: the first workspace folder opened in VS Code, otherwise the user home directory.
 * This is the workspace (cwd) dsh starts in.
 * @returns {string}
 */
function getWorkspaceDir() {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return os.homedir();
}

/**
 * Probe whether the DSH service is reachable. A successful connection (any status code) counts as open.
 * @param {string} url
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function checkUrl(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Send a JSON RPC request to the DSH /api endpoint.
 * @param {string} url
 * @param {object} payload
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
function httpPostJson(url, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (e) {
      reject(e);
      return;
    }
    const lib = target.protocol === 'https:' ? https : http;
    const data = JSON.stringify(payload);
    const req = lib.request({
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: target.pathname + target.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        let out;
        try {
          out = JSON.parse(body);
        } catch {
          out = { raw: body };
        }
        out.__httpStatus = res.statusCode;
        resolve(out);
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.write(data);
    req.end();
  });
}

/**
 * Determine whether this is a "non-conversation" content block injected by VS Code (system prompt/environment info/context reminders, etc.).
 * @param {string} t
 * @returns {boolean}
 */
function isJunkUserText(text) {
  if (!text) return true;
  if (/^You are an expert/i.test(text)) return true; // VS Code system prompt (contains <instructions><skills><description> …)
  if (text.indexOf('<instructions>') >= 0 && text.indexOf('<skills>') >= 0) return true;
  if (/^\s*<(environment_info|workspace_info|context|reminderInstructions|user_info|instructions|userMemory|sessionMemory|repoMemory)>/.test(text)) return true;
  return false;
}

/**
 * Extract the real prompt from a <userRequest>...</userRequest> wrapper; return null when it is not wrapped.
 * @param {string} t
 * @returns {string|null}
 */
function extractUserRequest(t) {
  let m = t.match(/<userRequest>\s*([\s\S]*?)\s*<\/userRequest>/);
  if (m) return m[1].trim();
  // VS Code also wraps the real prompt in <prompt>…</prompt> (usually preceded by instructions/context blocks)
  m = t.match(/<prompt>\s*([\s\S]*?)\s*<\/prompt>/);
  return m ? m[1].trim() : null;
}

/**
 * Strip the Copilot instructions preamble injected by VS Code and the <instructions>…</instructions> block.
 * These are "context", not a user prompt; DSH has its own instruction system, so they should not be sent back as conversation content.
 * @param {string} t
 * @returns {string}
 */
function stripCopilotContext(t) {
  let s = String(t || '');
  // Remove <instructions>…</instructions> (including the .copilot/instructions attachment and references such as AGENTS.md)
  s = s.replace(/<instructions>[\s\S]*?<\/instructions>/gi, '');
  // Remove the VS Code instructions preamble sentence (fallback for the Chinese and English variants)
  s = s.replace(/when generating code, please follow these user provided coding instructions\.?/gi, '');
  s = s.replace(/you can ignore an instruction if it contradicts a system message\.?/gi, '');
  return s.trim();
}

/**
 * Register the current VS Code workspace with the DSH workspace list.
 * workspace/create is idempotent: it returns the existing record when one is already there and never duplicates.
 * Best effort; a failure does not affect panel rendering.
 * @returns {Promise<boolean>}
 */
async function registerWorkspace() {
  if (!cfg().get('dshPanel.autoRegisterWorkspace', true)) {
    return false;
  }
  try {
    const base = await apiBase();
    const value = await dshRpc(base, 'workspace.create', { path: getWorkspaceDir() }, 8000);
    return !!value;
  } catch {
    return false;
  }
}

// =====================================================================
// dsh web browser authentication (added in dsh 0.1.2-rc) and the local managed auth proxy
// ---------------------------------------------------------------------
// Every launch of a new dsh web generates a "process launch token" and prints to stdout an authentication link of the form
//   dsh web: http://127.0.0.1:3080/?token=<64-character token>
// When a browser opens that link, the server exchanges the token for a signed `HttpOnly; SameSite=Strict`
// Cookie (bound to the request Host); every request afterwards passes with the Cookie, and a bare address always gets 401.
// /api has an additional browser trust fence: the Host must be loopback (or trusted), the Origin must match the Host, and
// cross-site sec-fetch-site is rejected.
//
// Inside the webview the dsh page sits in a third-party iframe context, where a SameSite=Strict Cookie can neither
// be set nor be sent, so "load the token link directly in the iframe" is unreliable. The approach is therefore:
// the extension captures the token link from stdout and starts an "auth proxy" on a random local loopback port; the proxy
// performs the token→Cookie exchange, then injects the Cookie and Host into every forwarded request. The webview and
// the extension's own /api calls all go through the proxy — no dsh security mechanism is disabled, and it is seamless throughout.
// =====================================================================

const AUTH_PROXY_STATE_KEY = 'dsh.webAuth.tokenCache';

/** Whether this is a local (non-Remote) scenario where dshPanel.url points at a loopback address. */
function isLocalLoopbackTarget() {
  try {
    if (vscode.env && vscode.env.remoteName) return false;
    const u = new URL(getUrl());
    return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

/** Host normalization matching the dsh server: new URL('http://' + host).host. */
function normAuthority(hostHeader) {
  try {
    return new URL('http://' + String(hostHeader || '')).host;
  } catch {
    return undefined;
  }
}

/** Extract the token parameter value from an authentication link or a bare token string. */
function extractTokenParam(input) {
  const s = String(input || '').trim();
  if (/^[A-Za-z0-9_.\-]{16,}$/.test(s)) return s; // it is already a token
  const m = s.match(/[?&]token=([A-Za-z0-9_.\-]+)/);
  return m ? m[1] : null;
}

/**
 * Learn/update the dsh launch token (from a stdout line or an authentication link pasted by the user).
 * Right after the update, silently refresh the Cookie for the proxy's local origins (127.0.0.1 / localhost),
 * and cache the token in globalState so other VS Code windows / reloads can reuse it (without bothering the user).
 * @param {string} tokenOrUrl
 * @returns {boolean} whether a token was extracted successfully
 */
/** Record/persist the web authentication capability of dsh (true = supported, false = old version without authentication). */
function setDshAuthCapable(value) {
  dshAuthCapable = value;
  if (gContext) {
    gContext.globalState.update('dsh.authCapable', value).then(() => {}, () => {});
  }
}

function learnDshToken(tokenOrUrl) {
  const token = extractTokenParam(tokenOrUrl);
  if (!token) return false;
  dshLaunchToken = token;
  if (dshAuthCapable !== true) {
    setDshAuthCapable(true);
  }
  if (gContext) {
    gContext.globalState.update(AUTH_PROXY_STATE_KEY, {
      target: getUrl(),
      token: token,
      ts: Date.now()
    }).then(() => {}, () => {});
  }
  if (authProxy) authProxy.onToken(token);
  return true;
}

/**
 * Make sure the local managed auth proxy is running (random port on 127.0.0.1, reachable only from this machine).
 * Returns null in a Remote scenario or when the target is not a loopback address (keeping the original direct connection).
 * @returns {Promise<object|null>}
 */
async function ensureAuthProxy() {
  if (!isLocalLoopbackTarget()) return null;
  if (authProxy) {
    if (authProxy.target() !== getUrl()) {
      // Target changed by configuration: the old Cookie/token is invalid for the new instance, so the whole group is rebuilt.
      const old = authProxy;
      authProxy = null;
      authProxyPromise = null;
      await old.close().catch(() => {});
    } else {
      return authProxy;
    }
  }
  if (authProxyPromise) return authProxyPromise;
  authProxyPromise = (async () => {
    let proxy;
    try {
      proxy = await createAuthProxy(getUrl());
    } catch (e) {
      console.error(t('[DeepSeek Harness] 认证代理启动失败，回退直连：'), e);
      return null;
    }
    authProxy = proxy;
    // Prefer reusing the token and auth capability flag cached by other windows/the previous session, to stay as seamless as possible.
    if (gContext) {
      try {
        if (dshAuthCapable === undefined) {
          const cap = gContext.globalState.get('dsh.authCapable');
          if (typeof cap === 'boolean') dshAuthCapable = cap;
        }
      } catch { /* ignore a failed cache read */ }
    }
    if (!dshLaunchToken && gContext) {
      try {
        const cache = gContext.globalState.get(AUTH_PROXY_STATE_KEY);
        if (cache && cache.target === getUrl() && cache.token) {
          dshLaunchToken = cache.token;
        }
      } catch { /* ignore a failed cache read */ }
    }
    if (dshLaunchToken) proxy.onToken(dshLaunchToken);
    return proxy;
  })();
  const result = await authProxyPromise;
  if (result === null) authProxyPromise = null; // allow a retry next time after a failure
  return result;
}

/**
 * Create the auth proxy HTTP server:
 * - listens on a random 127.0.0.1 port (also reachable as localhost, which serves tab origin isolation);
 * - each source authority (request Host) holds its own exchanged signed Cookie;
 * - injects Host and Cookie when forwarding; on 401 with a token held, re-exchanges automatically and retries once;
 * - strips Set-Cookie from responses (the proxy holds the Cookie, so it never enters the webview third-party context);
 * - forwards WebSocket upgrades with the original headers and passes traffic through in both directions (injecting Host/Cookie).
 * @param {string} targetUrl dsh web service address
 * @returns {Promise<object>} proxy handle
 */
function createAuthProxy(targetUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(targetUrl);
    const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
    const cookies = new Map(); // authority -> 'name=value'
    const exchanges = new Map(); // authority -> Promise (de-duplicated per authority)
    let token = null;
    let port = 0;

    /** Exchange a Cookie for the given authority (GET /?token=, with Host pointing at the proxy's own authority). */
    function exchangeFor(authority) {
      const key = normAuthority(authority) || String(authority);
      if (!token) return Promise.resolve(null);
      const inFlight = exchanges.get(key);
      if (inFlight) return inFlight;
      const p = new Promise((done) => {
        const req = http.request({
          hostname: target.hostname,
          port: targetPort,
          path: '/?token=' + encodeURIComponent(token),
          method: 'GET',
          headers: { host: key, connection: 'close', accept: '*/*' }
        }, (res) => {
          res.resume();
          let cookieValue = null;
          const setCookies = res.headers['set-cookie'];
          if (res.statusCode === 303 && Array.isArray(setCookies) && setCookies.length > 0) {
            const raw = setCookies[0];
            const eq = raw.indexOf('=');
            const semi = raw.indexOf(';');
            if (eq > 0 && (semi < 0 || semi > eq)) cookieValue = raw.slice(0, semi < 0 ? raw.length : semi).trim();
          }
          if (cookieValue) cookies.set(key, cookieValue);
          done(cookieValue);
        });
        req.on('error', () => done(null));
        req.setTimeout(5000, () => req.destroy(new Error('auth exchange timeout')));
        req.end();
      }).finally(() => exchanges.delete(key));
      exchanges.set(key, p);
      return p;
    }

    /** Once the token is in place, silently pre-exchange cookies for both local origins. */
    async function preAuth() {
      if (!token) return;
      await Promise.all([
        exchangeFor(`127.0.0.1:${port}`),
        exchangeFor(`localhost:${port}`)
      ]).catch(() => {});
    }

    /** Auth probe with no cookie: the status code from fetching the upstream index page directly (401 = authentication required). */
    function probeIndexStatus(timeoutMs = 4000) {
      return new Promise((done) => {
        try {
          const req = http.request({
            hostname: target.hostname,
            port: targetPort,
            path: '/',
            method: 'GET',
            headers: { accept: '*/*' }
          }, (res) => {
            res.resume();
            done(res.statusCode || 0);
          });
          req.on('error', () => done(0));
          req.setTimeout(timeoutMs, () => { req.destroy(); done(0); });
          req.end();
        } catch {
          done(0);
        }
      });
    }

    /** End-to-end self-check: request the proxy's own index page (full forwarding chain); 200 means "webview usable". */
    function probeSelf(timeoutMs = 2500) {
      return new Promise((done) => {
        try {
          const req = http.get({
            host: '127.0.0.1',
            port,
            path: '/',
            agent: new http.Agent({ keepAlive: false })
          }, (res) => {
            res.resume();
            done(res.statusCode || 0);
          });
          req.on('error', () => done(0));
          req.setTimeout(timeoutMs, () => { req.destroy(); done(0); });
        } catch {
          done(0);
        }
      });
    }

    /** Strip hop-by-hop headers, inject Host/Cookie, then forward. */
    function buildForwardHeaders(req, authority, cookieValue) {
      const headers = { ...req.headers };
      delete headers.host;
      delete headers.cookie;
      for (const h of ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers', 'transfer-encoding', 'upgrade']) {
        delete headers[h];
      }
      headers.host = authority;
      if (cookieValue) headers.cookie = cookieValue;
      return headers;
    }

    /** Plain HTTP forwarding (with one automatic re-exchange and retry on 401). */
    async function forward(req, res) {
      const authority = normAuthority(req.headers.host) || `127.0.0.1:${port}`;
      let cookie = cookies.get(authority) || null;
      if (!cookie && token) cookie = await exchangeFor(authority);
      let status = await attempt(cookie);
      if (status === 401 && token) {
        const fresh = await exchangeFor(authority);
        if (fresh && fresh !== cookie) status = await attempt(fresh);
      }
      return status;

      function attempt(cookieValue) {
        return new Promise((done) => {
          let settled = false;
          const finish = (v) => { if (!settled) { settled = true; done(v); } };
          let upstream;
          try {
            upstream = http.request({
              hostname: target.hostname,
              port: targetPort,
              path: req.url,
              method: req.method,
              headers: buildForwardHeaders(req, authority, cookieValue)
            }, (ures) => {
              if (ures.statusCode === 401) {
                ures.resume();
                finish(401);
                return;
              }
              const outHeaders = { ...ures.headers };
              delete outHeaders['set-cookie'];
              delete outHeaders['transfer-encoding'];
              delete outHeaders['connection'];
              res.writeHead(ures.statusCode || 502, outHeaders);
              ures.pipe(res);
              ures.on('end', () => finish(ures.statusCode || 0));
              ures.on('error', () => finish(ures.statusCode || 0));
            });
          } catch {
            finish(0);
            return;
          }
          upstream.on('error', () => {
            if (!res.headersSent) {
              res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
            }
            try { res.end(t('DeepSeek Harness 代理：上游 dsh 连接失败')); } catch { /* noop */ }
            finish(0);
          });
          req.on('error', () => { try { upstream.destroy(); } catch { /* noop */ } });
          req.pipe(upstream);
        });
      }
    }

    /** WebSocket upgrade pass-through (inject Host/Cookie, forward raw bytes in both directions). */
    function onUpgrade(req, socket, head) {
      const authority = normAuthority(req.headers.host) || `127.0.0.1:${port}`;
      const cookie = cookies.get(authority) || null;
      const headers = { ...req.headers };
      headers.host = authority;
      if (cookie) headers.cookie = cookie;
      const upstream = http.request({
        hostname: target.hostname,
        port: targetPort,
        path: req.url,
        method: req.method,
        headers
      });
      upstream.on('upgrade', (ures, usocket, uhead) => {
        try {
          const lines = [`HTTP/1.1 ${ures.statusCode} ${ures.statusMessage || ''}`.trimEnd()];
          for (const [k, v] of Object.entries(ures.headers)) {
            if (Array.isArray(v)) { for (const vv of v) lines.push(`${k}: ${vv}`); }
            else if (v !== undefined) lines.push(`${k}: ${v}`);
          }
          socket.write(lines.join('\r\n') + '\r\n\r\n');
          if (uhead && uhead.length) usocket.write(uhead);
          const cleanup = () => {
            try { socket.destroy(); } catch { /* noop */ }
            try { usocket.destroy(); } catch { /* noop */ }
          };
          socket.on('error', cleanup);
          usocket.on('error', cleanup);
          socket.on('close', cleanup);
          usocket.on('close', cleanup);
          usocket.pipe(socket);
          socket.pipe(usocket);
        } catch {
          try { socket.destroy(); } catch { /* noop */ }
        }
      });
      upstream.on('response', (ures) => {
        // Upstream refused the upgrade (e.g. 401/404): relay the status back to the client unchanged.
        const chunks = [];
        ures.on('data', (c) => chunks.push(c));
        ures.on('end', () => {
          try {
            socket.write(
              `HTTP/1.1 ${ures.statusCode} ${ures.statusMessage || ''}\r\n` +
              'content-type: text/plain; charset=utf-8\r\nconnection: close\r\n\r\n' +
              Buffer.concat(chunks).toString('utf8')
            );
            socket.end();
          } catch {
            try { socket.destroy(); } catch { /* noop */ }
          }
        });
      });
      upstream.on('error', () => { try { socket.destroy(); } catch { /* noop */ } });
      upstream.end();
    }

    const server = http.createServer((req, res) => {
      forward(req, res).catch(() => { try { res.destroy(); } catch { /* noop */ } });
    });
    server.on('upgrade', onUpgrade);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      server.removeAllListeners('error');
      server.on('error', (e) => console.error(t('[DeepSeek Harness] 认证代理错误：'), e));
      resolve({
        target: () => targetUrl,
        port: () => port,
        baseUrl: () => `http://127.0.0.1:${port}`,
        urlForTab: () => {
          const u = new URL(`http://127.0.0.1:${port}`);
          u.hostname = 'localhost';
          return u.toString();
        },
        hasCookieForBase: () => cookies.has(`127.0.0.1:${port}`),
        hasCookieForTab: () => cookies.has(`localhost:${port}`),
        token: () => token,
        status: () => ({
          target: targetUrl,
          proxy: `http://127.0.0.1:${port}`,
          tokenKnown: !!token,
          authedAuthorities: [...cookies.keys()]
        }),
        /** For "Open in Browser": an authenticated link carrying the current token (a real browser can exchange the cookie itself). */
        authenticatedUrl: () => {
          if (!token) return targetUrl;
          try {
            const u = new URL(targetUrl);
            u.pathname = '/';
            u.search = '';
            u.hash = '';
            u.searchParams.set('token', token);
            return u.toString();
          } catch {
            return targetUrl;
          }
        },
        onToken: (t) => { token = t; preAuth().catch(() => {}); },
        exchangeFor,
        probeIndexStatus,
        probeSelf,
        /** Wait for the base origin (127.0.0.1) cookie to become ready or to time out; return immediately when there is no token. */
        waitAuthed: (ms = 8000) => new Promise((done) => {
          if (!token || cookies.has(`127.0.0.1:${port}`)) { done(); return; }
          const t0 = Date.now();
          const timer = setInterval(() => {
            if (cookies.has(`127.0.0.1:${port}`) || Date.now() - t0 > ms) {
              clearInterval(timer);
              done();
            }
          }, 120);
        }),
        close: () => new Promise((done) => {
          try {
            server.close(() => done());
            setTimeout(() => done(), 1500).unref();
          } catch { done(); }
        })
      });
    });
  });
}

/**
 * Resolve the final display URL for the panel:
 * - Proxy available and cookie ready → proxy URL (the webview gets seamless authentication through it);
 * - Proxy available but unauthenticated and upstream 401 → { unauthorized: true } (guidance takes over);
 * - Otherwise (Remote / non-loopback / old dsh without auth) → the original direct display URL.
 * @param {boolean} isTab whether tab mode is enabled
 * @returns {Promise<{displayUrl: string} | {unauthorized: true}>}
 */
async function resolvePanelTarget(isTab) {
  let displayUrl = isTab ? getTabDisplayUrl(await resolveDisplayUrl()) : await resolveDisplayUrl();
  const proxy = await ensureAuthProxy();
  if (!proxy) return { displayUrl };
  await proxy.waitAuthed(8000);
  if (proxy.hasCookieForBase()) {
    displayUrl = isTab ? proxy.urlForTab() : proxy.baseUrl();
    // End-to-end readiness check: hand off to the
    // iframe only after the proxy chain (inject Cookie → upstream → response) returns 200, avoiding a failed first load while dsh is half-ready (port listening but plugins/connection not loaded yet).
    const deadline = Date.now() + 6000;
    let probeStatus = 0;
    while (Date.now() < deadline) {
      probeStatus = await proxy.probeSelf(2500);
      if (probeStatus === 200) break;
      await sleep(400);
    }
    return { displayUrl };
  }
  const status = await proxy.probeIndexStatus();
  if (status === 401) return { unauthorized: true };
  return { displayUrl }; // older dsh (no authentication): connect directly as before
}

/**
 * Auth guidance (do-not-disturb policy: triggered only on a confirmed 401 that cannot be authenticated silently, with a 3-minute cooldown):
 * Offers two actions — restart dsh under extension management (automatic authentication, recommended), or paste the authentication link printed by dsh web.
 * @param {boolean} isTab
 */
function maybeGuideAuth(isTab) {
  const now = Date.now();
  if (now - lastAuthPromptAt < 3 * 60 * 1000) return;
  lastAuthPromptAt = now;
  vscode.window.showWarningMessage(
    t('新版 dsh web 启用了浏览器认证，当前实例不是由本窗口启动，无法静默认证。'),
    t('重启并自动认证（推荐）'),
    t('粘贴认证链接')
  ).then(async (choice) => {
    if (choice === t('重启并自动认证（推荐）')) {
      const ok = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: t('正在重启 dsh web 以完成自动认证…'),
        cancellable: false
      }, async () => {
        const installed = await ensureDshInstalled();
        if (!installed) return false;
        return restartDsh();
      });
      if (ok) {
        lastAuthPromptAt = 0;
        if (isTab && tabReloadFn) tabReloadFn();
        else if (activeView) render(activeView);
      } else {
        vscode.window.showErrorMessage(t('dsh web 重启失败，请手动重启后重试。'));
      }
    } else if (choice === t('粘贴认证链接')) {
      const input = await vscode.window.showInputBox({
        prompt: t('粘贴 dsh web 启动时打印的认证链接（形如 http://127.0.0.1:3080/?token=…，整行粘贴即可）'),
        ignoreFocusOut: true
      });
      if (input && learnDshToken(input)) {
        lastAuthPromptAt = 0;
        await (authProxy && authProxy.waitAuthed(8000));
        if (isTab && tabReloadFn) tabReloadFn();
        else if (activeView) render(activeView);
      }
    }
  });
}

/** Base URL the extension uses to reach dsh /api: via the proxy when ready (auth added automatically). */
async function apiBase() {
  if (isLocalLoopbackTarget()) {
    const proxy = await ensureAuthProxy();
    if (proxy) {
      // The cookie may not have been exchanged yet (dsh just started): wait briefly so the request does not hit the bare address and get a 401.
      await proxy.waitAuthed(5000);
      if (proxy.hasCookieForBase()) {
        return proxy.baseUrl();
      }
    }
  }
  return getUrl().replace(/\/+$/, '');
}

/**
 * Start the dsh web process. On Windows it runs through the shell to hit the dsh.cmd shim.
 * Compatible with old and new versions: --no-open is probed first with `dsh web --help` and omitted when an older version does not support it,
 * so an unknown argument cannot make startup fail.
 * @returns {Promise<import('child_process').ChildProcess>}
 */
async function startDsh() {
  // Use the launch method resolved by ensureDshInstalled (global dsh or npx).
  // Fall back to the configured command so abnormal timing cannot yield an empty value.
  const inv = dshInvocation || { cmd: getDshCommand(), prefix: [] };
  // host/port are both sanitized (getHost allowlist / getPort integer), and cmd goes through sanitizeCommand,
  // which rejects shell metacharacters — the shell:true flagged by Semgrep detect-child-process has no injection
  // surface in this data flow (win32 needs the shell to hit the dsh.cmd shim, POSIX does not go through a shell).
  // Defense in depth (PR #12 approach): cmd comes from getDshCommand() (already sanitized) and is rejected once more here.
  if (typeof inv.cmd !== 'string' || inv.cmd === '' || SHELL_META_PATTERN.test(inv.cmd)) {
    throw new Error(t('dsh 命令包含 shell 元字符或为空，已拒绝启动'));
  }
  const args = [
    ...inv.prefix,
    'web',
    '--host', String(getHost()),
    '--port', String(getPort())
  ];
  // Since dsh 0.1.2-rc, web browser authentication is completed automatically by the extension (managed auth proxy),
  // so the system browser no longer pops up by default; enable dshPanel.openSystemBrowser to keep the old behavior.
  // Older dsh does not recognize --no-open: pass it only when the probe says it is supported, and treat a failed probe as supported (there is still a fallback).
  if (!cfg().get('dshPanel.openSystemBrowser', false) && (dshNoOpenBroken !== true)) {
    if (await dshWebSupportsNoOpen(inv)) {
      args.push('--no-open');
    }
  }
  // Windows launches through cmd.exe: a cmd containing spaces has two forms to distinguish —
  //   a) a single existing executable file (directory with spaces) → quote the whole thing;
  //   b) a multi-token command-line prefix (such as "node C:\x\dsh.js") → pass through as is and let the shell tokenize it (≤0.8.33 behavior).
  const cmdText = (process.platform === 'win32' && /\s/.test(inv.cmd) && fs.existsSync(inv.cmd)) ? '"' + inv.cmd + '"' : inv.cmd;
  const child = spawn(cmdText, args, {
    cwd: getWorkspaceDir(),
    shell: process.platform === 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  managedChild = child;
  attachDshOutputReader(child);

  child.on('error', (err) => {
    if (activeView) {
      activeView.description = t('启动失败');
    }
    vscode.window.showErrorMessage(t('DeepSeek Harness 启动失败: {0}', [err.message]));
  });
  child.on('exit', (code) => {
    if (managedChild === child) {
      managedChild = null;
    }
  });

  return child;
}

/**
 * Probe whether the current dsh's web subcommand supports --no-open (read the `dsh web --help` output).
 * The result is cached per process; treat a failed probe as supported (the dshNoOpenBroken fallback is kept).
 * @param {{cmd: string, prefix: string[]}} inv
 * @returns {Promise<boolean>}
 */
async function dshWebSupportsNoOpen(inv) {
  if (dshNoOpenSupported !== undefined) return dshNoOpenSupported;
  try {
    const out = await runCommandOutput(inv.cmd, [...inv.prefix, 'web', '--help'], 12000);
    dshNoOpenSupported = /--no-open/.test(out);
  } catch {
    dshNoOpenSupported = true;
  }
  if (dshNoOpenSupported === false) {
    dshNoOpenBroken = true; // older dsh: stop trying this flag (the wait logic also skips waiting for an auth link)
  }
  return dshNoOpenSupported;
}

/**
 * Read dsh web's stdout line by line:
 * - Capture the "fully started" signal: any `dsh web: <url>` printed line (new versions include token=,
 *   older versions are a plain URL; both mean dsh itself is ready);
 * - A line with a token goes to learnDshToken (the auth proxy exchanges the cookie from it);
 * - A line without a token means this dsh has no web authentication (older version); record dshAuthCapable=false.
 * stderr is only logged, to help troubleshooting.
 * @param {import('child_process').ChildProcess} child
 */
function attachDshOutputReader(child) {
  let buf = '';
  const onData = (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      const m = line.match(/dsh web:\s*(\S+)/);
      if (m) {
        dshBootAnnouncedAt = Date.now();
        if (extractTokenParam(m[1])) {
          learnDshToken(m[1]);
        } else if (dshAuthCapable !== true) {
          setDshAuthCapable(false); // older dsh: the URL carries no token parameter
        }
      }
      if (line.indexOf('opening the default browser') >= 0) {
        // --no-open had no effect (older version without the argument, etc.): warn once to help pinpoint it.
        console.warn(t('[DeepSeek Harness] dsh 自行打开了系统浏览器（--no-open 未生效）。新版 dsh 由扩展自动抑制弹页；若仍弹页请检查 dshPanel.openSystemBrowser 与 dsh 配置。'));
      }
    }
    if (buf.length > 64 * 1024) buf = '';
  };
  if (child.stdout) child.stdout.on('data', onData);
  if (child.stderr) {
    child.stderr.on('data', (chunk) => {
      const s = chunk.toString('utf8').trimEnd();
      if (s) console.error('[dsh web]', s);
    });
  }
}

/**
 * Kill the process tree. On Windows, when spawn goes through the shell, child.kill() only kills cmd.exe,
 * so taskkill /t is needed to end the real node process along with it.
 */
function killTree(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      stdio: 'ignore',
      windowsHide: true
    });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch (_) {
      child.kill('SIGTERM');
    }
  }
}

/**
 * Make sure DSH is running: detect -> (when not running) start -> poll until ready.
 * Returns whether it became ready successfully.
 * @returns {Promise<boolean>}
 */
async function ensureRunning() {
  const url = getUrl();
  const autoStart = cfg().get('dshPanel.autoStart', true);

  if (await checkUrl(url)) {
    return true; // a service is already running; reuse it as is
  }

  if (!autoStart) {
    return false;
  }

  return startDshAndWaitReady(url);
}

/**
 * Start dsh and wait until ready (about 30 seconds at most).
 * Older dsh may not recognize --no-open (it exits right after starting): automatically drop the argument and retry once.
 * @param {string} url
 * @returns {Promise<boolean>}
 */
async function startDshAndWaitReady(url) {
  // Record the "boot announcement" snapshot taken before the start: dsh prints the
  // `dsh web: <url>` line only when fully ready (plugins/connection loaded) — new versions with token=, older ones a plain URL. A reachable port ≠ ready,
  // and rendering the iframe too early makes the frontend fail to start on a half-ready service (it shows up as the first
  // load after a restart failing, fixed by one refresh).
  const announceBefore = dshBootAnnouncedAt;
  if (!await startDshAndAwaitPort(url)) {
    return false;
  }
  return await waitDshFullBoot(announceBefore);
}

/** Return as soon as the port is reachable (401 counts too); includes one retry without the argument when the probe missed --no-open. */
async function startDshAndAwaitPort(url) {
  startDsh().catch(() => {});
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    if (await checkUrl(url)) {
      return true;
    }
  }
  if (!dshNoOpenBroken && !cfg().get('dshPanel.openSystemBrowser', false)) {
    // Fallback: a wrong probe (e.g. unusual --help output) made the start with the argument fail; drop it and retry once.
    startDsh().catch(() => {});
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      if (await checkUrl(url)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Wait for this launch's dsh to print the boot announcement line (the fully-started signal, common to old and new versions).
 * - A "quiet dsh that never announces" is remembered in globalState (dsh.quietBoot) and skipped from then on;
 * - Fallback for an announcement timeout: let it through if the process is still alive (the proxy self-check is another fallback before rendering), and remember
 *   quietBoot so it is not waited for again.
 * @param {number} announceBefore boot-announcement timestamp snapshot taken before the start
 * @returns {Promise<boolean>}
 */
async function waitDshFullBoot(announceBefore) {
  if (gContext && gContext.globalState.get('dsh.quietBoot') === true) {
    return true;
  }
  const budget = dshAuthCapable === true ? 30000 : 20000;
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    await sleep(250);
    if (managedChild === null) {
      return false; // exited immediately on startup, or was killed
    }
    if (dshBootAnnouncedAt !== announceBefore) {
      // Announcement received; with a token the auth proxy has already begun pre-exchanging the cookie, so wait a moment.
      await sleep(300);
      return true;
    }
  }
  if (managedChild === null) {
    return false;
  }
  // Process alive but no announcement line ever appeared (a very old quiet dsh): remember it and do not wait again.
  if (gContext) {
    gContext.globalState.update('dsh.quietBoot', true).then(() => {}, () => {});
  }
  return true;
}

/**
 * Concurrency de-duplication: make sure the startup flow runs only once however many views resolve at the same time.
 */
function ensureRunningOnce() {
  if (!ensurePromise) {
    ensurePromise = ensureRunning().finally(() => {
      ensurePromise = null;
    });
  }
  return ensurePromise;
}

/**
 * Release the process listening on the given port (best-effort).
 * Used by "Restart": the dsh held by this window is ended by killTree; as a fallback this also clears any
 * dsh not held by this window (externally started / leftover process), so a new process can bind the port. Only called after the user confirms a restart.
 * @param {number} port
 * @returns {Promise<void>}
 */
function freePort(port) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('netstat -ano -p tcp', { windowsHide: true, timeout: 10000 }, (err, stdout) => {
        if (err) { resolve(); return; }
        const pids = new Set();
        for (const line of (stdout || '').split(/\r?\n/)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 5 &&
              parts[0].toUpperCase() === 'TCP' &&
              parts[1] && parts[1].endsWith(`:${port}`) &&
              parts[3] && parts[3].toUpperCase() === 'LISTENING' &&
              parts[4]) {
            pids.add(parts[4]);
          }
        }
        if (pids.size === 0) { resolve(); return; }
        let remaining = pids.size;
        const done = () => { if (--remaining === 0) resolve(); };
        for (const pid of pids) {
          const k = spawn('taskkill', ['/pid', pid, '/t', '/f'], { stdio: 'ignore', windowsHide: true });
          k.on('exit', done);
          k.on('error', done);
        }
      });
    } else {
      // POSIX: prefer `fuser`, fall back to `lsof` + `kill`. The commands themselves are best-effort, so exit codes are ignored.
      exec(`fuser -k ${port}/tcp 2>/dev/null`, { timeout: 10000 }, () => {
        exec(`lsof -ti:${port} 2>/dev/null | xargs -r kill -9 2>/dev/null`, { timeout: 10000 }, () => resolve());
      });
    }
  });
}

/**
 * Restart `dsh web`: stop the current dsh, free the port, start it again, and wait until it is ready.
 * The dsh owned by this window is killed directly with `killTree`; a dsh this window does not own (started externally / left over) is released by `freePort` per port,
 * and callers must obtain user confirmation first, to avoid killing a dsh that other windows are using.
 * @returns {Promise<boolean>} Whether the restart succeeded and became ready.
 */
async function restartDsh() {
  const url = getUrl();
  // 1. End the dsh process tree started by this window.
  if (managedChild) {
    killTree(managedChild);
    managedChild = null;
  }
  // 2. Free the port (fallback for externally started / leftover processes).
  await freePort(getPort());
  // 3. Wait for the port to actually be released (about 5 seconds at most).
  for (let i = 0; i < 10; i++) {
    await sleep(500);
    if (!(await checkUrl(url))) break;
  }
  // 4. Start it again and wait until ready (about 30 seconds at most; includes the `--no-open` compatibility fallback).
  return startDshAndWaitReady(url);
}

/**
 * Compute the font scale for the iframe.
 * The DSH conversation body uses a base font size of 16px, so scale by `editor.fontSize` / 16
 * to make the panel font size follow the editor; the editor font size is safely clamped to 8..72 and the scale to 0.5..2.
 * @returns {number}
 */
function getFontScale() {
  const raw = vscode.workspace.getConfiguration('editor').get('fontSize', 16);
  const fontSize = Number(raw);
  const base = Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 16;
  const clamped = Math.min(72, Math.max(8, base));
  const scale = clamped / 16;
  return Math.min(2, Math.max(0.5, scale));
}

/**
 * Generate a one-shot CSP nonce used to admit the inline zoom listener script.
 * @returns {string}
 */
function makeNonce() {
  return crypto.randomBytes(16).toString('base64');
}

function buildLoadingHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--vscode-editor-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .sub { margin-top: 8px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div style="text-align:center;">
    <div>${t('正在启动 DeepSeek Harness…')}</div>
    <div class="sub">${t('工作区：{0}', [escapeHtml(getWorkspaceDir())])}</div>
  </div>
</body>
</html>`;
}

function buildErrorHtml(reason) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex;
    align-items: center;
    justify-content: center;
    font-family: var(--vscode-editor-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-errorForeground);
    background: var(--vscode-editor-background);
  }
  .box { text-align: center; max-width: 80%; }
  .title { font-weight: 600; }
  .sub { margin-top: 8px; color: var(--vscode-descriptionForeground); word-break: break-all; }
  .hint { margin-top: 12px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="box">
    <div class="title">${t('无法连接 DeepSeek Harness')}</div>
    <div class="sub">${escapeHtml(reason)}</div>
    <div class="hint">${t('请确认 dsh 已安装，或点击面板顶部的“刷新”重试。')}</div>
    <div class="hint">If dsh is not installed yet, see: https://www.runoob.com/deepseek-harness/deepseek-harness-install.html</div>
  </div>
</body>
</html>`;
}

/**
 * Sidebar placeholder page in tab mode: DSH has been taken over by the tab, so the sidebar no longer loads it again,
 * avoiding two webviews loading DSH at the same time, which makes plugin loading mutually exclusive (a limitation of the DSH frontend with two webview instances).
 */
function buildSuspendedHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: flex; align-items: center; justify-content: center;
    font-family: var(--vscode-editor-font-family, -apple-system, 'Segoe UI', sans-serif);
    font-size: var(--vscode-editor-font-size, 13px);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
  }
  .box { text-align: center; max-width: 80%; }
  .title { font-weight: 600; }
  .sub { margin-top: 8px; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
  <div class="box">
    <div class="title">${t('DeepSeek Harness 已在标签页中打开')}</div>
    <div class="sub">${t('关闭标签页后，本侧边栏面板会自动恢复加载。')}</div>
  </div>
</body>
</html>`;
}

function buildIframeHtml(url, scale) {
  // Parse the display URL, allow only http/https, and write its exact origin into `frame-src`,
  // instead of wildcarding the whole local loopback range, keeping the webview sandbox at least privilege.
  // In Remote scenarios `asExternalUri` may return a localhost address with a forwarded port, or an HTTPS forwarding domain,
  // so both are allowed here by their actual origin, and both forms are therefore supported.
  let target;
  try {
    target = new URL(url);
  } catch (e) {
    throw new Error(t('无法解析显示地址：{0}', [url]));
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(t('不允许的显示地址协议：{0}', [target.protocol]));
  }
  const origin = target.origin; // for example http://127.0.0.1:3080 or https://xxxx.example.com
  const nonce = makeNonce();
  const s = Number.isFinite(scale) ? Math.min(2, Math.max(0.5, scale)) : 1;
  // Scale with CSS `zoom` (re-layout, rendering at device resolution, crisp at any font size),
  // not `transform:scale` (scales a rasterized render, blurring the whole page at non-integer scale factors).
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; frame-src ${escapeHtml(origin)}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
</head>
<body style="margin:0;padding:0;width:100vw;height:100vh;overflow:hidden;background:var(--vscode-editor-background);">
<iframe id="dsh-frame" src="${escapeHtml(url)}"
        style="width:100%;height:100%;border:none;display:block;zoom:${s};"
        allow="clipboard-read; clipboard-write; autoplay"></iframe>
<script nonce="${nonce}">
(function () {
  var frame = document.getElementById('dsh-frame');
  var current = ${s};
  var vscode = acquireVsCodeApi();
  function apply(scale) {
    var n = Number(scale);
    if (!isFinite(n)) return;
    n = Math.min(2, Math.max(0.5, n));
    if (n === current) return;
    current = n;
    frame.style.zoom = String(n);
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data) return;
    if (data.type === 'dsh-font-scale' && typeof data.scale === 'number') {
      apply(data.scale);
    } else if (data.type === 'dsh-open-link' && typeof data.url === 'string') {
      // External link clicked inside the DSH page: forward it to the extension host and open it in the system browser.
      var u = data.url;
      // Note: this must be written as \\/\\/ — the template literal collapses \/ into /,
      // writing \/\/ instead turns the injected script into /^https?:///i, a syntax error for the whole inline script,
      // which makes the insert-selection message listener fail to register (Send Selection stops working).
      if (/^https?:\\/\\//i.test(u)) {
        vscode.postMessage({ type: 'dsh-open-link', url: u });
      }
    } else if (data.type === 'insert-selection') {
      // "Selected code" sent by the extension host: forward it to the DSH iframe, and the dsh-drop-caret plugin inserts it into the composer.
      try {
        if (!frame || !frame.contentWindow) {
          vscode.postMessage({ type: 'insert-selection-ack', status: 'no-frame' });
        } else {
          frame.contentWindow.postMessage(data, '*');
          vscode.postMessage({ type: 'insert-selection-ack', status: 'forwarded' });
        }
      } catch (e) {
        try {
          vscode.postMessage({ type: 'insert-selection-ack', status: 'error' });
        } catch (e2) { /* ignore */ }
      }
    }
  });
}());
</script>
</body>
</html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// =====================================================================
// DSH companion plugin auto-install / management
// Architectural reason: the panel embeds the DSH Web GUI in a cross-origin iframe, and the extension (the webview is
// the iframe's parent container) is security-isolated and cannot directly operate the input fields inside the DSH page.
// "Drag files / folders / selected code into the composer" must be received by a plugin inside the DSH page,
// so the extension automatically adds the companion plugin dsh-drop-caret to the DSH web profile,
// and users only need to install this extension, with no manual DSH plugin installation.
// =====================================================================
const DSH_PLUGIN_NAME = 'dsh-drop-caret';
const DSH_PLUGIN_MIN = '0.2.2';
const NPMJS_REGISTRY = 'https://registry.npmjs.org/';
// Bundled compatibility plugin (written directly into the DSH web profile with the extension files, not through npm):
// Fixes ⌘C/⌘V/⌘X not working on macOS when this extension embeds the DSH page in a cross-origin iframe.
const CLIPBOARD_PLUGIN_NAME = 'dsh-webview-clipboard';
const CLIPBOARD_PLUGIN_VERSION = '0.2.1';

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function dshWebProfileDir() {
  return path.join(dshHomeDir(), 'profiles', 'web');
}

/** Simple version comparison: returns >=0 when a >= b, and <0 when a < b. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return 0;
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJsonFile(file, obj) {
  await fs.promises.writeFile(file, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

/**
 * Idempotent: make sure the profile's `package.json` declares this plugin (`dependencies` + `dsh.profile.bundles`).
 * @param {string|null} versionSpec dependency version range; passing `null` means it is not written into `dependencies`
 *   (used for plugins bundled with the extension and written straight to disk — the package is not on the npm registry, so writing it into
 *   `dependencies` would instead make the user's later `pnpm` / `dsh plugin add` resolution fail).
 */
async function ensureProfileDeclaration(profileDir, plugin, versionSpec) {
  const pkgFile = path.join(profileDir, 'package.json');
  const pkg = (await readJsonFile(pkgFile)) || { name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } };
  pkg.dependencies = pkg.dependencies || {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
  let changed = false;
  if (versionSpec !== null && !pkg.dependencies[plugin]) {
    pkg.dependencies[plugin] = versionSpec;
    changed = true;
  }
  if (!pkg.dsh.profile.bundles.includes(plugin)) {
    pkg.dsh.profile.bundles.push(plugin);
    changed = true;
  }
  if (changed) await writeJsonFile(pkgFile, pkg);
}

/** Read the installed plugin version; returns `null` when it is not installed. */
async function installedPluginVersion(profileDir, plugin) {
  const pkg = await readJsonFile(path.join(profileDir, 'node_modules', plugin, 'package.json'));
  return pkg && pkg.version ? pkg.version : null;
}

/** Fetch the plugin with `npm pack` and extract it into the profile's `node_modules` (does not rely on `pnpm`). */
async function installPluginViaNpm(profileDir, plugin) {
  // Security guard: `plugin` may only be a bundled constant (the `npm pack`/`tar` command assembly does no general escaping).
  if (plugin !== DSH_PLUGIN_NAME) {
    throw new Error(t('installPluginViaNpm 仅支持内置插件 ') + DSH_PLUGIN_NAME);
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-'));
  try {
    const packOut = await new Promise((resolve, reject) => {
      exec(
        `npm pack ${plugin} --pack-destination "${tmp}" --registry ${NPMJS_REGISTRY} --json`,
        { timeout: 180000, windowsHide: true },
        (err, stdout) => (err ? reject(new Error((stdout || '').trim() || err.message)) : resolve(stdout))
      );
    });
    const parsed = JSON.parse(packOut);
    const tarball = parsed && parsed[0] && parsed[0].filename ? parsed[0].filename : null;
    if (!tarball) throw new Error(t('npm pack 未能解析 tarball 文件名'));
    const extractDir = path.join(tmp, 'extract');
    await fs.promises.mkdir(extractDir, { recursive: true });
    await new Promise((resolve, reject) => {
      exec(`tar -xzf "${path.join(tmp, tarball)}" -C "${extractDir}"`, { timeout: 60000, windowsHide: true }, (err) => (err ? reject(err) : resolve()));
    });
    const pkgSrc = path.join(extractDir, 'package');
    const dest = path.join(profileDir, 'node_modules', plugin);
    await fs.promises.rm(dest, { recursive: true, force: true });
    await fs.promises.cp(pkgSrc, dest, { recursive: true });
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Try installing with the official `dsh plugin add` (requires `dsh` + `pnpm`); returns `true` on success. */
function tryDshPluginAdd(plugin) {
  // Security guard: `plugin` may only be a bundled constant (on win32 it is assembled through a shell).
  if (plugin !== DSH_PLUGIN_NAME) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const cmd = process.platform === 'win32' ? 'dsh.cmd' : 'dsh';
    const env = Object.assign({}, process.env, {
      // Prepend the npm global bin, so an old `corepack` shim cannot interfere with `pnpm`
      Path: path.join(os.homedir(), 'AppData', 'Roaming', 'npm') + path.delimiter + (process.env.Path || process.env.PATH || ''),
      npm_config_registry: NPMJS_REGISTRY
    });
    const child = spawn(cmd, ['plugin', '--profile', 'web', 'add', plugin], {
      stdio: 'ignore',
      env,
      windowsHide: true,
      shell: process.platform === 'win32'
    });
    let done = false;
    const finish = (ok) => {
      if (!done) {
        done = true;
        resolve(ok);
      }
    };
    child.on('error', () => finish(false));
    child.on('exit', (code) => finish(code === 0));
    setTimeout(() => {
      try { child.kill(); } catch (_) { /* noop */ }
      finish(false);
    }, 180000);
  });
}

/**
 * Generate the full file contents of the bundled compatibility plugin `dsh-webview-clipboard`.
 *
 * Problem (macOS): when the DSH page is embedded in a VS Code webview as a cross-origin iframe,
 * the ⌘C/⌘V/⌘X keys do reach the page, but the browser's native clipboard default action does not
 * happen along this chain, so copy/paste/cut all fail (Windows is fine).
 *
 * Fix: the plugin intercepts these three keys inside the DSH page and, after `preventDefault`, runs
 * `document.execCommand('copy'/'paste'/'cut')` explicitly. The other editing shortcuts
 * (⌘A / undo and redo / caret movement / delete) work natively and are left alone.
 * Enabled only when embedded in Electron on macOS; behavior in other environments is unchanged.
 * @returns {Record<string, string>} relative path → file contents
 */
function clipboardPluginFiles() {
  const pkgJson = JSON.stringify({
    name: CLIPBOARD_PLUGIN_NAME,
    version: CLIPBOARD_PLUGIN_VERSION,
    description: t('DeepSeek Harness 插件：DSH 页面被 VS Code webview（跨源 iframe）内嵌时，修复 macOS 上 ⌘C/⌘V/⌘X 快捷键失效的问题（改用 execCommand 显式执行）。由 Deepseek-Harness-for-VS-Code 扩展内置分发。'),
    keywords: ['deepseek', 'harness', 'dsh', 'cordis', 'plugin', 'clipboard', 'webview', 'vscode'],
    type: 'module',
    main: 'lib/index.js',
    exports: {
      '.': './lib/index.js',
      './client': './lib/client.js',
      './package.json': './package.json'
    },
    files: ['lib', 'cordis.patch.yml'],
    license: 'MIT',
    dsh: {
      client: {
        inject: ['@deepseek-ai/dsh-client-runtime'],
        platform: 'web'
      },
      bundle: {
        patch: './cordis.patch.yml'
      }
    }
  }, null, 2) + '\n';

  const patchYml = [
    '# dsh-webview-clipboard bundle patch: one insert registering the dual-face plugin.',
    "# The row name must match the npm package name and the host half's exported `name`.",
    '- insert:',
    '    - id: webview-clipboard',
    `      name: '${CLIPBOARD_PLUGIN_NAME}'`,
    ''
  ].join('\n');

  const indexJs = `// ${CLIPBOARD_PLUGIN_NAME} host half: no-op.
// This plugin only handles client-side (browser) compatibility: it fixes the failure of
// clipboard editing commands such as copy/paste on macOS when the DSH page is embedded in a VS Code webview. The host half needs no logic at all.
export const name = '${CLIPBOARD_PLUGIN_NAME}'

export const inject = []

export function apply(_ctx) {}
`;

  // Note: this file's contents are embedded in the extension's template literal, so backslashes in regular expressions must be written as `\\\\`,
  // otherwise the template literal collapses `\\/` into `/`, causing a syntax error in the injected script (as happened before with `buildIframeHtml`).
  const clientJs = `// ${CLIPBOARD_PLUGIN_NAME} client bundle (ModuleLoader format)
//
// macOS + VS Code webview: when the DSH page is embedded as a cross-origin iframe, the ⌘C/⌘V/⌘X
// native clipboard default action does not happen, so copy/paste/cut fail (Windows is fine).
// Fix: intercept these three keys and, after preventDefault, run document.execCommand explicitly.
// The other editing shortcuts work natively and are left alone, to avoid conflicting with the editor's own implementation.
// Enabled only when embedded in Electron on macOS; behavior in other environments is unchanged.

window.__ModuleLoader__.load({ id: '${CLIPBOARD_PLUGIN_NAME}', factory: (require) => {
  var module = { exports: {} }
  var exports = module.exports

  var PLUGIN_VERSION = '${CLIPBOARD_PLUGIN_VERSION}'

  function inIframe() {
    try { return window.parent !== window } catch (e) { return false }
  }

  function isMac() {
    var ua = navigator.userAgent || ''
    if (/Macintosh|Mac OS X/i.test(ua)) return true
    if (typeof navigator.platform === 'string' && /Mac/i.test(navigator.platform)) return true
    try {
      if (navigator.userAgentData && navigator.userAgentData.platform === 'macOS') return true
    } catch (e) { /* ignore */ }
    return false
  }

  function inElectron() {
    return /Electron\\//.test(navigator.userAgent || '')
  }

  /** Whether the compatibility layer is enabled. */
  function enabled() {
    return inIframe() && isMac() && inElectron()
  }

  /** Whether the event target is an editable element (paste only makes sense for those). */
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false
    var tag = el.tagName
    if (tag === 'TEXTAREA' || tag === 'INPUT') return true
    return el.isContentEditable === true
  }

  function onKeyDown(e) {
    if (e.defaultPrevented) return                 // the page already handled it; respect that
    if (!enabled()) return
    if (e.isComposing || e.keyCode === 229) return // do not interfere mid-composition (IME)
    var mod = e.metaKey || e.ctrlKey
    if (!mod || e.altKey || e.shiftKey) return     // bare ⌘/Ctrl + letter only
    var lower = String(e.key || '').toLowerCase()
    var cmd = null
    if (lower === 'v') cmd = 'paste'
    else if (lower === 'c') cmd = 'copy'
    else if (lower === 'x') cmd = 'cut'
    if (!cmd) return
    if (cmd === 'paste' && !isEditable(e.target)) return
    e.preventDefault()
    try {
      var ok = document.execCommand(cmd)
      if (!ok) console.warn('[${CLIPBOARD_PLUGIN_NAME}] execCommand("' + cmd + '") returned false')
    } catch (err) {
      console.warn('[${CLIPBOARD_PLUGIN_NAME}] execCommand("' + cmd + '") failed:', err)
    }
  }

  function apply() {
    window.addEventListener('keydown', onKeyDown, false)
    window.__dshWebviewClipboard = {
      version: PLUGIN_VERSION,
      enabled: enabled(),
      mac: isMac(),
      electron: inElectron()
    }
  }

  exports.apply = apply
  exports.inject = []
  return module.exports
} })

`;

  return {
    'package.json': pkgJson,
    'cordis.patch.yml': patchYml,
    'lib/index.js': indexJs,
    'lib/client.js': clientJs
  };
}

/**
 * Ensure the bundled compatibility plugin `dsh-webview-clipboard` is on disk and declared (not through npm).
 * @returns {Promise<boolean>} Whether an install or upgrade happened this time (`true` means `dsh web` must be restarted to take effect).
 */
async function ensureClipboardPlugin(profileDir) {
  try {
    const installed = await installedPluginVersion(profileDir, CLIPBOARD_PLUGIN_NAME);
    if (installed === CLIPBOARD_PLUGIN_VERSION) {
      await ensureProfileDeclaration(profileDir, CLIPBOARD_PLUGIN_NAME, null);
      return false; // versions match; nothing to write
    }
    const files = clipboardPluginFiles();
    const base = path.join(profileDir, 'node_modules', CLIPBOARD_PLUGIN_NAME);
    for (const rel of Object.keys(files)) {
      const dest = path.join(base, rel);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, files[rel], 'utf8');
    }
    // The package is not written into `dependencies` (it is not on the npm registry); only `bundles` is registered so DSH loads it.
    await ensureProfileDeclaration(profileDir, CLIPBOARD_PLUGIN_NAME, null);
    return true;
  } catch (e) {
    console.error(t('[DeepSeek Harness] 安装内置插件 {0} 失败：', [CLIPBOARD_PLUGIN_NAME]), e);
    vscode.window.showWarningMessage(t('安装 DSH 剪贴板兼容插件 {0} 失败：{1}', [CLIPBOARD_PLUGIN_NAME, e.message]));
    return false;
  }
}

/**
 * Ensure the `dsh-drop-caret` plugin is installed and declared in the DSH web profile.
 * @returns {Promise<boolean>} Whether an install or upgrade happened this time (`true` usually means `dsh web` must be restarted to take effect).
 */
async function ensureDshPlugins() {
  const profileDir = dshWebProfileDir();
  try {
    const installed = await installedPluginVersion(profileDir, DSH_PLUGIN_NAME);
    await ensureProfileDeclaration(profileDir, DSH_PLUGIN_NAME, `^${DSH_PLUGIN_MIN}`);
    let changed = false;
    if (installed && compareVersions(installed, DSH_PLUGIN_MIN) >= 0) {
      // `dsh-drop-caret` is already satisfied; no install needed
    } else {
      // Not installed, or the version is too low: try the official `dsh plugin add` first, and fall back to `npm pack` on failure.
      const viaCli = await tryDshPluginAdd(DSH_PLUGIN_NAME);
      if (!viaCli) {
        await installPluginViaNpm(profileDir, DSH_PLUGIN_NAME);
      }
      await ensureProfileDeclaration(profileDir, DSH_PLUGIN_NAME, `^${DSH_PLUGIN_MIN}`);
      changed = true;
    }
    // Bundled clipboard compatibility plugin (files are written directly with the extension, not through npm).
    // Active only in the macOS VS Code webview embedding scenario (decided locally by the DSH page),
    // inert files on Windows/Linux; can be disabled via `dshPanel.installClipboardPlugin`.
    if (cfg().get('dshPanel.installClipboardPlugin', true)) {
      if (await ensureClipboardPlugin(profileDir)) {
        changed = true;
      }
    }
    return changed;
  } catch (e) {
    console.error(t('[DeepSeek Harness] 自动安装 {0} 失败：', [DSH_PLUGIN_NAME]), e);
    vscode.window.showWarningMessage(t('自动安装 DSH 插件 {0} 失败：{1}', [DSH_PLUGIN_NAME, e.message]));
    return false;
  }
}

/**
 * Handle webview messages: open external links clicked inside the DSH page in the system browser, and show the Send Selection acknowledgement.
 * Shared by the sidebar panel and the editor tab.
 * @param {any} msg
 */
function handleWebviewMessage(msg) {
  if (msg && msg.type === 'dsh-open-link' && typeof msg.url === 'string') {
    const u = msg.url;
    if (/^https?:\/\//i.test(u)) {
      vscode.env.openExternal(vscode.Uri.parse(u));
    }
  } else if (msg && msg.type === 'insert-selection-ack') {
    if (msg.status === 'forwarded') {
      vscode.window.showInformationMessage(t('已转发到 DSH 对话框'));
    } else if (msg.status === 'no-frame') {
      vscode.window.showErrorMessage(t('转发失败：面板未加载 DSH iframe，请点「刷新」后重试'));
    } else {
      vscode.window.showErrorMessage(t('转发失败：未知错误'));
    }
  }
}

/**
 * Tab-only display URL: in local scenarios, swap `host` between 127.0.0.1 and localhost,
 * creating an origin different from the sidebar, so two webviews on the same origin do not become mutually exclusive when loading the DSH frontend plugins.
 * Swap only when `host` is 127.0.0.1 or localhost; other addresses (such as a remotely forwarded domain) are returned as-is.
 * @param {string} displayUrl
 * @returns {string}
 */
function getTabDisplayUrl(displayUrl) {
  try {
    const u = new URL(displayUrl);
    if (u.hostname === '127.0.0.1') {
      u.hostname = 'localhost';
      return u.toString();
    }
    if (u.hostname === 'localhost') {
      u.hostname = '127.0.0.1';
      return u.toString();
    }
    return displayUrl;
  } catch {
    return displayUrl;
  }
}

/**
 * Prepare the panel content HTML: make sure `dsh` is installed, the companion plugins are in place, and the service is ready,
 * returning the iframe HTML or an error. Shared by the sidebar view and the editor tab.
 * @param {boolean} [isTab] Whether this is tab mode (tabs use a different origin to stay isolated from the sidebar).
 * @returns {Promise<{ok: true, html: string} | {ok: false, kind: 'not-installed'|'unreachable'|'unloadable'|'unauthorized', reason: string}>}
 */
async function preparePanelHtml(isTab) {
  // Make sure `dsh` is installed first (in remote scenarios, check/install on the server).
  const installed = await ensureDshInstalled();
  if (!installed) {
    return {
      ok: false,
      kind: 'not-installed',
      reason: t('未检测到 DeepSeek Harness (dsh)，且已取消安装。请手动安装后点击“刷新”。')
    };
  }

  // Auto-ensure the DSH-side companion plugin `dsh-drop-caret` is in place (drag files/code snippets into the composer).
  const pluginInstalled = await ensureDshPlugins();
  if (pluginInstalled && (await checkUrl(getUrl()))) {
    // The service is already running but the plugin was just installed; it only loads after `dsh web` restarts.
    vscode.window.showInformationMessage(t('已自动安装/更新 DSH 插件（dsh-drop-caret / dsh-webview-clipboard），请点击面板顶部的「重启 dsh web」使其生效。'));
  }

  const ok = await ensureRunningOnce();
  if (!ok) {
    return {
      ok: false,
      kind: 'unreachable',
      reason: t('无法连接 {0}，且自动启动未成功（或已关闭自动启动）。', [getUrl()])
    };
  }

  // Once the service is ready, best-effort register the current VS Code workspace in the DSH workspace list (does not block rendering).
  registerWorkspace().catch(() => {});
  // Resolve the final display URL: local scenarios go through the managed auth proxy (seamlessly passing `dsh web` browser authentication);
  // Remote / non-loopback / old `dsh` (no authentication) keeps the original direct display URL (remote scenarios go through port forwarding).
  const target = await resolvePanelTarget(isTab);
  if (target.unauthorized) {
    maybeGuideAuth(isTab);
    return {
      ok: false,
      kind: 'unauthorized',
      reason: t('dsh web 新版启用了浏览器认证，当前实例不是由本窗口启动，无法静默认证。点击面板顶部的「重启 dsh web」，由扩展接管并自动完成认证。')
    };
  }
  try {
    return { ok: true, html: buildIframeHtml(target.displayUrl, getFontScale()) };
  } catch (e) {
    // When the display URL cannot be parsed or its protocol is not http/https, refuse to load the iframe and show an error page.
    return { ok: false, kind: 'unloadable', reason: e.message };
  }
}

async function render(view) {
  // When a tab has taken over DSH, the sidebar does not load it again (the two webviews' plugin loading would otherwise be mutually exclusive) and shows a placeholder.
  if (activeTab) {
    view.description = t('在标签页中打开');
    view.webview.html = buildSuspendedHtml();
    return;
  }
  view.description = getUrl();
  view.webview.html = buildLoadingHtml();
  const r = await preparePanelHtml(false);
  // The view may have been closed during the `await`; continue rendering only when it is still the active view.
  if (activeView !== view) return;
  if (!r.ok) {
    view.description = r.kind === 'not-installed' ? t('未安装 dsh') : (r.kind === 'unloadable' ? t('无法加载') : t('未连接'));
    view.webview.html = buildErrorHtml(r.reason);
    return;
  }
  view.description = getUrl();
  view.webview.html = r.html;
}

// Since `dsh` 0.1.2-rc, the `/api` RPC endpoints changed from the "dotted" to the "namespace/method" slash convention
// (for example `workspace.create` → `workspace/create`). The old/new name mapping is maintained here:
// request the new endpoint first, and automatically fall back to the old dotted endpoint on a 404 (older `dsh` has no such route).
const DSH_RPC_ENDPOINT_RENAME = {
  'workspace.create': 'workspace/create',
  'session.create': 'session/create',
  'session.prompt': 'session/prompt',
  'session.selectModel': 'session/selectModel',
  'session.page': 'session/page'
};

/** Whether the response is a "route does not exist" (used to decide the new/old endpoint fallback). */
function isRpcRouteMissing(resp) {
  return !!resp && (resp.__httpStatus === 404 || resp.raw === 'not found');
}

/**
 * Run a DSH RPC (the `client-request` envelope); on success return `result.value`, on failure throw.
 * Compatible with two generations of `dsh`:
 * - New (0.1.2-rc.x): slash endpoint (such as `workspace/create`), where `payload` must be
 *   a named-argument wrapper with "exactly one plain object field", `{ args: { request: <actual payload> } }`;
 * - Old versions: dotted endpoint (`workspace.create`), where `payload` is the actual payload itself.
 * Request in the new format first, and automatically fall back to the old format when the route does not exist (404).
 * @param {string} base
 * @param {string} method
 * @param {object} payload
 * @param {number} timeoutMs
 * @returns {Promise<any>}
 */
async function dshRpc(base, method, payload, timeoutMs) {
  const renamed = DSH_RPC_ENDPOINT_RENAME[method];
  const rpcId = 'dsh-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
  const attempts = [];
  if (renamed) {
    attempts.push({
      path: '/api/' + renamed,
      body: {
        type: 'client-request',
        rpcId,
        method: renamed,
        payload: { args: { request: payload } }
      }
    });
  }
  attempts.push({
    path: '/api/' + method,
    body: { type: 'client-request', rpcId, method, payload }
  });

  let resp = null;
  for (const attempt of attempts) {
    resp = await httpPostJson(base + attempt.path, attempt.body, timeoutMs || 15000);
    if (!isRpcRouteMissing(resp)) break;
  }
  const result = resp && resp.result;
  if (result && result.ok) {
    return result.value;
  }
  const err = result && result.error;
  const msg = (err && (err.message || err.code)) || (t('DSH RPC 失败: ') + method);
  throw new Error(msg);
}

/**
 * Fetch DSH session history (for streaming replay polling).
 * In new `dsh` (0.1.2-rc.x) the endpoint was renamed to `session/page`, and the arguments became
 * `{ address: {kind:'session', sessionId}, throughSeq, maxMessages }`, where
 * `throughSeq` cannot exceed the session's current cursor (when it does, the gateway reports "past cursor N" and returns N along with it).
 * Here the cursor is probed with a deliberately out-of-range `throughSeq`, then the trailing page is fetched by cursor and
 * normalized to the old `{ events: [...] }` shape; old `dsh` versions fall back to `session.history` (`{sessionId}`).
 * @param {string} base
 * @param {string} sid DSH session id
 * @returns {Promise<{events: any[]}>}
 */
async function fetchSessionHistory(base, sid) {
  const pagePayload = (seq, maxMessages) => ({
    address: { kind: 'session', sessionId: sid },
    throughSeq: seq,
    maxMessages
  });
  try {
    // 1) Cursor probe: an empty session returns "past cursor -1"; for a non-empty session `throughSeq=0` is always valid,
    //    but to get the "latest cursor", parsing the cursor value straight out of the probe error here saves one round trip—
    //    so a value that is guaranteed to be out of range is tried first, and the current cursor is parsed from the error.
    let cursor = -1;
    try {
      await dshRpc(base, 'session.page', pagePayload(Number.MAX_SAFE_INTEGER, 1), 15000);
      // Theoretically unreachable (`MAX_SAFE_INTEGER` is always out of range); if it is reached, there is no cursor validation, so fetch with 0 directly.
      cursor = 0;
    } catch (e) {
      const m = /past cursor (-?\d+)/.exec(String((e && e.message) || ''));
      if (!m) throw e;
      cursor = parseInt(m[1], 10);
      if (!Number.isFinite(cursor)) cursor = -1;
    }
    if (cursor < 0) {
      return { events: [] }; // empty session
    }
    // 2) Fetch the trailing page by cursor (walk back `maxMessages` events from the newest).
    const page = await dshRpc(base, 'session.page', pagePayload(cursor, 4000), 15000);
    const records = Array.isArray(page && page.records) ? page.records : [];
    return { events: records.map((x) => (x && x.event) ? x.event : x) };
  } catch (_) {
    // Old `dsh`: old endpoint + old arguments.
    const hist = await dshRpc(base, 'session.history', { sessionId: sid }, 15000);
    return hist;
  }
}


// =====================================================================
// Direct disk read: parse VS Code's private `chatSessions/*.jsonl` session files
// Upside: does not touch any model configuration (no proxy dependency), and uninstalling the extension leaves zero residue
// =====================================================================

/**
 * Parse one session `.jsonl` file, replaying `kind:0`/`kind:2` patches.
 * Turn shape: `{ ts, agent, model, user, assistant }`
 * @param {string} filePath
 * @returns {{ sessionId: string|null, turns: any[] }}
 */
function parseChatSessionText(text) {
  const turns = [];
  let sessionId = null;
  try {
    const lines = String(text || '').split(/\r?\n/).filter(Boolean);
    let state = null;
    const seen = new Set();
    for (const line of lines) {
      let j;
      try { j = JSON.parse(line); } catch (_) { continue; }
      if (j && j.kind === 0 && j.v) {
        state = j.v;
        sessionId = (j.v && typeof j.v.sessionId === 'string') ? j.v.sessionId : null;
      }
      if (!state) continue;
      if (!Array.isArray(state.requests)) state.requests = [];
      if (j && j.kind === 2 && Array.isArray(j.k) && j.k[0] === 'requests') {
        if (j.k.length === 1 && Array.isArray(j.v)) {
          // `k:["requests"]` → append new requests
          for (const r of j.v) {
            if (r && r.requestId) state.requests.push(r);
          }
        } else if (j.k.length === 3 && typeof j.k[1] === 'number' && j.k[2] === 'response' && Array.isArray(j.v)) {
          // `k:["requests",i,"response"]` → attach the answer to request i
          const idx = j.k[1];
          if (state.requests[idx]) state.requests[idx].response = j.v;
        }
      }
    }
    for (const req of state.requests || []) {
      if (!req || !req.requestId || seen.has(req.requestId)) continue;
      seen.add(req.requestId);
      const user = (req.message && (typeof req.message.text === 'string'
        ? req.message.text
        : (Array.isArray(req.message.parts)
          ? req.message.parts.map((pp) => (pp && typeof pp.text === 'string' ? pp.text : '')).join('\n')
          : ''))) || '';
      const assistant = ((req.response || [])
        .map((p) => (p && typeof p.value === 'string' ? p.value : ''))
        .filter(Boolean))
        .join('\n');
      turns.push({
        ts: typeof req.timestamp === 'number' ? req.timestamp : 0,
        agent: (req.agent && req.agent.id) || '',
        model: req.modelId || '',
        user,
        assistant
      });
    }
  } catch (e) {
    console.warn(t('[DeepSeek Harness] 解析会话文本失败：'), e && e.message);
  }
  return { sessionId, turns };
}

/**
 * Parse one session `.jsonl` file synchronously (disk read + parse).
 * @param {string} filePath
 * @returns {{sessionId: string|null, turns: any[]}}
 */
function parseChatSessionFile(filePath) {
  try {
    return parseChatSessionText(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(t('[DeepSeek Harness] 解析会话文件失败：'), filePath, e && e.message);
    return { sessionId: null, turns: [] };
  }
}

/**
 * Async + cached session-file read (cache hit within 10 seconds while `mtime`+`size` are unchanged):
 * avoids repeating a full disk read/parse for every request during concurrent chats, reducing extension-host blocking.
 * @param {string} file
 * @returns {Promise<{sessionId: string|null, turns: any[]}|null>}
 */
const chatFileReadCache = new Map();
async function readChatSessionCached(file) {
  let st;
  try { st = fs.statSync(file); } catch (_) { return null; }
  const hit = chatFileReadCache.get(file);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size && (Date.now() - hit.ts) < 10000) {
    return hit.value;
  }
  let text;
  try { text = await fs.promises.readFile(file, 'utf8'); } catch (_) { return null; }
  const value = parseChatSessionText(text);
  chatFileReadCache.set(file, { ts: Date.now(), mtimeMs: st.mtimeMs, size: st.size, value });
  if (chatFileReadCache.size > 40) {
    const oldest = chatFileReadCache.keys().next().value;
    if (oldest) chatFileReadCache.delete(oldest);
  }
  return value;
}

/**
 * Enumerate VS Code user data directories (cross-platform + remote):
 * - Windows: %APPDATA%\Code\User
 * - macOS: ~/Library/Application Support/Code/User
 * - Linux desktop: ~/.config/Code/User
 * - vscode-server (Remote-SSH / WSL / container): ~/.vscode-server/data/User
 * - Legacy vscode-remote: ~/.vscode-remote/data/User
 * Every candidate is tried; non-existent ones are skipped automatically (existence is checked by the caller).
 * @returns {string[]}
 */
function chatUserDataDirs() {
  const home = os.homedir();
  const dirs = [];
  if (process.platform === 'win32') dirs.push(path.join(home, 'AppData', 'Roaming', 'Code', 'User'));
  if (process.platform === 'darwin') dirs.push(path.join(home, 'Library', 'Application Support', 'Code', 'User'));
  dirs.push(path.join(home, '.config', 'Code', 'User'));
  dirs.push(path.join(home, '.vscode-server', 'data', 'User'));
  dirs.push(path.join(home, '.vscode-remote', 'data', 'User'));
  const seen = new Set();
  return dirs.filter((d) => { if (seen.has(d)) return false; seen.add(d); return true; });
}

/**
 * Extract the local path from the `folder` field of `workspace.json` (both `file:///` and `vscode-remote://` are supported),
 * used to decide whether a given `workspaceStorage` hash directory belongs to the current workspace.
 * @param {string} folderUri
 * @returns {string|null}
 */
function folderPathFromWorkspaceJson(folderUri) {
  if (!folderUri || typeof folderUri !== 'string') return null;
  try {
    const u = new URL(folderUri);
    let p = decodeURIComponent(u.pathname || '');
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return path.normalize(p);
  } catch (_) {
    return null;
  }
}

/**
 * Enumerate recently modified session files (workspace windows + empty windows), with the current workspace first and other workspaces as fallback.
 * @param {number} [lookbackMinOverride]
 * @returns {{file: string, mtimeMs: number}[]} Sorted by (current workspace first →) modification time descending.
 */
function listChatSessionFiles(lookbackMinOverride) {
  const out = [];
  const now = Date.now();
  const lookbackMs = ((lookbackMinOverride != null ? lookbackMinOverride : (Number(cfg().get('dshPanel.chatSyncLookbackMin', 60)) || 60))) * 60 * 1000;
  const localDir = getWorkspaceDir();
  const normLocal = (() => {
    try {
      const n = path.normalize(String(localDir || ''));
      return process.platform === 'win32' ? n.toLowerCase() : n;
    } catch (_) { return String(localDir || ''); }
  })();
  const roots = []; // { dir, pri } where pri=1 is the current workspace and 0 is any other
  for (const u of chatUserDataDirs()) {
    const ws = path.join(u, 'workspaceStorage');
    try {
      for (const d of fs.readdirSync(ws)) {
        let pri = 0;
        try {
          const wj = JSON.parse(fs.readFileSync(path.join(ws, d, 'workspace.json'), 'utf8'));
          const folder = (wj && (wj.folder || (wj.workspace && typeof wj.workspace === 'string' ? wj.workspace : null))) || null;
          const fp = folderPathFromWorkspaceJson(folder);
          if (fp) {
            const n = process.platform === 'win32' ? fp.toLowerCase() : fp;
            if (n === normLocal || n.startsWith(normLocal + path.sep) || normLocal.startsWith(n + path.sep)) pri = 1;
          }
        } catch (_) { /* a missing or malformed workspace.json means: treat as another workspace */ }
        const p = path.join(ws, d, 'chatSessions');
        if (fs.existsSync(p)) roots.push({ dir: p, pri });
      }
    } catch (_) { /* skip when it does not exist */ }
    const empty = path.join(u, 'globalStorage', 'emptyWindowChatSessions');
    if (fs.existsSync(empty)) roots.push({ dir: empty, pri: 1 });
  }
  for (const r of roots) {
    let files = [];
    try { files = fs.readdirSync(r.dir).filter((f) => f.endsWith('.jsonl')); } catch (_) { continue; }
    for (const f of files) {
      const fp = path.join(r.dir, f);
      let st;
      try { st = fs.statSync(fp); } catch (_) { continue; }
      if (now - st.mtimeMs < lookbackMs) out.push({ file: fp, mtimeMs: st.mtimeMs, pri: r.pri });
    }
  }
  out.sort((a, b) => (b.pri - a.pri) || (b.mtimeMs - a.mtimeMs));
  return out;
}

// =====================================================================
// DSH language model provider (v0.7.0): registers DSH as a VS Code chat model,
// "DSH (DeepSeek Harness)" appears in the model picker—select it and VS Code hands
// the fully assembled conversation straight to the extension (including the compact that VS Code handles),
// which filters out the noise, forwards it to DSH for execution, and streams the result back. Uninstalling the extension leaves zero residue.
// =====================================================================

const DSH_MODEL_MAP_KEY = 'dsh.modelSessions';

/**
 * Extract the first/last/second-to-last real user prompt in the message list.
 * Note: memory-block messages (starting with 【Copilot 记忆】) are not prompts and are skipped.
 */
function firstLmQuestionText(messages) {
  for (const m of messages || []) {
    const role = m && m.role;
    if (role !== 1 && role !== 'user' && role !== 'User') continue;
    const full = lmMessageText(m);
    if (full.startsWith(t('用户：'))) return stripAttachSuffix(full.slice(3));
  }
  return '';
}

function lastLmUserText(messages) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m && m.role;
    if (role !== 1 && role !== 'user' && role !== 'User') continue;
    const full = lmMessageText(m);
    if (full.startsWith(t('用户：'))) return stripAttachSuffix(full.slice(3));
  }
  return '';
}

function prevLmUserText(messages) {
  let seen = 0;
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m && m.role;
    if (role !== 1 && role !== 'user' && role !== 'User') continue;
    const full = lmMessageText(m);
    if (!full.startsWith(t('用户：'))) continue;
    const body = stripAttachSuffix(full.slice(3));
    if (!body) continue;
    seen++;
    if (seen === 2) return body;
  }
  return '';
}

function findLmUserIndex(messages, lastUserText) {
  if (!lastUserText) return -1;
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const m = messages[i];
    const role = m && m.role;
    if (role !== 1 && role !== 'user' && role !== 'User') continue;
    const full = lmMessageText(m);
    if (full.startsWith(t('用户：')) && stripAttachSuffix(full.slice(3)) === lastUserText) return i;
  }
  return -1;
}

/**
 * Normalize the raw user prompt recorded in the chat file (strip the `<prompt>`/`<userRequest>`/instructions wrapper),
 * aligned with the cleanup rules `lmMessageText` uses on VS Code messages.
 * @param {string} u
 * @returns {string}
 */
function normalizeFileUserText(u) {
  const raw = String(u || '').trim();
  if (!raw) return '';
  const inner = extractUserRequest(raw);
  if (inner !== null) return stripAttachSuffix(inner);
  const cleaned = stripCopilotContext(raw);
  if (!cleaned) return '';
  const inner2 = extractUserRequest(cleaned);
  if (inner2 !== null) return stripAttachSuffix(inner2);
  return stripAttachSuffix(cleaned);
}

/**
 * Locate the `sessionId` of the current Copilot chat (the chat file name).
 * Main path (zero race): the current request takes a few seconds to be persisted to disk, but the previous turn's prompt was persisted long ago—
 * claim the chat file when the file's last prompt (normalized) == the previous prompt in the current transcript (`prevPrompt`);
 * with multiple candidates (several chats open at once, mirrored chats), take the one with the largest last-prompt timestamp = the most recently active chat.
 * Fallback: on the first turn (no `prevPrompt`), or when the history has been edited, poll until the current request is persisted to disk (exact text match + fresh `ts`).
 * @param {string} currentPrompt
 * @param {any[]} messages
 * @returns {Promise<string|null>}
 */
async function locateModelChatSessionId(currentPrompt, messages) {
  const q = String(currentPrompt || '').trim();
  const prevPrompt = prevLmUserText(messages);
  if (!q && !prevPrompt) return null;
  const FRESH_TURN_MS = 3 * 60 * 1000;
  const FRESH_EMPTY_MS = 60 * 1000;
  // Single scan: wide lookback (24h) + the 12 most recent files (current workspace first + mtime descending).
  // - `hitPrev`: the file's last prompt (normalized) == the previous turn's prompt (no `ts` gating, compatible with resuming old chats);
  // - `hitCur`: the file's last prompt == the current prompt and `ts` is fresh (fast path when the request is already persisted to disk);
  // - Empty chat file (only `kind:0` metadata, no requests at all): a newly created chat is in this state during its first prompt
  //   (measured: the request is written to the file only after the answer completes), so record the newest one within the last 60 seconds as the first-turn candidate.
  const scanOnce = async () => {
    const now = Date.now();
    let bestId = null;
    let bestTs = 0;
    let newestEmptyId = null;
    let newestEmptyMtime = 0;
    try {
      const files = listChatSessionFiles(60 * 24).slice(0, 12);
      for (const f of files) {
        const p = await readChatSessionCached(f.file);
        if (!p || !p.sessionId) continue;
        if (!Array.isArray(p.turns) || !p.turns.length) {
          if ((now - f.mtimeMs) < FRESH_EMPTY_MS && f.mtimeMs > newestEmptyMtime) {
            newestEmptyMtime = f.mtimeMs;
            newestEmptyId = p.sessionId;
          }
          continue;
        }
        const last = p.turns[p.turns.length - 1];
        if (!last || !last.user) continue;
        const nu = normalizeFileUserText(last.user);
        const lastTs = (typeof last.ts === 'number' && last.ts > 0) ? last.ts : 0;
        const hitPrev = prevPrompt ? (nu === prevPrompt) : false;
        const hitCur = q ? (nu === q && (now - lastTs) < FRESH_TURN_MS) : false;
        if ((hitPrev || hitCur) && lastTs > bestTs) {
          bestTs = lastTs;
          bestId = p.sessionId;
        }
      }
    } catch (_) { /* fall back to the hash key when location fails */ }
    return { bestId, newestEmptyId };
  };
  if (prevPrompt) {
    // Not the first turn: the previous turn must already be persisted to disk, so one shot usually hits; still retry lightly twice to cover resuming a chat idle for a long time
    // (the current request hits via `hitCur` as soon as it is persisted to disk).
    for (let i = 0; i < 3; i++) {
      if (i > 0) await sleep(i === 1 ? 600 : 1500);
      const { bestId } = await scanOnce();
      if (bestId) return bestId;
    }
    return null;
  }
  // First turn: do not poll waiting for the disk write (measured: the request is written to the file only after the answer completes, so waiting only wastes about 8 seconds
  // and slows down the first prompt of a new chat, giving concurrent chats a "serial" feel). Try the `hitCur` fast path first,
  // then take "the empty chat file created within the last 60 seconds" = the current new chat (zero wait).
  const { bestId, newestEmptyId } = await scanOnce();
  return bestId || newestEmptyId || null;
}

/**
 * Build a text response part (prefer the official class, falling back to a plain object on older versions).
 * @param {string} text
 * @returns {any}
 */
function makeTextPart(text) {
  try {
    if (vscode.LanguageModelTextPart) {
      return new vscode.LanguageModelTextPart(String(text));
    }
  } catch (_) { /* fall back */ }
  return { type: 'text', value: String(text) };
}

/**
 * One message → plain conversation text (filter out harness noise such as system prompts/tools/environment).
 * @param {any} m
 * @returns {string}
 */
/**
 * Extract the body of the Copilot memory injection blocks (`userMemory`/`sessionMemory`/`repoMemory`)—
 * these are valid memories unique to the Copilot side; only the XML wrapper and the "empty" hints are removed, and the rest is kept as plain text.
 * @param {string} t
 * @returns {string}
 */
function extractMemoryBlocks(t) {
  const re = /<(userMemory|sessionMemory|repoMemory)>\s*([\s\S]*?)\s*<\/\1>/g;
  const parts = [];
  let m;
  while ((m = re.exec(t))) {
    let inner = m[2].trim();
    // Drop Copilot's explanatory preamble (such as "The following are your persistent user memory notes..."),
    // keeping only the actual memory body (starting from the first markdown heading)
    const lines = inner.split('\n');
    const headIdx = lines.findIndex((l) => /^\s*#{1,6}\s/.test(l));
    if (headIdx > 0) inner = lines.slice(headIdx).join('\n').trim();
    if (!inner) continue;
    if (/is empty\.|no [^.]+ notes have been created/i.test(inner)) continue; // skip the "empty" notices
    parts.push(inner);
  }
  return parts.join('\n\n');
}

/**
 * Strip the junk block prefixes injected by VS Code (`context`/`reminderInstructions`/`environment`, etc.),
 * keeping the real content after them (the user prompt may be mixed into the tail of the same message).
 * @param {string} t
 * @returns {string}
 */
function stripJunkPrefix(t) {
  const markers = ['</reminderInstructions>', '</editorContext>', '</context>', '</environment_info>', '</workspace_info>', '</instructions>', '</skills>', '</agents>', '</user_info>', '</userMemory>', '</sessionMemory>', '</repoMemory>'];
  let idx = -1;
  for (const marker of markers) {
    const i = t.lastIndexOf(marker);
    if (i >= 0 && i + marker.length > idx) idx = i + marker.length;
  }
  if (idx > 0) {
    const rest = t.slice(idx).trim();
    // The trailing note is itself VS Code metadata (e.g. "This is the state of the context...") → discard
    if (/^This is the state of the context/i.test(rest)) return '';
    if (rest) return rest;
  }
  return '';
}

/**
 * Parse one "attachment message" (VS Code delivers a file dragged into the chat box as a separate user message,
 * the whole message has the form <attachment id="...">…file contents…</attachment>) and extract the file path.
 * Path sources (in priority order):
 *  1) A filepath comment in the body (three variants observed in practice: `<!-- filepath: p -->` / `// filepath: p` / `# filepath: p`);
 *  2) The `filePath`/`path`/`uri` attributes on the opening tag (`file://` URIs are normalized to a local path);
 *  3) The `id` attribute ("file:NAME" or "NAME", a bare file name only — joined onto the current workspace path, passed through as-is if not found).
 * Note: a paired regex over "<attachment …>…</attachment>" must not be used to strip: the file contents may contain
 * literal <attachment> text (such as this extension's own source dragged in), and the pairing would be broken by the literal inside the content.
 * @param {string} t The whole message text
 * @returns {string[]}
 */
function stripAndExtractAttachments(t) {
  const s = String(t || '');
  const paths = [];
  const push = (p) => { if (p && !paths.includes(p)) paths.push(p); };
  // Path extraction: prefer the `filePath` attribute on the opening tag (the main format observed in practice: <attachment id=... filePath="...">),
  // then a filepath comment in the body (`<!-- -->` / `//` / `#` variants), and finally the `id` attribute as a fallback (joined with the workspace).
  const attrRe = /<attachment\b[^>]*\bfilePath\s*=\s*"([^"]+)"/gi;
  let m;
  while ((m = attrRe.exec(s))) push(m[1].trim());
  if (!paths.length) {
    const attrRe2 = /<attachment\b[^>]*\b(?:path|uri)\s*=\s*"([^"]+)"/gi;
    while ((m = attrRe2.exec(s))) {
      let p = m[1].trim();
      if (/^file:\/\//i.test(p)) {
        try { p = decodeURIComponent(new URL(p).pathname); } catch (_) { /* leave it as is */ }
        if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(p)) p = p.slice(1);
      }
      push(p);
    }
  }
  if (!paths.length) {
    const cm = s.match(/<!--\s*filepath:\s*([^>\r\n]+?)\s*-->/i)
      || s.match(/(?:^|\n)\s*(?:\/\/|#)\s*filepath:\s*(.+?)(?:\r?\n|$)/i);
    if (cm) push(cm[1].trim());
  }
  if (!paths.length) {
    const im = s.match(/<attachment\b[^>]*\bid\s*=\s*"([^"]+)"/i);
    if (im) {
      let name = im[1].trim().replace(/^file:/i, '').replace(/^active editor:/i, '').trim();
      if (name && !/^[A-Za-z]:[\\/]/.test(name) && !/^[\\/]/.test(name)) {
        const ws = getWorkspaceDir();
        if (ws) name = path.join(ws, name);
      }
      push(name);
    }
  }
  // Container stripping: prefer <attachments>…</attachments> (the plural wrapper is VS Code-only,
  // </attachments> is almost impossible inside file contents, so taking the last one is safe);
  // fall back to <attachment>…</attachment> (from the first opening tag to the last closing tag; literal
  // <attachment> text in the content sits in the middle and does not affect locating the ends).
  let cleaned = s;
  const a1 = s.search(/<attachments\b/i);
  const z1 = s.lastIndexOf('</attachments>');
  if (a1 >= 0 && z1 > a1) {
    cleaned = s.slice(0, a1) + s.slice(z1 + '</attachments>'.length);
  } else {
    const a2 = s.search(/<attachment\b/i);
    const z2 = s.lastIndexOf('</attachment>');
    if (a2 >= 0 && z2 > a2) {
      cleaned = s.slice(0, a2) + s.slice(z2 + '</attachment>'.length);
    }
  }
  return { cleaned: cleaned.trim(), paths };
}

/**
 * Identity key cleanup: strip the trailing 【文件引用】 section from "用户：prompt",
 * so identity checks such as `lastLmUserText`/`prevLmUserText`/`findLmUserIndex` compare only the real prompt text.
 * @param {string} t
 * @returns {string}
 */
function stripAttachSuffix(text) {
  const idx = String(text || '').indexOf(t('\n\n【文件引用】'));
  return idx >= 0 ? text.slice(0, idx).trim() : text;
}

function lmMessageText(m) {
  const role = m && m.role;
  const isUser = role === 'user' || role === 1 || role === 'User';
  const isAssistant = role === 'assistant' || role === 2 || role === 'Assistant';
  if (!isUser && !isAssistant) return ''; // system (role=3), tool and the like are ignored entirely (DSH has its own harness)
  let text = '';
  if (typeof m.content === 'string') {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    text = m.content
      .map((p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (typeof p.value === 'string') return p.value;
        if (typeof p.content === 'string') return p.content;
        if (typeof p.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (!text.trim()) return '';
  if (isUser) {
    // Environment/workspace snapshot message: discard the whole message (DSH has live file access, so a static snapshot is useless; the trailing note is also VS Code metadata)
    if (/^\s*<(environment_info|workspace_info)>/.test(text)) return '';
    // File reference handling: VS Code wraps files dragged into the chat box in <attachments>/<attachment> containers inside
    // user messages (both forms occur: a separate message, or the same message as the <userRequest> prompt). Always strip
    // the attachment container first, extract the `filePath` paths, then run prompt parsing on the rest — only paths pass through, never contents.
    const noInstr0 = text.replace(/<instructions>[\s\S]*?<\/instructions>/gi, '').trim();
    const { cleaned: noAttach, paths: attachPaths } = stripAndExtractAttachments(noInstr0);
    const attachSuffix = attachPaths.length ? (t('\n\n【文件引用】\n') + attachPaths.map((p) => '- ' + p).join('\n')) : '';
    if (!noAttach) {
      // The whole message is attachments only: emit a reference block (no "用户：" prefix; identity keys skip it automatically,
      // and the reference block is serialized to DSH together with the real question message that follows)
      return attachPaths.length ? (t('【文件引用】\n') + attachPaths.map((p) => '- ' + p).join('\n')) : '';
    }
    text = noAttach; // all later parsing works on the text with attachments stripped; file contents are never passed through
    // Keep Copilot-only memory (the body of userMemory/sessionMemory/repoMemory, with the XML wrapper removed)
    const memText = extractMemoryBlocks(text);
    if (memText) {
      const rest = text.replace(/<(userMemory|sessionMemory|repoMemory)>\s*[\s\S]*?\s*<\/\1>/g, '').trim();
      if (rest) {
        const innerQ = extractUserRequest(rest);
        return t('【Copilot 记忆】\n') + memText + t('\n\n用户：') + (innerQ !== null ? innerQ : rest) + attachSuffix;
      }
      return t('【Copilot 记忆】\n') + memText + attachSuffix;
    }
    // Prefer extracting the real prompt inside <userRequest> / <prompt> (VS Code wraps the prompt in <prompt>,
    // with context such as instructions/AGENTS.md in front — keep only the prompt itself to avoid polluting the session and identity keys)
    const inner = extractUserRequest(text);
    if (inner !== null) return t('用户：') + inner + attachSuffix;
    // After stripping the Copilot instructions preamble and the <instructions> block, continue if real content is left
    const cleaned = stripCopilotContext(text);
    if (cleaned !== text) {
      if (!cleaned) return ''; // instructions and context only → discard
      text = cleaned;
      const inner2 = extractUserRequest(text);
      if (inner2 !== null) return t('用户：') + inner2 + attachSuffix;
    }
    // Junk block at the start: strip the prefix and keep the real content at the tail, rather than discarding the whole message
    if (isJunkUserText(text)) {
      const stripped = stripJunkPrefix(text);
      if (stripped) return t('用户：') + stripped + attachSuffix;
      return '';
    }
    return t('用户：') + text + attachSuffix;
  }
  // Assistant message: strip the "⏳ 已提交给 DeepSeek Harness…" placeholder prefix we emitted in the previous turn,
  // so it is not passed back to DSH as conversation context (the real answer content after it is kept)
  {
    const marker = DSH_ANSWER_MARKER;
    const mi = text.indexOf(marker);
    if (mi >= 0) {
      const nl = text.indexOf('\n\n', mi + marker.length);
      if (nl >= 0) {
        text = text.slice(nl + 2);
      } else {
        text = '';
      }
    }
  }
  // VS Code-injected blocks in assistant messages (<system-reminder>, etc.): strip the prefix and keep only the answer body,
  // so system prompts are not passed back to DSH again as "already answered" content
  {
    const sm = text.match(/<system-reminder>[\s\S]*?<\/system-reminder>\s*/i);
    if (sm) text = text.replace(sm[0], '');
  }
  if (!text.trim()) return '';
  return t('助手：') + text;
}

/** The provenance marker for DSH answers in the VS Code transcript (emitted as the first text segment when streaming back). */
const DSH_ANSWER_MARKER = t('⏳ 已提交给 DeepSeek Harness');

/**
 * Extract the raw text of a single message (no cleanup at all), for provenance marker detection.
 * @param {any} m
 * @returns {string}
 */
function lmRawText(m) {
  if (!m) return '';
  let text = '';
  if (typeof m.content === 'string') {
    text = m.content;
  } else if (Array.isArray(m.content)) {
    text = m.content
      .map((p) => {
        if (!p) return '';
        if (typeof p === 'string') return p;
        if (typeof p.value === 'string') return p.value;
        if (typeof p.content === 'string') return p.content;
        if (typeof p.text === 'string') return p.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return text;
}

/**
 * Tell whether a message is an answer produced by DSH itself (an assistant message carrying the ⏳ provenance marker).
 * @param {any} m
 * @returns {boolean}
 */
function isDshProducedAnswer(m) {
  const role = m && m.role;
  const isAssistant = role === 'assistant' || role === 2 || role === 'Assistant';
  if (!isAssistant) return false;
  return lmRawText(m).indexOf(DSH_ANSWER_MARKER) >= 0;
}

/**
 * Find the index (boundary) of the last "DSH-known" message in `messages`.
 * - Primary signal: the last assistant carrying the ⏳ provenance marker (an answer DSH streamed out itself), the most reliable;
 * - Secondary signal (fallback when there is no marker): the user prompt matching `lastUserText`; the assistant immediately after it is DSH's answer for the same turn;
 * Returns -1 if not found.
 * After the boundary = other models' Q&A while switched away (foreign segment) + the current prompt; this is the only increment DSH needs to receive.
 */
function findDshKnownBoundary(messages, lastUserText) {
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    if (isDshProducedAnswer(messages[i])) return i;
  }
  // Secondary signal (fallback when there is no ⏳ marker): scan from the end for every prompt whose text matches `lastUserText`,
  // and take the first one immediately followed by an assistant — this supports the user asking the same text again
  // (the last prompt has no answer yet and is skipped, so the answer of the previous Q&A pair becomes the boundary).
  if (lastUserText) {
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const m = messages[i];
      const role = m && m.role;
      if (role !== 1 && role !== 'user' && role !== 'User') continue;
      const full = lmMessageText(m);
      if (!full.startsWith(t('用户：')) || stripAttachSuffix(full.slice(3)) !== lastUserText) continue;
      for (let j = i + 1; j < (messages || []).length; j++) {
        const mm = messages[j];
        const r2 = mm && mm.role;
        const isUser = r2 === 'user' || r2 === 1 || r2 === 'User';
        const isAssistant = r2 === 'assistant' || r2 === 2 || r2 === 'Assistant';
        if (isAssistant) return j;
        if (isUser) break; // the answer was edited or lost → that question/answer pair is incomplete; keep looking for an earlier prompt with the same text
      }
    }
  }
  return -1;
}

/**
 * Serialize the message list VS Code hands to the model into plain conversation text.
 * @param {any[]} messages
 * @param {{markForeignAssistant?: boolean}} [opts] When `markForeignAssistant=true`, tag foreign assistant messages with the provenance marker
 * @returns {string}
 */
function serializeLmMessages(messages, opts) {
  const markForeign = !!(opts && opts.markForeignAssistant);
  const out = [];
  const emittedBlocks = new Set();
  for (const m of messages || []) {
    const s = lmMessageText(m);
    if (!s) continue;
    if (s.startsWith(t('【文件引用】'))) {
      // Reference block message: cross-message de-duplication — VS Code sends the same file once as the active file and once as an attachment
      if (emittedBlocks.has(s)) continue;
      emittedBlocks.add(s);
      out.push(s);
      continue;
    }
    if (markForeign && s.startsWith(t('助手：'))) {
      out.push(t('【Copilot 其他模型回答】') + s);
    } else {
      out.push(s);
    }
  }
  return out.join('\n\n');
}

/**
 * Detect VS Code's UI-helper synthetic requests (progress text/title generation, etc.), returning { kind, count, scenario, titleSeed } or null.
 * These requests are not user prompts and must not be forwarded to DSH.
 * @param {any[]} messages
 * @returns {any|null}
 */
function detectSyntheticRequest(messages) {
  const q = lastLmUserText(messages);
  if (!q) return null;
  let m = q.match(/generate exactly (\d+) unique progress messages for the "([^"]+)" scenario/i);
  if (m) return { kind: 'progress', count: parseInt(m[1], 10) || 10, scenario: m[2] || 'task' };
  m = q.match(/write a brief title for the following request[:：]\s*([\s\S]*)/i);
  if (m) return { kind: 'title', titleSeed: (m[1] || '').trim() };
  if (/^Please generate/i.test(q) || /^Return only a JSON array/i.test(q)) {
    return { kind: 'generic' };
  }
  return null;
}

const SYNTHETIC_PROGRESS_TEXTS = {
  'edit code': [t('正在读取文件…'), t('正在分析代码结构…'), t('正在生成修改方案…'), t('正在编辑文件…'), t('正在校验修改…'), t('正在应用更改…'), t('正在检查语法…'), t('正在运行测试…'), t('正在复查结果…'), t('即将完成…')],
  'generate code': [t('正在理解需求…'), t('正在设计结构…'), t('正在生成代码…'), t('正在组织模块…'), t('正在补充细节…'), t('正在检查语法…'), t('正在优化逻辑…'), t('正在生成测试…'), t('正在复查结果…'), t('即将完成…')]
};

/**
 * Replay/wait for the current turn's answer of the DSH session into this provider call (for the de-duplication case only):
 * when VS Code delivers the same prompt twice, do not create a session and do not submit the prompt again; just
 * stream the existing/in-progress answer to this call again, so that both the "bare prompt" and the "with context" calls get an answer.
 */
async function replayDshAnswer(base, sid, timeoutMs, progress, token) {
  const deadline = Date.now() + timeoutMs;
  let lastSeq = 0;
  let started = false;
  try {
    const pre = await fetchSessionHistory(base, sid);
    const events = (pre && Array.isArray(pre.events)) ? pre.events : [];
    for (const item of events) {
      const e = item && item.event ? item.event : item;
      if (e && typeof e.seq === 'number' && e.type === 'turn/start') lastSeq = e.seq > 0 ? e.seq - 1 : 0;
    }
  } catch (_) { /* start from 0 when the starting point cannot be read */ }
  let blockEndSeen = false;
  while (Date.now() < deadline) {
    if (token.isCancellationRequested) return;
    let hist;
    try {
      hist = await fetchSessionHistory(base, sid);
    } catch (_) { return; }
    const events = (hist && Array.isArray(hist.events)) ? hist.events : [];
    let ended = false;
    for (const item of events) {
      const e = item && item.event ? item.event : item;
      if (!e || typeof e.seq !== 'number' || e.seq <= lastSeq) continue;
      lastSeq = e.seq;
      if (e.type === 'turn/start') {
        started = true;
        blockEndSeen = false;
      } else if (e.type === 'assistant/chunk' && e.data && e.data.chunk) {
        const c = e.data.chunk;
        if (c.type === 'block-end' && c.block && typeof c.block.text === 'string' && c.block.text.length > 0) {
          blockEndSeen = true;
          if (!started) started = true;
          progress.report(makeTextPart(c.block.text));
        } else if (c.type === 'text-delta' && !blockEndSeen && typeof c.text === 'string' && c.text.length > 0) {
          if (!started) started = true;
          progress.report(makeTextPart(c.text));
        }
      } else if (e.type === 'turn/end') {
        ended = true;
      }
    }
    if (ended) return;
    await sleep(1000);
  }
}

/**
 * Request handling for the dsh language model provider.
 * @param {any[]} messages
 * @param {any} progress Progress<LanguageModelResponsePart>
 * @param {any} token CancellationToken
 * @returns {Promise<void>}
 */
async function handleDshModelRequest(model, messages, options, progress, token) {
  const base = await apiBase();
  // Resolve the model selection: `dsh-deepseek-*` maps to fixed DeepSeek official models; the `dsh` entry follows the VS Code configuration
  const fixed = resolveDshModelSelection((model && model.id) || 'dsh');
  const provider = fixed ? fixed.provider : cfg().get('dshPanel.chatProvider', '');
  const chatModel = fixed ? fixed.model : cfg().get('dshPanel.chatModel', '');
  // Reasoning effort: the VS Code UI selection (options.modelConfiguration.reasoningEffort) takes priority,
  // then the dshPanel.dshReasoningEffort setting as a fallback, and finally the DSH default.
  // Mapping: none/off → off; low/high/max pass through (values observed to be supported by DSH); everything else is ignored.
  const DSH_EFFORTS = ['off', 'low', 'high', 'max'];
  const EFFORT_MAP = { none: 'off', off: 'off', low: 'low', high: 'high', max: 'max' };
  const uiEffort = String((options && (options.modelConfiguration || {}).reasoningEffort) || (options && (options.configuration || {}).reasoningEffort) || '');
  let effort = uiEffort || String(cfg().get('dshPanel.dshReasoningEffort', '') || '');
  if (EFFORT_MAP[effort]) effort = EFFORT_MAP[effort];
  if (effort && !DSH_EFFORTS.includes(effort)) effort = ''; // invalid effort level → follow the DSH default
  const displayModel = fixed ? fixed.model : (chatModel || t('DSH 默认模型'));
  const selectionKey = provider && chatModel ? (provider + '/' + chatModel + (effort ? '/' + effort : '')) : '';
  const currentPrompt = lastLmUserText(messages);
  // Locate the current chat sessionId (the chat file name) in parallel up front: persisting to disk has a race of a few seconds,
  // and polling early hides the wait behind the DSH readiness check without slowing the first answer.
  const sessionIdPromise = currentPrompt ? locateModelChatSessionId(currentPrompt, messages) : Promise.resolve(null);
  try {
    // Synthetic request (VS Code UI helper): answered instantly and locally, not forwarded to DSH and no DSH session created
    const synthetic = detectSyntheticRequest(messages);
    if (synthetic) {
      if (synthetic.kind === 'progress') {
        const texts = SYNTHETIC_PROGRESS_TEXTS[synthetic.scenario]
          || Array.from({ length: Math.min(synthetic.count, 10) }, (_, i) => t('正在处理（{0}/{1}）…', [i + 1, Math.min(synthetic.count, 10)]));
        progress.report(makeTextPart(JSON.stringify(texts.slice(0, Math.min(synthetic.count, 10)))));
      } else if (synthetic.kind === 'title') {
        const title = (synthetic.titleSeed || t('DeepSeek Harness 对话')).slice(0, 40);
        progress.report(makeTextPart(title));
      } else {
        progress.report(makeTextPart('[]'));
      }
      return;
    }
    const installed = await ensureDshInstalled();
    if (!installed) {
      progress.report(makeTextPart(t('❌ 未检测到 DeepSeek Harness (dsh)。请安装 npm install -g @deepseek-ai/dsh，或打开 DSH 面板触发自动安装。')));
      return;
    }
    const running = await ensureRunningOnce();
    if (!running) {
      progress.report(makeTextPart(t('❌ 无法连接 DSH 服务（{0}）。请打开 DSH 面板确认其已启动。', [getUrl()])));
      return;
    }

    const fullConvText = serializeLmMessages(messages);

    // Debug capture: persist the message structure VS Code hands to the model to disk verbatim (for troubleshooting serialization issues)
    if (cfg().get('dshPanel.debugModelMessages', false)) {
      try {
        const debugDir = path.join(getWorkspaceDir(), '.dsh-debug');
        fs.mkdirSync(debugDir, { recursive: true });
        const dump = {
          ts: Date.now(),
          model: {
            id: model && model.id,
            vendor: model && model.vendor,
            family: model && model.family,
            version: model && model.version,
            name: model && model.name,
            modelKeys: model ? Object.keys(model) : []
          },
          options: {
            allKeys: options ? Object.keys(options) : [],
            shallow: (() => {
              const o = {};
              if (!options) return o;
              for (const k of Object.keys(options)) {
                try {
                  const v = options[k];
                  if (v === null || v === undefined) { o[k] = String(v); continue; }
                  if (typeof v === 'object') {
                    if (Array.isArray(v)) { o[k] = 'array[' + v.length + ']'; continue; }
                    o[k] = { keys: Object.keys(v), json: JSON.stringify(v).slice(0, 600) };
                  } else {
                    o[k] = String(v).slice(0, 300);
                  }
                } catch (e) { o[k] = '<unserializable>'; }
              }
              return o;
            })()
          },
          messages: (messages || []).map((m) => ({
            role: m.role,
            name: m.name,
            parts: Array.isArray(m.content)
              ? m.content.map((p) => {
                  if (p == null) return null;
                  const o = (typeof p === 'object' && p !== null) ? p : null;
                  return {
                    ctor: (o && o.constructor && o.constructor.name) || typeof p,
                    keys: o ? Object.keys(o) : [],
                    value: o && typeof o.value === 'string' ? o.value : undefined,
                    content: o && typeof o.content === 'string' ? o.content : undefined,
                    text: o && typeof o.text === 'string' ? o.text : undefined
                  };
                })
              : (typeof m.content === 'string' ? m.content : null)
          })),
          convText: fullConvText
        };
        fs.writeFileSync(path.join(debugDir, 'lm-messages-' + Date.now() + '.json'), JSON.stringify(dump, null, 2), 'utf8');
      } catch (e) {
        console.warn(t('[DeepSeek Harness] 写模型消息调试文件失败：'), e && e.message);
      }
    }

    // Chat identity → DSH session mapping: key directly on the Copilot chat file name (sessionId) —
    // each chat is unique and stable, one chat maps to one DSH session; only when the request is slow to be persisted to disk (very rare)
    // does it fall back to the first-question hash (only for de-duplicating a second delivery of the same question, with transcript validation against collisions).
    const workspacePath = getWorkspaceDir();
    const map = Object.assign({}, gContext.globalState.get(DSH_MODEL_MAP_KEY) || {});
    const diskId = await sessionIdPromise;
    const chatKey = diskId
      ? ('m-' + String(diskId))
      : ('m-' + crypto.createHash('sha1').update(firstLmQuestionText(messages) || currentPrompt || 'first').digest('hex').slice(0, 16));
    const FRESH_MS = 15 * 60 * 1000;
    const entryFresh = (e, ms) => e && typeof e.lastUsedAt === 'number' && (Date.now() - e.lastUsedAt) < (ms || FRESH_MS);
    let entry = map[chatKey];
    // Direct-hit validation (guards against crossed sessions): the same chat's transcript must still contain the "last sent prompt";
    // if it is not found, the key collided (another chat/old chat) → treat it as no entry (better to create a new session than to cross sessions).
    // The first turn (no previous prompt) cannot use transcript validation, so it can only judge by "same question + active within 60 seconds" whether this is
    // a second delivery of the same prompt (VS Code's bare-prompt and with-context calls are only seconds apart);
    // beyond 60 seconds it is treated as another chat hitting the same question → create a new session.
    if (entry && entry.dshSessionId && entry.workspacePath === workspacePath) {
      const prevPrompt = prevLmUserText(messages);
      const isSameChat = prevPrompt
        ? findLmUserIndex(messages, entry.lastUserText) >= 0
        : (entry.lastUserText === currentPrompt && entryFresh(entry, 60 * 1000));
      if (!isSameChat) entry = null;
    }
    // Fallback recovery: for the rare case where "the request was slow to be persisted to disk → the previous turn used the hash key and only this turn obtained the sessionId key",
    // find the entry belonging to the same chat in the mapping table (a safety net under the direct sessionId mapping).
    if (!entry || !entry.dshSessionId || entry.workspacePath !== workspacePath) {
      const prevPrompt = prevLmUserText(messages);
      if (prevPrompt) {
        // Non-first-turn transcript recovery: among all entries in the same workspace active within 15 minutes, find candidates whose "recorded previous prompt still appears
        // in the current transcript", preferring the one that appears latest (closest to the current prompt → most likely the same conversation).
        // Note that prevPrompt cannot be used as an anchor: after switching to another model, the immediately preceding prompt was answered by another model,
        // while the entry records the last DSH prompt; the two are not necessarily the same (the root cause of the broken link on the second switch back).
        let best = null;
        let bestIdx = -1;
        for (const k of Object.keys(map)) {
          const e = map[k];
          if (!e || !e.dshSessionId || e.workspacePath !== workspacePath || !entryFresh(e)) continue;
          const idx = findLmUserIndex(messages, e.lastUserText);
          if (idx >= 0 && idx > bestIdx) { best = e; bestIdx = idx; }
        }
        if (best) {
          entry = best;
          map[chatKey] = best; // record it under the current key so later turns stay consistent
        }
      } else {
        // First turn: only merge the same question within 60 seconds (VS Code's bare-prompt and with-context calls are only seconds apart)
        for (const k of Object.keys(map)) {
          const e = map[k];
          if (e && e.dshSessionId && e.workspacePath === workspacePath
            && e.lastUserText === currentPrompt && entryFresh(e, 60 * 1000)) {
            entry = e;
            map[chatKey] = e;
            break;
          }
        }
      }
    }
    // Attachment signature of the current prompt (the last user message): a change in references means new files were brought in,
    // which is not a "duplicate delivery of the same prompt", so it must be let through (otherwise newly dragged files could never be sent out).
    // Take only the last user message — the serialized history of the bare-prompt and with-context deliveries may differ,
    // and concatenating the whole conversation would wrongly break de-duplication (a lesson from v0.8.30).
    let currentAttachSig = '';
    for (let i = (messages || []).length - 1; i >= 0; i--) {
      const mm = messages[i];
      const r2 = mm && mm.role;
      if (r2 !== 1 && r2 !== 'user' && r2 !== 'User') continue;
      const s = lmMessageText(mm);
      if (s) {
        const ai = s.indexOf(t('【文件引用】'));
        if (ai >= 0) currentAttachSig = s.slice(ai);
        break;
      }
    }
    // De-duplication: VS Code delivers the same prompt twice ("bare prompt" + "instructions+<prompt> prompt"),
    // after normalization currentPrompt is the same and the attachment signature matches; if the session already has an in-progress/completed turn for the same question
    // (within 20 seconds), replay the answer directly, avoiding two DSH sessions or a duplicate submission of the same question.
    if (entry && entry.dshSessionId && entry.workspacePath === workspacePath
      && entry.lastUserText === currentPrompt
      && (entry.lastAttachSig || '') === currentAttachSig
      && (entry.pending || entry.completed)
      && entryFresh(entry, 20 * 1000)) {
      await replayDshAnswer(base, entry.dshSessionId, Number(cfg().get('dshPanel.chatTimeoutMs', 900000)) || 900000, progress, token);
      return;
    }
    let sid = null;
    let taskText = fullConvText;
    let isNewSession = false;
    if (entry && entry.dshSessionId && entry.workspacePath === workspacePath) {
      sid = entry.dshSessionId;
      // Increment (option A): locate the boundary of the last "DSH-known" message and send only what follows it —
      // turns DSH already answered are replayed by the DSH session and not sent back (saves tokens);
      // other models' Q&A while switched away (foreign segment) + the current prompt are the only information DSH is missing; send them and tag them with the provenance marker.
      const boundary = findDshKnownBoundary(messages, entry.lastUserText);
      if (boundary >= 0) {
        const delta = serializeLmMessages((messages || []).slice(boundary + 1), { markForeignAssistant: cfg().get('dshPanel.markForeignAssistant', true) });
        if (delta.trim()) taskText = delta;
      } else {
        // Fallback: no provenance marker found (history edited, etc.) → degrade to the increment after the "last sent prompt"
        const idx = findLmUserIndex(messages, entry.lastUserText);
        if (idx >= 0) {
          const delta = serializeLmMessages((messages || []).slice(idx + 1));
          if (delta.trim()) taskText = delta;
        }
      }
      // Model/effort switch: call selectModel again when it differs from the previous selection (the same chat keeps the same DSH session)
      if (selectionKey && entry.selection !== selectionKey) {
        await selectModelForSession(base, sid, provider, chatModel, effort);
        entry.selection = selectionKey;
      }
      // If the previous prompt cannot be found (messages edited, etc.), use the full text (redundant but correct)
    } else {
      const createPayload = { cwd: workspacePath };
      const preset = cfg().get('dshPanel.chatAgentPreset', '');
      if (preset) createPayload.agentPreset = preset;
      const created = await dshRpc(base, 'session.create', createPayload, 20000);
      sid = created.sessionId;
      isNewSession = true;
      entry = { dshSessionId: sid, workspacePath, lastUserText: '', selection: '', pending: false, completed: false, lastUsedAt: Date.now() };
      map[chatKey] = entry;
      if (selectionKey) {
        await selectModelForSession(base, sid, provider, chatModel, effort);
        entry.selection = selectionKey;
      }
    }
    entry.lastUserText = currentPrompt;
    entry.lastAttachSig = currentAttachSig;
    entry.pending = true;
    entry.completed = false;
    entry.lastUsedAt = Date.now();
    await gContext.globalState.update(DSH_MODEL_MAP_KEY, map);
    if (!taskText.trim()) taskText = t('用户：') + currentPrompt;
    // Take the event cursor first (must be before submitting the task, so that turn/start is not consumed along with it and streaming detection does not break)
    const timeoutMs = Number(cfg().get('dshPanel.chatTimeoutMs', 900000)) || 900000;
    const deadline = Date.now() + timeoutMs;
    let lastSeq = 0;
    let started = false;
    try {
      const pre = await fetchSessionHistory(base, sid);
      const preEvents = (pre && Array.isArray(pre.events)) ? pre.events : [];
      for (const item of preEvents) {
        const e = item && item.event ? item.event : item;
        if (e && typeof e.seq === 'number' && e.seq > lastSeq) lastSeq = e.seq;
      }
    } catch (_) { /* start from 0 when the cursor cannot be read */ }

    await dshRpc(base, 'session.prompt', {
      requestId: 'vscode-' + Date.now().toString(36) + '-' + crypto.randomBytes(4).toString('hex'),
      sessionId: sid,
      mode: 'queue',
      content: [{ type: 'text', text: taskText }]
    }, 30000);
    progress.report(makeTextPart(t('⏳ 已提交给 DeepSeek Harness（{0}{1}）{2}，正在执行…', [displayModel, effort ? t(' · 档位 ') + effort : '', isNewSession ? t('（新会话）') : t('（续聊）')]) + t('\n\n')));
    console.log(t('[DeepSeek Harness] dsh 模型请求已提交，session=') + sid);

    while (Date.now() < deadline) {
      if (token.isCancellationRequested) {
        entry.pending = false;
        try { await gContext.globalState.update(DSH_MODEL_MAP_KEY, map); } catch (_) {}
        progress.report(makeTextPart('\n\n> ' + t('⏹ 已停止等待。任务仍在 DSH 中运行，可到 DSH 面板查看。')));
        return;
      }
      let hist;
      try {
        hist = await fetchSessionHistory(base, sid);
      } catch (e) {
        entry.pending = false;
        try { await gContext.globalState.update(DSH_MODEL_MAP_KEY, map); } catch (_) {}
        progress.report(makeTextPart('\n\n> ' + t('⚠️ 读取 DSH 任务状态失败：{0}（任务可能仍在运行，可到 DSH 面板查看）', [e.message])));
        return;
      }
      const events = (hist && Array.isArray(hist.events)) ? hist.events : [];
      for (const item of events) {
        const e = item && item.event ? item.event : item;
        if (!e || typeof e.seq !== 'number' || e.seq <= lastSeq) continue;
        lastSeq = e.seq;
        if (e.type === 'turn/start') {
          started = true;
        } else if (e.type === 'assistant/chunk' && e.data && e.data.chunk) {
          const c = e.data.chunk;
          if (c.type === 'text-delta' && typeof c.text === 'string' && c.text.length > 0) {
            if (!started) started = true; // defensive: stream as usual even if turn/start was missed
            progress.report(makeTextPart(c.text));
          }
        } else if (e.type === 'turn/end') {
          started = true; // defensive: finish normally even if turn/start was missed
          const reason = e.data && e.data.reason;
          if (reason && reason.kind !== 'completed') {
            const errDesc = reason.error ? (reason.error.code + ': ' + reason.error.message) : reason.kind;
            progress.report(makeTextPart('\n\n> ' + t('⚠️ DSH 任务未正常完成（{0}）。可到 DSH 面板查看。', [errDesc])));
          }
          console.log(t('[DeepSeek Harness] dsh 模型请求完成'));
          entry.pending = false;
          entry.completed = true;
          try { await gContext.globalState.update(DSH_MODEL_MAP_KEY, map); } catch (_) {}
          return;
        }
      }
      await sleep(1000);
    }
    entry.pending = false;
    try { await gContext.globalState.update(DSH_MODEL_MAP_KEY, map); } catch (_) {}
    progress.report(makeTextPart('\n\n> ' + t('⏱ 超过等待上限（{0} 分钟）仍未完成。任务仍在 DSH 面板运行。', [Math.round(timeoutMs / 60000)])));
  } catch (e) {
    progress.report(makeTextPart(t('❌ DSH 模型执行出错：{0}', [e && e.message ? e.message : String(e)])));
  }
}

/**
 * Resolve a DSH model entry → fixed DeepSeek official selection; the 'dsh' entry returns null (follows VS Code configuration).
 * @param {string} modelId
 * @returns {{provider: string, model: string} | null}
 */
function resolveDshModelSelection(modelId) {
  if (modelId === 'dsh-deepseek-v4-pro') return { provider: 'deepseek-official', model: 'deepseek-v4-pro' };
  if (modelId === 'dsh-deepseek-v4-flash') return { provider: 'deepseek-official', model: 'deepseek-v4-flash' };
  if (modelId === 'dsh-deepseek-v4-flash-vision-exp') return { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' };
  return null;
}

/**
 * Select the model for a DSH session (with optional reasoning effort); on failure, silently fall back to the DSH default.
 * @param {string} base
 * @param {string} sid
 * @param {string} provider
 * @param {string} chatModel
 * @param {string} effort
 * @returns {Promise<boolean>}
 */
async function selectModelForSession(base, sid, provider, chatModel, effort) {
  const payload = { sessionId: sid, provider, model: chatModel };
  if (effort) payload.reasoningEffort = effort;
  try {
    await dshRpc(base, 'session.selectModel', payload, 20000);
    return true;
  } catch (_) {
    return false; // if selection fails, use the DSH default model and effort
  }
}

/**
 * Register the dsh language model provider (VS Code 1.94+, `vscode.lm`).
 * @param {import('vscode').ExtensionContext} context
 */
function registerDshModelProvider(context) {
  if (!vscode.lm || typeof vscode.lm.registerLanguageModelChatProvider !== 'function') {
    console.warn(t('[DeepSeek Harness] vscode.lm 不可用，跳过 dsh 语言模型提供方注册'));
    return;
  }
  if (!cfg().get('dshPanel.enableDshModel', true)) return;
  try {
    // Key (borrowed from vizards.deepseek-v4-for-copilot): provide `onDidChangeLanguageModelChatInformation`
    // event, and fire it once after registration — VS Code caches model information, and if no change event fires,
    // the cache may hold stale data without `configurationSchema`, so the "reasoning effort" UI does not render.
    const dshModelEmitter = new vscode.EventEmitter();
    // Aligned with vizards.deepseek-v4-for-copilot: the VS Code core renders the "reasoning effort" config pill from the
    // top-level `languageModelChatInformation` fields returned by the provider. Cost uses a valid currency string
    // (to avoid illegal values like '—'), and the `reasoningEffort` property carries `group:'navigation'`.
    const dshModelDefs = [
      { id: 'dsh', name: 'DSH (DeepSeek Harness)', detail: t('默认：跟随 DSH 设置模型 · 档位可配'),
        cost: { inputCost: '$0.14', outputCost: '$0.28', cacheCost: '$0.0028' } },
      { id: 'dsh-deepseek-v4-pro', name: 'DeepSeek-V4-Pro (DSH)', detail: t('DeepSeek 官方 · 档位 off/low/high/max'),
        cost: { inputCost: '$0.435', outputCost: '$0.87', cacheCost: '$0.003625' } },
      { id: 'dsh-deepseek-v4-flash', name: 'DeepSeek-V4-Flash (DSH)', detail: t('DeepSeek 官方 · 档位 off/low/high/max'),
        cost: { inputCost: '$0.14', outputCost: '$0.28', cacheCost: '$0.0028' } },
      { id: 'dsh-deepseek-v4-flash-vision-exp', name: 'deepseek-v4-flash-vision-exp (DSH)', detail: t('DeepSeek 官方视觉模型 · 档位 off/low/high/max'),
        cost: { inputCost: '$0.14', outputCost: '$0.28', cacheCost: '$0.0028' } }
    ];
    const dshReasoningEffortSchema = {
      type: 'string',
      title: t('推理档位'),
      default: 'high',
      enum: ['none', 'low', 'high', 'max'],
      enumItemLabels: [t('关闭（off）'), t('低'), t('高'), t('最高')],
      enumDescriptions: [
        t('关闭推理（对应 DSH 档位 off）'),
        t('低档推理'),
        t('高档推理（DSH 默认档位）'),
        t('最高档推理')
      ],
      group: 'navigation'
    };
    const provider = {
      onDidChangeLanguageModelChatInformation: dshModelEmitter.event,
      provideLanguageModelChatInformation(_options, _token) {
        const info = dshModelDefs.map((m) => ({
          id: m.id,
          name: m.name,
          family: 'dsh',
          version: '0.8.9',
          detail: m.detail,
          tooltip: t('DeepSeek Harness：在工作区解析任务、执行工具后解答；模型与推理档位可配置'),
          maxInputTokens: 250000,
          maxOutputTokens: 128000,
          // Gating fields (aligned with vizards: `isBYOK`/`isUserSelectable` make the model selectable and configurable)
          isBYOK: true,
          isUserSelectable: true,
          // `toolCalling` declared true: Agent mode's model picker lists only models that support tools.
          // DSH uses its own tool execution; tools passed in by VS Code (`options.tools`) are always ignored and no tool calls are returned — no conflict.
          capabilities: { toolCalling: true, imageInput: false },
          // Cost info (aligned with vizards `toModelCostInfo` fields; valid currency strings to avoid core parse errors)
          priceCategory: 'low',
          ...m.cost,
          // Model configuration schema: lets VS Code show the "reasoning effort" dropdown in the model picker,
          // and the value the user selects is passed back to the provider via `options.modelConfiguration.reasoningEffort`.
          configurationSchema: { properties: { reasoningEffort: dshReasoningEffortSchema } }
        }));
        // Write the provider info actually returned to disk, to confirm whether `configurationSchema` is passed to VS Code.
        try {
          const dbgDir = path.join(os.homedir(), '.dsh-debug');
          fs.mkdirSync(dbgDir, { recursive: true });
          fs.writeFileSync(path.join(dbgDir, 'provider-info.json'), JSON.stringify({ ts: Date.now(), models: info }, null, 2), 'utf8');
        } catch (_) { /* ignore */ }
        return info;
      },
      provideLanguageModelChatResponse(model, messages, options, progress, token) {
        return handleDshModelRequest(model, messages, options, progress, token);
      },
      provideTokenCount(_model, text, _token) {
        const s = typeof text === 'string' ? text : (text && text.value ? text.value : '');
        return Promise.resolve(Math.max(1, Math.ceil(String(s).length / 3)));
      }
    };
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('dsh', provider));
    // 1) Activate Copilot Chat (if installed) to ensure the live listener for model information exists;
    // 2) Fire the change event multiple times + actively call `selectChatModels` to force a re-query, covering the core/chat extension model caches.
    try {
      const copilotChat = vscode.extensions.getExtension('github.copilot-chat');
      if (copilotChat) {
        copilotChat.activate().then(() => {
          setTimeout(() => { try { dshModelEmitter.fire(); } catch (_) { /* ignore when already disposed */ } }, 50);
        }).catch(() => { /* ignore when there are no listeners */ });
      }
    } catch (_) { /* ignore when not installed, or when there are no listeners */ }
    [300, 1200, 3000, 6000].forEach((ms) => {
      setTimeout(() => { try { dshModelEmitter.fire(); } catch (_) { /* ignore when already disposed */ } }, ms);
    });
    setTimeout(() => { try { vscode.lm.selectChatModels({ vendor: 'dsh' }).catch(() => {}); } catch (_) { /* ignore */ } }, 700);
    context.subscriptions.push(dshModelEmitter);
    dshModelProviderRegistered = true;
    console.log(t('[DeepSeek Harness] dsh 语言模型提供方已注册（模型选择器可见），已触发模型信息刷新'));
  } catch (e) {
    console.error(t('[DeepSeek Harness] 注册 dsh 语言模型提供方失败：'), e);
  }
}

/**
 * Diagnostic: list the models in the VS Code language model registry and their metadata (including whether `configurationSchema` exists),
 * compared with vizards (`vendor=deepseek`), to locate the reason the "reasoning effort" UI does not render.
 */
async function diagnoseModels() {
  // Always write to the user home directory (independent of the current workspace, so it can always be found)
  const debugDir = path.join(os.homedir(), '.dsh-debug');
  try {
    fs.mkdirSync(debugDir, { recursive: true });
    const all = await vscode.lm.selectChatModels();
    const vendors = {};
    for (const m of all || []) {
      const obj = m;
      const vendor = String(obj.vendor || '?');
      vendors[vendor] = vendors[vendor] || [];
      const meta = obj.metadata !== undefined ? obj.metadata : null;
      vendors[vendor].push({
        id: obj.id,
        name: obj.name,
        family: obj.family,
        version: obj.version,
        maxInputTokens: obj.maxInputTokens,
        maxOutputTokens: obj.maxOutputTokens,
        priceCategory: obj.priceCategory,
        category: obj.category,
        inputCost: obj.inputCost,
        outputCost: obj.outputCost,
        cacheCost: obj.cacheCost,
        capabilities: obj.capabilities,
        isUserSelectable: obj.isUserSelectable,
        isBYOK: obj.isBYOK,
        hasConfigSchema: !!(meta && meta.configurationSchema),
        metaKeys: meta ? Object.keys(meta) : [],
        metaPreview: meta ? JSON.stringify(meta).slice(0, 500) : null,
        objKeys: Object.keys(obj)
      });
    }
    const file = path.join(debugDir, 'models-diagnose.json');
    fs.writeFileSync(file, JSON.stringify({ ts: Date.now(), vendors }, null, 2), 'utf8');
    vscode.window.showInformationMessage(t('模型注册表诊断已写入：{0}', [file]));
  } catch (e) {
    vscode.window.showErrorMessage(t('诊断失败：{0}', [e && e.message ? e.message : String(e)]));
  }
}

/**
 * The "DSH Status" diagnostic command: reports model provider registration, DSH reachability, and the current model configuration.
 */
async function showChatStatus() {
  const reachable = await checkUrl(getUrl());
  const provider = cfg().get('dshPanel.chatProvider', '');
  const model = cfg().get('dshPanel.chatModel', '');
  const effort = cfg().get('dshPanel.dshReasoningEffort', '');
  const lines = [
    t('DeepSeek Harness DSH 状态'),
    t('DSH 服务可达: {0}', [reachable ? t('是 ({0})', [getUrl()]) : t('否')]),
    t('Web 认证: {0}', [await authStatusText()]),
    t('dsh 语言模型提供方: {0}', [dshModelProviderRegistered ? t('已注册（模型选择器可见）') : t('未注册')]),
    t('模型配置: provider={0} / model={1}', [provider || t('(跟随 DSH 默认)'), model || t('(跟随 DSH 默认)')]),
    t('推理档位: {0}', [effort || t('(跟随 DSH 默认)')]),
    t('已映射聊天数: {0}', [Object.keys(gContext.globalState.get(DSH_MODEL_MAP_KEY) || {}).length])
  ];
  vscode.window.showInformationMessage(lines.join('\n'), { modal: false });
}

/**
 * Produce the diagnostic text for the auth status (used by the "DSH Status" command).
 * @returns {Promise<string>}
 */
async function authStatusText() {
  const proxy = await ensureAuthProxy();
  if (!proxy) {
    return t('未启用受管认证代理（Remote 场景或目标非回环地址），面板走直连');
  }
  const s = proxy.status();
  if (proxy.hasCookieForBase()) {
    return t('已认证（受管代理 {0}）', [s.proxy]);
  }
  if (!s.tokenKnown) {
    return t('未认证（尚未捕获 dsh 启动令牌；若 dsh 正在运行且返回 401，请重启 dsh web 由扩展接管）');
  }
  return t('令牌已捕获，Cookie 换发中/失败（代理 {0}）', [s.proxy]);
}

function activate(context) {
  gContext = context;
  // Apply English on top of the manifest the extension host passes us. VS Code
  // already resolves package.nls.json at scan time for the Extensions view and the
  // Settings UI; this covers the copy handed to the extension itself, so no Chinese
  // survives into settings keys, defaults or contributed metadata we read back.
  try {
    applyManifestTranslations(context && context.extension && context.extension.packageJSON);
  } catch (e) {
    console.error('[DeepSeek Harness] manifest localization failed:', e && e.message);
  }
  registerDshModelProvider(context);

  const provider = {
    resolveWebviewView(view) {
      activeView = view;
      view.title = 'DeepSeek Harness';

      view.webview.options = {
        enableScripts: true
      };

      render(view);

      // When an external link is clicked inside the DSH page (iframe), the dsh-open-links plugin forwards it
      // hop by hop via `postMessage` to here, and it is opened in the system default browser.
      view.webview.onDidReceiveMessage(handleWebviewMessage);

      const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('dshPanel')) {
          render(view);
        } else if (e.affectsConfiguration('editor.fontSize')) {
          // On a font-size-only change, do not reload the iframe (to avoid interrupting the current conversation); only push the new scale value.
          view.webview.postMessage({ type: 'dsh-font-scale', scale: getFontScale() });
        }
      });

      view.onDidDispose(() => {
        cfgSub.dispose();
        if (activeView === view) {
          activeView = null;
        }
      });
    }
  };

  const viewSub = vscode.window.registerWebviewViewProvider(VIEW_ID, provider, {
    webviewOptions: { retainContextWhenHidden: true }
  });

  // Editor tab mode: open DSH as a tab in the editor area (maximizes page width, can be pinned via right-click).
  // Reuses the sidebar's render and message logic; a singleton: focus it if already open, otherwise create it.
  const openInTabCmd = vscode.commands.registerCommand('dshPanel.openInTab', async () => {
    if (activeTab) {
      activeTab.reveal();
      return;
    }
    // Open in the column where the currently active editor is (do not open another column); use the first column when there is no active editor.
    const column = (vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn) || vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel(
      'dsh.tab',
      'DeepSeek Harness',
      column,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    activeTab = panel;
    // The tab takes over DSH: if the sidebar is already open, switch it to a placeholder, since two webviews loading DSH at the same time would be mutually exclusive.
    if (activeView) {
      activeView.description = t('在标签页中打开');
      activeView.webview.html = buildSuspendedHtml();
    }
    let disposed = false;
    const reloadTab = async () => {
      if (disposed) return;
      panel.webview.html = buildLoadingHtml();
      try {
        const r = await preparePanelHtml(true);
        if (disposed) return;
        panel.webview.html = r.ok ? r.html : buildErrorHtml(r.reason);
      } catch (e) {
        if (disposed) return;
        console.error(t('[DeepSeek Harness] 标签页渲染失败：'), e);
        panel.webview.html = buildErrorHtml(t('标签页渲染失败：{0}', [e && e.message ? e.message : String(e)]));
      }
    };
    tabReloadFn = reloadTab;

    const cfgSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (disposed) return;
      if (e.affectsConfiguration('dshPanel')) {
        reloadTab();
      } else if (e.affectsConfiguration('editor.fontSize')) {
        // On a font-size-only change, do not reload the iframe (to avoid interrupting the current conversation); only push the new scale value.
        panel.webview.postMessage({ type: 'dsh-font-scale', scale: getFontScale() });
      }
    });

    panel.onDidDispose(() => {
      disposed = true;
      cfgSub.dispose();
      if (activeTab === panel) activeTab = null;
      if (tabReloadFn === reloadTab) tabReloadFn = null;
      // After the tab is closed, restore the sidebar (if the sidebar still exists).
      if (activeView) {
        render(activeView);
      }
    });
    panel.webview.onDidReceiveMessage(handleWebviewMessage);

    await reloadTab();
  });

  const refreshCmd = vscode.commands.registerCommand('dshPanel.refresh', () => {
    if (activeView) {
      // Always reload the panel page: `render` rebuilds the iframe and reloads the DSH Web GUI;
      // when the service is online, `ensureRunningOnce` only reuses it and does not restart, so the dsh web process and running tasks are unaffected.
      render(activeView);
    } else {
      vscode.window.showInformationMessage(t('DeepSeek Harness 面板尚未打开，请先点击侧边栏图标。'));
    }
  });

  const openBrowserCmd = vscode.commands.registerCommand('dshPanel.openInBrowser', async () => {
    // Newer dsh web has browser authentication: prefer opening the authenticated link carrying the launch token (a real browser
    // top-level navigation can exchange it for a Cookie normally); fall back to the bare address when there is no token.
    let url = getUrl();
    const proxy = await ensureAuthProxy();
    if (proxy && proxy.token()) {
      url = proxy.authenticatedUrl();
    }
    vscode.env.openExternal(vscode.Uri.parse(url));
  });

  const restartCmd = vscode.commands.registerCommand('dshPanel.restart', async () => {
    if (!activeView) {
      vscode.window.showInformationMessage(t('DeepSeek Harness 面板尚未打开，请先点击侧边栏图标。'));
      return;
    }
    const view = activeView;

    // When dsh is running and was not started by this window, a restart would interrupt tasks in other windows, so get confirmation first.
    // When dsh is not running, or was started by this window, restart/start directly without confirmation.
    const running = await checkUrl(getUrl());
    if (running && !managedChild) {
      const choice = await vscode.window.showWarningMessage(
        t('当前 dsh web 不是由本窗口启动的，重启会中断所有正在使用它的窗口及其任务。确定要重启吗？'),
        { modal: true },
        t('重启')
      );
      if (choice !== t('重启')) {
        return;
      }
    }

    view.description = t('正在重启');
    view.webview.html = buildLoadingHtml();

    const installed = await ensureDshInstalled();
    if (activeView !== view) return;
    if (!installed) {
      view.description = t('未安装 dsh');
      view.webview.html = buildErrorHtml(t('未检测到 DeepSeek Harness (dsh)，无法重启。请先安装后重试。'));
      return;
    }

    const ok = await restartDsh();
    if (activeView !== view) return;
    if (ok) {
      registerWorkspace().catch(() => {});
      const target = await resolvePanelTarget(false);
      if (activeView !== view) return;
      if (target.unauthorized) {
        maybeGuideAuth(false);
        view.description = t('等待认证');
        view.webview.html = buildErrorHtml(t('dsh web 需要浏览器认证，且当前实例无法静默认证。请查看通知提示完成接管或粘贴认证链接。'));
        return;
      }
      view.description = getUrl();
      try {
        view.webview.html = buildIframeHtml(target.displayUrl, getFontScale());
      } catch (e) {
        view.description = t('无法加载');
        view.webview.html = buildErrorHtml(e.message);
      }
    } else {
      view.description = t('重启失败');
      view.webview.html = buildErrorHtml(t('重启 dsh web 后仍无法连接，请确认端口未被占用或 dsh 可正常启动。'));
    }
  });

  // When VS Code switches workspace (folder), register the new workspace in the DSH list as well.
  const wsSub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
    registerWorkspace().catch(() => {});
  });

  // Send Selection to the DSH composer
  const sendSelectionCmd = vscode.commands.registerCommand('dsh.sendSelection', async () => {
    const editor = vscode.window.activeTextEditor;
    // Send target: prefer the editor tab, then the sidebar panel.
    const target = activeTab || activeView;
    if (!editor || !target) {
      vscode.window.showWarningMessage(t('请先打开 DeepSeek Harness 面板或标签页并选中代码'));
      return;
    }
    const selection = editor.selection;
    if (selection.isEmpty) {
      vscode.window.showWarningMessage(t('请先选中代码片段'));
      return;
    }
    const document = editor.document;
    const selectedText = document.getText(selection);
    const filePath = document.uri.fsPath;
    const startLine = selection.start.line + 1;
    const endLine = selection.end.line + 1;
    
    const ok = await target.webview.postMessage({
      type: 'insert-selection',
      filePath: filePath,
      startLine: startLine,
      endLine: endLine,
      content: selectedText,
      language: document.languageId
    });

    if (ok) {
      vscode.window.showInformationMessage(t('已发送选中内容到 DSH，等待面板转发…'));
    } else {
      vscode.window.showErrorMessage(t('发送失败：DSH 面板 webview 未就绪，请先打开面板并等待加载完成'));
    }
  });

  const diagnoseModelsCmd = vscode.commands.registerCommand('dshPanel.diagnoseModels', () => {
    diagnoseModels().catch((e) => vscode.window.showErrorMessage(t('诊断失败：{0}', [e && e.message ? e.message : String(e)])));
  });

  const chatStatusCmd = vscode.commands.registerCommand('dshPanel.chatStatus', () => {
    showChatStatus().catch((e) => vscode.window.showErrorMessage(t('检查 DSH 状态失败：{0}', [e && e.message ? e.message : String(e)])));
  });

  const resetChatCmd = vscode.commands.registerCommand('dshPanel.resetChatMapping', async () => {
    if (gContext) {
      await gContext.globalState.update(DSH_MODEL_MAP_KEY, {});
    }
    vscode.window.showInformationMessage(t('已重置 DSH 会话映射：下次提问将创建新的 DSH 会话。'));
  });

  context.subscriptions.push(viewSub, openInTabCmd, refreshCmd, openBrowserCmd, restartCmd, wsSub, sendSelectionCmd, chatStatusCmd, diagnoseModelsCmd, resetChatCmd);
}

function deactivate() {
  // On extension deactivation, the configuration decides whether to end the dsh process started by this extension.
  const killOnDispose = cfg().get('dshPanel.killOnDispose', true);
  if (killOnDispose && managedChild) {
    killTree(managedChild);
    managedChild = null;
  }
  // Close the managed auth proxy (the token is already cached in `globalState`, so it can be reused seamlessly on the next start).
  if (authProxy) {
    const p = authProxy;
    authProxy = null;
    p.close().catch(() => {});
  }
}

module.exports = { activate, deactivate };

// For test hooks only (no impact on bundle size; runtime behavior is unchanged).
module.exports.__internals = {
  createAuthProxy,
  ensureAuthProxy,
  learnDshToken,
  extractTokenParam,
  apiBase,
  normAuthority,
  startDshAndWaitReady,
  clipboardPluginFiles,
  CLIPBOARD_PLUGIN_NAME,
  sanitizeCommand,
  getHost,
  getPort,
  getDshCommand,
  runCommandOk,
  runCommandOutput
};
