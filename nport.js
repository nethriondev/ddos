const { spawn } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");

const API = "https://api.nport.link";
const SESSION_FILE = path.join(__dirname, "nport_sessions.json");

const ensureSessionFile = () => {
  if (!fs.existsSync(SESSION_FILE)) {
    fs.writeFileSync(SESSION_FILE, JSON.stringify({}, null, 2));
  }
};

const loadSessions = () => {
  ensureSessionFile();
  try {
    const data = fs.readFileSync(SESSION_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
};

const saveSession = async (subdomain, data) => {
  if (!subdomain) return;
  const sessions = loadSessions();
  sessions[subdomain] = data;
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
};

const loadSession = async (subdomain) => {
  if (!subdomain) return null;
  const sessions = loadSessions();
  return sessions[subdomain] || null;
};

const clearSession = async (subdomain) => {
  if (!subdomain) return;
  const sessions = loadSessions();
  delete sessions[subdomain];
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
};

const spawnCloudflared = (args) => {
  try {
    require('child_process').execSync('which cloudflared', { stdio: 'ignore' });
    return spawn("cloudflared", args, { stdio: ["ignore", "pipe", "pipe"], detached: true });
  } catch {
    return spawn("npx", ["cloudflared", ...args], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  }
};

const apiRequest = (subdomain) => {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ subdomain });
    const url = new URL(API);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname || "/",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, (res) => {
      let body = "";
      res.on("data", (c) => body += c);
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          j.success ? resolve(j) : reject(new Error(j.error || "API error"));
        } catch { reject(new Error("Invalid API response")); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
};

const apiDelete = (subdomain, tunnelId) => {
  return new Promise((resolve) => {
    const data = JSON.stringify({ subdomain, tunnelId });
    const url = new URL(API);
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname || "/",
      method: "DELETE",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
    }, (res) => { let b = ""; res.on("data", (c) => b += c); res.on("end", resolve); });
    req.on("error", resolve);
    req.write(data);
    req.end();
  });
};

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const cleanupTunnel = async () => {
  if (global.nportSubdomain && global.nportTunnelId) {
    console.log(`Cleaning up tunnel: ${global.nportSubdomain}`);
    await apiDelete(global.nportSubdomain, global.nportTunnelId).catch(() => {});
    await clearSession(global.nportSubdomain);
    global.nportSubdomain = null;
    global.nportTunnelId = null;
    global.nportToken = null;
    global.nportUrl = null;
  }
};

