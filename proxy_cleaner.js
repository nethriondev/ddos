const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { HttpsProxyAgent } = require("https-proxy-agent");

const PROXY_FILE = path.join(__dirname, "proxy.txt");
const TEST_URL = process.env.TEST_URL || "https://httpbin.org/ip";
const CONCURRENCY = 50;
const TIMEOUT = 8000;

const colors = {
  red: (t) => `\x1b[31m${t}\x1b[0m`,
  green: (t) => `\x1b[32m${t}\x1b[0m`,
  yellow: (t) => `\x1b[33m${t}\x1b[0m`,
  cyan: (t) => `\x1b[36m${t}\x1b[0m`,
  gray: (t) => `\x1b[90m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,
};

function loadProxies() {
  try {
    const raw = fs.readFileSync(PROXY_FILE, "utf-8");
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

async function testProxy(proxy) {
  const url = `http://${proxy}`;
  try {
    const agent = new HttpsProxyAgent(url);
    const res = await axios.get(TEST_URL, {
      httpsAgent: agent,
      timeout: TIMEOUT,
      validateStatus: () => true,
    });
    if (res.status === 200 && res.data?.origin) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

async function testProxies(proxies) {
  const alive = [];
  let tested = 0;
  const total = proxies.length;
  const startTime = Date.now();

  for (let i = 0; i < proxies.length; i += CONCURRENCY) {
    const batch = proxies.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (proxy) => {
        const isAlive = await testProxy(proxy);
        return { proxy, isAlive };
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.isAlive) {
        alive.push(r.value.proxy);
      }
    }

    tested += batch.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    process.stdout.write(
      `  ${colors.gray(`[${elapsed}s]`)} Tested: ${colors.yellow(tested)}/${total} | ` +
      `${colors.green(`Alive: ${alive.length}`)} | ${colors.red(`Dead: ${tested - alive.length}`)}\r`
    );
  }

  return alive;
}

function saveProxies(proxies) {
  // Create backup of old file
  const backupPath = PROXY_FILE + ".bak";
  try {
    if (fs.existsSync(PROXY_FILE)) {
      fs.copyFileSync(PROXY_FILE, backupPath);
      console.log(colors.gray(`  Backup saved: ${backupPath}`));
    }
  } catch {}

  fs.writeFileSync(PROXY_FILE, proxies.join("\n") + "\n");
}

async function main() {
  console.log(colors.bold(colors.green("\n  ╔═══════════════════════════════╗")));
  console.log(colors.bold(colors.green("  ║   NETH ORION Proxy Cleaner    ║")));
  console.log(colors.bold(colors.green("  ╚═══════════════════════════════╝")));

  const proxies = loadProxies();

  if (proxies.length === 0) {
    console.log(colors.yellow("\n  No proxies found in proxy.txt\n"));
    return;
  }

  console.log(`\n  Loaded ${colors.cyan(proxies.length)} proxies from proxy.txt`);
  console.log(colors.cyan(`  Testing against ${TEST_URL} (timeout: ${TIMEOUT}ms, concurrency: ${CONCURRENCY})\n`));

  const alive = await testProxies(proxies);
  const removed = proxies.length - alive.length;

  console.log("\n");
  console.log(colors.cyan("  ═══════ RESULTS ═══════"));
  console.log(`  ${colors.green(`Alive:  ${alive.length}`)}`);
  console.log(`  ${colors.red(`Dead:   ${removed}`)}`);
  console.log(`  ${colors.cyan(`Alive rate: ${((alive.length / proxies.length) * 100).toFixed(1)}%`)}`);

  if (removed > 0 && alive.length > 0) {
    saveProxies(alive);
    console.log(colors.green(`\n  ==> ${removed} dead proxies removed, ${alive.length} alive kept in proxy.txt`));
  } else if (alive.length === proxies.length) {
    console.log(colors.green(`\n  ==> All ${alive.length} proxies are alive. Nothing to remove.`));
  } else if (alive.length === 0) {
    console.log(colors.red(`\n  ==> All ${proxies.length} proxies are dead. proxy.txt left unchanged.`));
  }

  console.log("");
}

main().catch((err) => {
  console.error(colors.red(`Error: ${err.message}`));
});
