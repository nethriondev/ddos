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

function loadProxies() {
  try {
    const raw = fs.readFileSync(PROXY_FILE, "utf-8");
    return raw.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
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

async function testProxies(proxies) {
  console.log(colors.cyan(`  Testing against ${TEST_URL} (concurrency: ${CONCURRENCY}, tcp: ${TCP_TIMEOUT}ms, http: ${HTTP_TIMEOUT}ms)\n`));

  const deadProxies = new Set();
  const alive = [];
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

    let batchDead = 0;
    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value.isAlive) {
          alive.push(r.value.proxy);
        } else {
          deadProxies.add(r.value.proxy);
          batchDead++;
        }
      }
    }

    if (batchDead > 0) {
      const remaining = proxies.filter((p) => !deadProxies.has(p));
      fs.writeFileSync(PROXY_FILE, remaining.join("\n") + "\n");
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

  const alive = await testProxies(proxies);
  const removed = proxies.length - alive.length;

  console.log("\n");
  console.log(colors.cyan("  ═══════ RESULTS ═══════"));
  console.log(`  ${colors.green(`Alive:  ${alive.length}`)}`);
  console.log(`  ${colors.red(`Dead:   ${removed}`)}`);
  console.log(`  ${colors.cyan(`Alive rate: ${((alive.length / proxies.length) * 100).toFixed(1)}%`)}`);

  if (removed > 0 && alive.length > 0) {
    console.log(colors.green(`\n  ==> ${removed} dead proxies removed as they were found. ${alive.length} alive remain.`));
  } else if (alive.length === proxies.length) {
    console.log(colors.green(`\n  ==> All ${alive.length} proxies are alive. Nothing to remove.`));
  } else if (alive.length === 0) {
    console.log(colors.red(`\n  ==> All ${proxies.length} proxies are dead.`));
  }

  console.log("");
}

main().catch((err) => {
  console.error(colors.red(`Error: ${err.message}`));
});
