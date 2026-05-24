const fs = require("fs");
const net = require("net");
const path = require("path");
const { request, ProxyAgent } = require("undici");

const PROXY_FILE = path.join(__dirname, "proxy.txt");
const TEST_URL = process.env.TEST_URL || "https://httpbin.org/ip";
const CONCURRENCY = parseInt(process.env.CONCURRENCY, 10) || 400;
const TCP_TIMEOUT = parseInt(process.env.TCP_TIMEOUT, 10) || 1200;
const HTTP_TIMEOUT = parseInt(process.env.HTTP_TIMEOUT, 10) || 2500;

const colors = {
  red: (t) => `\x1b[31m${t}\x1b[0m`,
  green: (t) => `\x1b[32m${t}\x1b[0m`,
  yellow: (t) => `\x1b[33m${t}\x1b[0m`,
  cyan: (t) => `\x1b[36m${t}\x1b[0m`,
  gray: (t) => `\x1b[90m${t}\x1b[0m`,
  bold: (t) => `\x1b[1m${t}\x1b[0m`,
};

const SOURCES = [
  "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
  "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt",
  "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
  "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt",
  "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt",
];

async function fetchProxiesFromSource(url) {
  try {
    const res = await request(url, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.body.text();
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    return lines.filter((l) => /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/.test(l));
  } catch {
    return [];
  }
}

async function collectAllProxies() {
  console.log(colors.cyan("\n==> Collecting proxies from free sources...\n"));

  const results = await Promise.allSettled(
    SOURCES.map(async (url) => {
      const name = url.split("/").slice(-1)[0];
      process.stdout.write(`  Fetching ${colors.gray(name)}... `);
      const proxies = await fetchProxiesFromSource(url);
      console.log(colors.green(`${proxies.length} proxies`));
      return proxies;
    })
  );

  const allProxies = new Set();
  for (const r of results) {
    if (r.status === "fulfilled") {
      for (const p of r.value) allProxies.add(p);
    }
  }

  const proxyList = [...allProxies];
  console.log(`\n  ${colors.bold("Total unique proxies collected:")} ${colors.cyan(proxyList.length)}\n`);
  return proxyList;
}

function tcpConnect(proxy) {
  return new Promise((resolve) => {
    const [host, port] = proxy.split(":");
    const socket = new net.Socket();
    socket.setTimeout(TCP_TIMEOUT);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => { socket.destroy(); resolve(false); });
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(parseInt(port, 10), host);
  });
}

async function testProxy(proxy) {
  if (!(await tcpConnect(proxy))) return false;
  try {
    const agent = new ProxyAgent(`http://${proxy}`);
    const res = await request(TEST_URL, {
      dispatcher: agent,
      method: "GET",
      signal: AbortSignal.timeout(HTTP_TIMEOUT),
    });
    if (res.statusCode !== 200) return false;
    const body = await res.body.json();
    return !!body?.origin;
  } catch {
    return false;
  }
}

async function testProxiesConcurrent(proxies, ws) {
  console.log(colors.cyan(`==> Testing ${proxies.length} proxies (concurrency: ${CONCURRENCY}, tcp: ${TCP_TIMEOUT}ms, http: ${HTTP_TIMEOUT}ms)...\n`));

  let alive = 0;
  let tested = 0;
  const total = proxies.length;
  const startTime = Date.now();

  for (let i = 0; i < proxies.length; i += CONCURRENCY) {
    const batch = proxies.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((proxy) =>
        testProxy(proxy).then((isAlive) => ({ proxy, isAlive }))
      )
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value.isAlive) {
        alive++;
        ws.write(r.value.proxy + "\n");
      }
    }

    tested += batch.length;
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = ((alive / tested) * 100).toFixed(1);
    process.stdout.write(
      `  ${colors.gray(`[${elapsed}s]`)} Tested: ${colors.yellow(tested)}/${total} | ` +
      `${colors.green(`Alive: ${alive}`)} | ${colors.red(`Dead: ${tested - alive}`)} | ` +
      `${colors.cyan(`Rate: ${rate}%`)}\r`
    );
  }

  console.log("\n");
  return alive;
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

  const ws = fs.createWriteStream(PROXY_FILE, { flags: "w" });
  const alive = await testProxiesConcurrent(proxies, ws);
  ws.end();

  if (alive > 0) {
    console.log(colors.green(`  ==> Wrote ${alive} alive proxies to proxy.txt`));
    console.log(colors.cyan(`  Success rate: ${((alive / proxies.length) * 100).toFixed(1)}%\n`));
  } else {
    console.log(colors.red("  No alive proxies found. Try again later.\n"));
  }
}

main().catch((err) => {
  console.error(colors.red(`Error: ${err.message}`));
});
