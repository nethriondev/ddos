# NETH ORION DDoS v4.0

A multi-threaded HTTP/UDP/TCP stress testing tool with a CLI interface, REST API, proxy rotation, target queuing, cluster support, and automatic public tunnel exposure.

> **Disclaimer:** This tool is intended for authorized security testing and research only. You must have explicit permission from the target owner before use. Misuse may violate applicable laws.

---

## Table of Contents

- [Quick Start](#quick-start)
- [Features](#features)
- [Files](#files)
- [Installation](#installation)
- [Proxy Management](#proxy-management)
  - [Proxy Generator](#proxy-generator)
  - [Proxy Cleaner](#proxy-cleaner)
- [Configuration](#configuration)
  - [Proxy List](#1-proxy-list)
  - [Environment Variables](#2-environment-variables)
- [Usage](#usage)
  - [CLI Commands](#cli-commands)
  - [REST API](#rest-api)
  - [Public Tunnel](#public-tunnel)
- [Architecture](#architecture)
  - [How It Works](#how-it-works)
- [Reset](#reset)
- [Troubleshooting](#troubleshooting)
- [Author](#author)
- [License](#license)

---

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/nethriondev/ddos
cd ddos
npm install

# 2. (Optional) Create a .env file with custom config
cp .env.example .env
# Edit .env to adjust settings (MAX_THREADS, PORT, etc.)

# 3. (Optional) Get fresh proxies
node proxy_gen.js

# 4. Launch
npm start
```

Then type `help` at the `neth-orion>` prompt to see available commands, or hit the REST API at `http://localhost:25694`.

---

## Features

- **Multi-threaded Attacks** — Configurable thread count (default: 1,000) for concurrent request flooding
- **Cluster Mode** — Optional multi-core worker forking; enable via `USE_CLUSTER=true`
- **Keep-Alive Connections** — Persistent HTTP/HTTPS sockets for higher throughput; disable via `KEEP_ALIVE=false`
- **UDP Flood Mode** — Layer 4 UDP packet saturation against target IPs; disable via `UDP_FLOOD=false`
- **Raw TCP Flood Mode** — Layer 4 TCP connection bursts with HTTP GET requests; disable via `RAW_TCP=false`
- **Proxy Rotation** — Supports both HTTP and SOCKS5 proxies from `proxy.txt`
- **Proxy Management** — `proxy_gen.js` collects fresh proxies; `proxy_cleaner.js` removes dead ones
- **Target Queue** — Up to `MAX_QUEUE` targets queued and run sequentially
- **Cache Busting** — Random URL parameters and randomized headers
- **L7 Bypass Mode** (`L7_BYPASS=true`) — Browser TLS fingerprint mimicry (custom cipher suites, curves, TLS versions matching Chrome 131 / Firefox 135), full Sec-* header family (Sec-CH-UA, Sec-Fetch-*, etc.), cookie/session persistence for `cf_clearance` tracking, and request timing jitter (50–200ms random delays between cycles)
- **Spoofed IP Headers** — `X-Forwarded-For`, `CF-Connecting-IP`, and `True-Client-IP` randomized per request
- **State Persistence** — Attack state saved to `attackState.json`, auto-resumes on restart
- **CLI Interface** — Interactive command-line with colored output
- **REST API** — HTTP endpoints for remote control
- **Public Tunnel** — Auto-exposes the API via nport.link (cloudflared-powered)
- **Process Spawner** — `index.js` launches `ddos.js` and auto-restarts it on crash

---

## Files

| File | Purpose |
|---|---|
| `index.js` | Spawner — launches `ddos.js` and auto-restarts on crash. Set `PID=0` to disable. |
| `ddos.js` | Main application — Express API, CLI, attack engine with HTTP/UDP/TCP flood modes, queue, state manager |
| `nport.js` | Tunnel client — communicates with `api.nport.link` to get cloudflared tunnel tokens |
| `proxy_gen.js` | Scrapes 5 free proxy sources from GitHub → tests TCP + HTTP → saves alive proxies to `proxy.txt` |
| `proxy_cleaner.js` | Loads proxies from `proxy.txt` → tests each → removes dead ones inline |
| `reset.sh` | Kills all Node processes and removes `attackState.json` |
| `.env.example` | Template for environment variable configuration |

---

## Installation

```bash
git clone https://github.com/nethriondev/ddos
cd ddos
npm install
```

### Prerequisites

- **Node.js** (v18+ recommended)
- **cloudflared** (optional, for public tunnel) — install via `npm install -g cloudflared` or the tool falls back to `npx cloudflared`

---

## Proxy Management

### Proxy Generator

Collects fresh proxies from public free proxy lists, tests each one via TCP connect + HTTP verification, and saves alive ones to `proxy.txt`:

```bash
node proxy_gen.js
```

Fetches from 5 GitHub raw sources, deduplicates, and tests each proxy. Configurable via env vars.

*Example output (yours will vary based on sources and proxy availability):*

```
  ╔══════════════════════════════╗
  ║   NETH ORION Proxy Generator ║
  ╚══════════════════════════════╝

==> Collecting proxies from free sources...

  Fetching http.txt... 764 proxies
  Fetching http.txt... 412 proxies
  ...

==> Testing 1200 proxies (concurrency: 400, tcp: 1200ms, http: 2500ms)...

  [12.4s] Tested: 1200/1200 | Alive: 89 | Dead: 1111 | Rate: 7.4%

  ==> Wrote 89 alive proxies to proxy.txt
  Success rate: 7.4%
```

**Env vars:** `TEST_URL` (default `https://httpbin.org/ip`), `CONCURRENCY` (400), `TCP_TIMEOUT` (1200ms), `HTTP_TIMEOUT` (2500ms)

### Proxy Cleaner

Loads proxies from `proxy.txt`, tests each one, and removes dead ones as they are found:

```bash
node proxy_cleaner.js
```

*Example output:*

```
  ╔═══════════════════════════════╗
  ║   NETH ORION Proxy Cleaner    ║
  ╚═══════════════════════════════╝

  Loaded 300 proxies from proxy.txt
  Testing against https://httpbin.org/ip (concurrency: 400, tcp: 1200ms, http: 2500ms)

  [8.2s] Tested: 300/300 | Alive: 12 | Dead: 288

  ═══════ RESULTS ═══════
  Alive:  12
  Dead:   288
  Alive rate: 4.0%

  ==> 288 dead proxies removed as they were found. 12 alive remain.
```

**Env vars:** Same as proxy_gen.js — `TEST_URL`, `CONCURRENCY`, `TCP_TIMEOUT`, `HTTP_TIMEOUT`

---

## Configuration

### 1. Proxy List

Create a `proxy.txt` file in the project root with one proxy per line:

```
ip:port
socks5://ip:port
```

Both HTTP and SOCKS5 proxies are supported. Without proxies, the tool falls back to direct connections.

### 2. Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `25694` | Local API server port |
| `MAX_THREADS` | `1000` | Number of concurrent attack threads |
| `PER_THREAD` | `3` | Requests sent per thread per attack cycle |
| `MAX_QUEUE` | `20` | Maximum queued targets |
| `NPORT` | `ddos` | Subdomain for the nport.link public tunnel |
| `UDP_FLOOD` | `true` | Enable UDP flood mode; set to `false` to disable |
| `RAW_TCP` | `true` | Enable raw TCP flood mode; set to `false` to disable |
| `KEEP_ALIVE` | `true` | Enable HTTP keep-alive connections; set to `false` to disable |
| `USE_CLUSTER` | `false` | Enable multi-core cluster forking; set to `true` to enable |
| `L7_BYPASS` | `false` | Enable L7 bypass techniques (browser TLS fingerprints, Sec-* headers, cookie persistence, request jitter); set to `true` to enable |
| `PID` | — | Set to `0` to disable auto-restart from `index.js` |

You can set these via command line or a `.env` file:

```bash
# Command line
MAX_THREADS=5000 PER_THREAD=100 node index.js

# Or copy the template and edit
cp .env.example .env
```

---

## Usage

### Start the Application

```bash
node index.js
```

or

```bash
npm start
```

`index.js` runs `ddos.js` with `--no-warnings` and auto-restarts it if it crashes. To disable auto-restart:

```bash
PID=0 node index.js
```

### CLI Commands

Once running, use the interactive CLI (prompt: `neth-orion>`):

| Command | Description |
|---|---|
| `start <url> [hours]` | Start an attack on the target URL |
| `add <url> [hours]` | Add a target to the queue |
| `stop` | Stop all active attacks and clear the queue |
| `status` | Show current attack status and queue |
| `queue` | Display the queued targets only |
| `clear` | Clear the terminal screen |
| `help` | Show available commands |
| `exit` | Exit the application |

**Examples:**

```bash
start https://example.com 2    # Attack for 2 hours
add https://example.org 0.5    # Queue a 30-minute attack
status                         # Check progress
```

### REST API

The server exposes an HTTP API on the configured port (default `25694`):

| Endpoint | Description |
|---|---|
| `GET /stresser?url=<url>&duration=<hours>` | Start an attack |
| `GET /add?url=<url>&duration=<hours>` | Add a target to the queue |
| `GET /stop` | Stop all attacks |
| `GET /status` | Get attack status as JSON |

**Examples:**

```bash
# Start an attack
curl "http://localhost:25694/stresser?url=https://example.com&duration=2"

# Add a target to the queue (if an attack is already running)
curl "http://localhost:25694/add?url=https://example.org&duration=1"

# Stop all attacks
curl "http://localhost:25694/stop"

# Check status
curl "http://localhost:25694/status"
```

**Response examples:**

```json
// GET /stresser
{"success":true,"message":"Attack started on https://example.com"}

// GET /add
{"success":true,"currentQueue":2}

// GET /stop
{"success":true,"totalRequests":45231}

// GET /status
{
  "active": true,
  "currentTarget": "https://example.com",
  "totalRequests": 15234,
  "threads": 1000,
  "queueCount": 3
}
```

### Public Tunnel

The tool automatically creates a public tunnel via [nport.link](https://nport.link) API. `nport.js` requests a tunnel token from `api.nport.link` and spawns cloudflared with it. The tunnel URL is displayed at startup. Use it to control the tool remotely:

```bash
curl "https://ddos.nport.link/stresser?url=https://example.com&duration=1"
```

Tunnel sessions are persisted to `nport_sessions.json` and cleaned up on restart. If cloudflared crashes, the tunnel auto-restarts after 3 seconds.

---

## Architecture

```
index.js                 # Spawner — auto-restarts ddos.js on crash (set PID=0 to disable)
  └── ddos.js            # Main application (cluster-ready via USE_CLUSTER)
        ├── Express API  # REST endpoints: /stresser, /add, /stop, /status
        ├── CLI          # Interactive readline terminal (prompt: neth-orion>)
        ├── Attack Engine # Multi-mode flood engine
        │     ├── HTTP flood   — keep-alive agents (http.Agent/https.Agent with maxSockets=Infinity)
        │     │                 — proxy-based HTTP via undici ProxyAgent
        │     │                 — SOCKS5 proxy via socks-proxy-agent
        │     ├── UDP flood    — dgram socket sending 65KB payloads to target IP:port
        │     └── Raw TCP flood — net.Socket connect + HTTP GET then immediate destroy
        ├── Queue System  # Sequential target processing (up to MAX_QUEUE)
        ├── State Manager # Persists/restores attack state to attackState.json
        └── nport.js      # nport.link tunnel client (cloudflared via API token)

proxy_gen.js             # Fetches from 5 GitHub sources → tests TCP+HTTP → saves alive proxies
proxy_cleaner.js         # Loads proxy.txt → tests each one → removes dead proxies inline
```

### How It Works

1. `index.js` starts `ddos.js` with `--no-warnings` and monitors it for crashes
2. `ddos.js` loads saved state from `attackState.json` and resumes any pending attack
3. If `USE_CLUSTER` is enabled, `ddos.js` forks workers across all CPU cores via the `cluster` module
4. If a tunnel is configured (`NPORT` env var), `nport.js` requests a token from `api.nport.link` and spawns cloudflared
5. On `start`, threads are launched — each thread runs in a loop sending `PER_THREAD` requests per cycle:
   - **HTTP mode**: Uses keep-alive agents (`http.Agent`/`https.Agent` with `keepAlive: true`, `maxSockets: Infinity`) for direct connections, or undici `ProxyAgent`/`socks-proxy-agent` for proxy routing
   - **UDP mode**: Creates a `dgram` socket and sends 65,507-byte payloads to the target IP:port
   - **Raw TCP mode**: Opens `net.Socket` connections, writes an HTTP GET request, then immediately destroys the socket
6. If proxies exist, threads split 50/50 between direct and proxy connections; each proxy thread picks a random entry from `proxy.txt`
7. Every HTTP request includes cache-busting parameters (`_`, `nocache`, `cb`, `r`) and randomized headers (`User-Agent`, `X-Forwarded-For`, `CF-Connecting-IP`, `True-Client-IP`)
8. Attack state is debounce-saved to disk every 500ms and sync-saved on target completion/stop
9. When a target expires, the next target from the queue begins; if the queue is empty, the attack stops
10. `index.js` restarts `ddos.js` on any exit (unless `PID=0`)

---

## Reset

To kill all running processes and clear saved state:

```bash
bash reset.sh
```

Example output:

```
==> Killing NETH ORION processes...
    Processes terminated.
==> Killing parent spawner...
==> Removing saved state...
    State file removed.
==> Reset complete.
```

The script runs `pkill -9 -f "index.js|ddos.js|spawn|child_process"`, then `killall -9 node`, then removes `attackState.json`.

---

## Troubleshooting

### Port already in use

```bash
# Find what's using port 25694
lsof -i :25694
# Kill it, then restart
kill -9 <PID>
npm start
```

### cloudflared not found / tunnel fails

The tool falls back to `npx cloudflared` automatically, but if that also fails:

```bash
# Install cloudflared globally
npm install -g cloudflared
# Or download from: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
```

If you don't need the tunnel at all, just ignore the "Tunnel failed" message — the local API still works.

### Process keeps restarting in a loop

If `ddos.js` crashes immediately, `index.js` will keep restarting it. Kill everything:

```bash
bash reset.sh
```

Then check for errors by running `ddos.js` directly:

```bash
PID=0 node index.js
# or directly:
node ddos.js
```

### Reset stuck or processes lingering

```bash
# Nuclear option — kill all node processes
killall -9 node
# Remove state file
rm -f attackState.json nport_sessions.json
```

---

## Author

**Kenneth Panio** — [GitHub](https://github.com/nethriondev)

---

## License

MIT