const start = (port, subdomain, options = {}) => {
  return new Promise(async (resolve) => {
    const { disableSuffix = false, maxRetries = Infinity } = options;
    
    if (global.nportProcess && global.nportUrl) {
      resolve(global.nportUrl);
      return;
    }
    if (global.isNportStarting) {
      resolve(null);
      return;
    }
    global.isNportStarting = true;
    global.nportStopping = false;

    global.nportUrl = null;

    if (global.nportProcess) {
      try { process.kill(-global.nportProcess.pid, 'SIGKILL'); } catch (e) { global.nportProcess.kill('SIGKILL'); }
      global.nportProcess = null;
    }

    let name = subdomain || `user-${Math.floor(Math.random() * 10000)}`;

    const saved = await loadSession(name);
    if (saved && saved.tunnelId) {
      console.log(`Cleaning up previous session: ${saved.subdomain}`);
      await apiDelete(saved.subdomain, saved.tunnelId).catch(() => {});
      await clearSession(name);
    }

    let lastError;
    let attempt = 0;

    const autoRestart = async () => {
      if (global.nportStopping) return;
      
      await cleanupTunnel();
      
      console.log(`cloudflared crashed, restarting tunnel in 3s...`);
      setTimeout(() => {
        if (global.nportStopping) return;
        start(port, subdomain, options);
      }, 3000);
    };

    const handleProcessExit = async (code) => {
      if (code !== 0) {
        console.log(`cloudflared exited with code ${code}`);
        global.nportUrl = null;
        global.nportProcess = null;
        await autoRestart();
      }
    };

    if (disableSuffix) {
      while (true) {
        try {
          const apiRes = await apiRequest(name);
          global.nportUrl = apiRes.url;
          global.nportSubdomain = name;
          global.nportTunnelId = apiRes.tunnelId;
          global.nportToken = apiRes.tunnelToken;

          await saveSession(name, { subdomain: name, tunnelId: apiRes.tunnelId, tunnelToken: apiRes.tunnelToken, url: apiRes.url });

          let url = `http://localhost:${port}`;
          global.nportProcess = spawnCloudflared(["tunnel", "run", "--token", apiRes.tunnelToken, "--url", url]);

          global.nportProcess.on("error", (err) => {
            console.error('NPort error:', err.message);
            global.isNportStarting = false;
            global.nportProcess = null;
            global.nportUrl = null;
            resolve(null);
          });

          global.nportProcess.on("exit", handleProcessExit);

          global.isNportStarting = false;
          console.log(`NPort URL: ${global.nportUrl}`);
          resolve(global.nportUrl);
          return;

        } catch (err) {
          lastError = err;
          global.nportUrl = null;
          const isInUse = err.message.includes("SUBDOMAIN") || err.message.includes("in use");

          if (isInUse && subdomain) {
            console.log(`Subdomain "${name}" taken, deleting and retrying (attempt ${++attempt})...`);
            await apiDelete(name, "").catch(() => {});
            await delay(2000);
          } else {
            console.log(`Error occurred, retrying (attempt ${++attempt})...`);
            await delay(2000);
          }
        }
      }
    } else {
      for (attempt = 0; attempt < (maxRetries === Infinity ? 100 : maxRetries); attempt++) {
        try {
          const apiRes = await apiRequest(name);
          global.nportUrl = apiRes.url;
          global.nportSubdomain = name;
          global.nportTunnelId = apiRes.tunnelId;
          global.nportToken = apiRes.tunnelToken;

          await saveSession(name, { subdomain: name, tunnelId: apiRes.tunnelId, tunnelToken: apiRes.tunnelToken, url: apiRes.url });

          let url = `http://localhost:${port}`;
          global.nportProcess = spawnCloudflared(["tunnel", "run", "--token", apiRes.tunnelToken, "--url", url]);

          global.nportProcess.on("error", (err) => {
            console.error('NPort error:', err.message);
            global.isNportStarting = false;
            global.nportProcess = null;
            global.nportUrl = null;
            resolve(null);
          });

          global.nportProcess.on("exit", handleProcessExit);

          global.isNportStarting = false;
          console.log(`NPort URL: ${global.nportUrl}`);
          resolve(global.nportUrl);
          return;

        } catch (err) {
          lastError = err;
          global.nportUrl = null;
          const isInUse = err.message.includes("SUBDOMAIN") || err.message.includes("in use");

          if (isInUse && subdomain) {
            console.log(`Subdomain "${name}" taken, deleting and retrying (attempt ${attempt + 1})...`);
            await apiDelete(name, "").catch(() => {});
            await delay(2000);
          } else {
            break;
          }
        }
      }

      if (subdomain && !disableSuffix) {
        const suffix = Math.random().toString(36).slice(2, 6);
        const fallbackName = `${subdomain}-${suffix}`;
        console.log(`Giving up on "${name}", trying random suffix "${fallbackName}"...`);
        try {
          const apiRes = await apiRequest(fallbackName);
          global.nportUrl = apiRes.url;
          global.nportSubdomain = fallbackName;
          global.nportTunnelId = apiRes.tunnelId;
          global.nportToken = apiRes.tunnelToken;

          await saveSession(fallbackName, { subdomain: fallbackName, tunnelId: apiRes.tunnelId, tunnelToken: apiRes.tunnelToken, url: apiRes.url });

          let url = `http://localhost:${port}`;
          
          global.nportProcess = spawnCloudflared(["tunnel", "run", "--token", apiRes.tunnelToken, "--url", url]);

          global.nportProcess.on("error", (err) => {
            console.error('NPort error:', err.message);
            global.isNportStarting = false;
            global.nportProcess = null;
            global.nportUrl = null;
            resolve(null);
          });
          global.nportProcess.on("exit", handleProcessExit);

          global.isNportStarting = false;
          console.log(`NPort URL: ${global.nportUrl}`);
          resolve(global.nportUrl);
          return;
        } catch (e2) {
          global.nportUrl = null;
          console.error("NPort fallback failed:", e2.message);
        }
      }

      console.error("NPort error:", lastError ? lastError.message : "Unknown error");
      global.isNportStarting = false;
      resolve(null);
    }
  });
};

const stop = () => {
  return new Promise(async (resolve) => {
    global.nportStopping = true;
    
    if (global.nportProcess) {
      try { process.kill(-global.nportProcess.pid, 'SIGKILL'); } catch (e) { global.nportProcess.kill('SIGKILL'); }
      global.nportProcess = null;
    }
    
    await cleanupTunnel();
    
    global.isNportStarting = false;
    resolve();
  });
};

module.exports = { start, stop, apiRequest, apiDelete, spawnCloudflared };