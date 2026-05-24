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

// Free proxy sources (raw GitHub lists)
const SOURCES = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
  "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchProxiesFromSource(url) {
  try {
    const res = await axios.get(url, { timeout: 15000 });
    const lines = res.data.split("\n").map((l) => l.trim()).filter(Boolean);
    // Filter valid ip:port lines
    const proxies = lines.filter((l) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(l));
    return proxies;
  } catch {
    return [];
  }
}

async function collectAllProxies() {
  console.log(colors.cyan("\n==> Collecting proxies from free sources...\n"));

  const allProxies = new Set();

  for (const url of SOURCES) {
    process.stdout.write(`  Fetching ${colors.gray(url.split("/").slice(-1)[0])}... `);
    const proxies = await fetchProxiesFromSource(url);
    proxies.forEach((p) => allProxies.add(p));
    console.log(colors.green(`${proxies.length} proxies`));
    await sleep(1000); // be polite
  }

  const proxyList = [...allProxies];
  console.log(`\n  ${colors.bold("Total unique proxies collected:")} ${colors.cyan(proxyList.length)}\n`);
  return proxyList;
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

async function testProxiesConcurrent(proxies) {
  console.log(colors.cyan(`==> Testing ${proxies.length} proxies (concurrency: ${CONCURRENCY}, timeout: ${TIMEOUT}ms)...\n`));

  const alive = [];
  const dead = [];
  let tested = 0;
  const total = proxies.length;
  const startTime = Date.now();

  // Process in batches
  for (let i = 0; i < proxies.length; i += CONCURRENCY) {
    const batch = proxies.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (proxy) => {
        const isAlive = await testProxy(proxy);
        return { proxy, isAlive };
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.isAlive) {
          alive.push(r.value.proxy);
        } else {
          dead.push(r.value.proxy);
        }    } else {
          dead.push(r.status === 'fulfilled' ? r.value.proxy : "unknown");
        }
    }

    tested += batch.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = ((alive.length / tested) * 100).toFixed(1);
    process.stdout.write(
      `  ${colors.gray(`[${elapsed}s]`)} Tested: ${colors.yellow(tested)}/${total} | ` +
      `${colors.green(`Alive: ${alive.length}`)} | ${colors.red(`Dead: ${dead.length}`)} | ` +
      `${colors.cyan(`Rate: ${rate}%`)}\r`
    );
  }

  console.log("\n");
  return alive;
}

function saveProxies(proxies) {
  fs.writeFileSync(PROXY_FILE, proxies.join("\n") + "\n");
  console.log(colors.green(`  ==> Saved ${proxies.length} alive proxies to proxy.txt`));
}

async function main() {
  console.log(colors.bold(colors.green("\n  ╔══════════════════════════════╗")));
  console.log(colors.bold(colors.green("  ║   NETH ORION Proxy Generator ║")));
  console.log(colors.bold(colors.green("  ╚══════════════════════════════╝")));

  const proxies = await collectAllProxies();

  if (proxies.length === 0) {
    console.log(colors.red("  No proxies collected from any source.\n"));
    return;
  }

  const alive = await testProxiesConcurrent(proxies);

  if (alive.length > 0) {
    saveProxies(alive);
    console.log(colors.cyan(`  Success rate: ${((alive.length / proxies.length) * 100).toFixed(1)}%\n`));
  } else {
    console.log(colors.red("  No alive proxies found. Try again later.\n"));
  }
}

main().catch((err) => {
  console.error(colors.red(`Error: ${err.message}`));
});
