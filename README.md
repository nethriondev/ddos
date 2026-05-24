# NETH ORION DDoS v3.0

A multi-threaded HTTP stress testing tool with a CLI interface, REST API, proxy rotation, target queuing, and automatic public tunnel exposure.

> **Disclaimer:** This tool is intended for authorized security testing and research only. You must have explicit permission from the target owner before use. Misuse may violate applicable laws.

---

## Features

- **Multi-threaded Attacks** — Configurable thread count (default: 1,000) for concurrent request flooding
- **Proxy Rotation** — Loads proxies from `proxy.txt` and supports both HTTP and SOCKS5 proxies
- **Proxy Management** — Built-in scripts to generate fresh proxies (`proxy_gen.js`) and remove dead ones (`proxy_cleaner.js`)
- **Target Queue** — Add up to `MAX_QUEUE` targets; attacks run sequentially through the queue
- **Cache Busting** — Random URL parameters and headers to bypass caching layers
- **Custom Cipher Suites** — Configurable TLS cipher selection for varied request fingerprints
- **State Persistence** — Attack state is saved to `attackState.json` and resumes automatically on restart
- **CLI Interface** — Interactive command-line with colored output
- **REST API** — HTTP endpoints to start, stop, and monitor attacks remotely
- **Public Tunnel** — Auto-exposes the API via cloudflared (nport.link) for remote access
- **Auto-Restart** — Spawner process (`index.js`) restarts the main process if it crashes

---

## Installation

```bash
git clone https://github.com/nethriondev/ddos
cd ddos
npm install
```

### Prerequisites

- **Node.js** (v18+ recommended)
- **cloudflared** (optional, for public tunnel) — install via `npm install -g cloudflared` or the tool will auto-use `npx`

---

## Proxy Management

The project includes two standalone scripts for keeping your proxy list fresh and functional.

### Proxy Generator

Collects fresh proxies from public free proxy lists, tests each one, and saves only the alive ones to `proxy.txt`:

```bash
node proxy_gen.js
```

Fetches from 5 GitHub raw sources, deduplicates, and tests each proxy against a verification URL with a configurable timeout (default: 8s, concurrency: 50). Output:

```
  ╔══════════════════════════════╗
  ║   NETH ORION Proxy Generator ║
  ╚══════════════════════════════╝

==> Collecting proxies from free sources...

  Fetching http.txt... 764 proxies
  Fetching http.txt... 412 proxies
  ...

==> Testing 1200 proxies (concurrency: 50, timeout: 8000ms)...

  [12.4s] Tested: 1200/1200 | Alive: 89 | Dead: 1111 | Rate: 7.4%

  ==> Saved 89 alive proxies to proxy.txt
  Success rate: 7.4%
```

### Proxy Cleaner

Examines every proxy already in `proxy.txt`, removes the dead ones, and keeps only the working ones. Creates a backup (`proxy.txt.bak`) before overwriting:

```bash
node proxy_cleaner.js
```

Output:

```
  ╔═══════════════════════════════╗
  ║   NETH ORION Proxy Cleaner    ║
  ╚═══════════════════════════════╝

  Loaded 300 proxies from proxy.txt

  [8.2s] Tested: 300/300 | Alive: 12 | Dead: 288

  ═══════ RESULTS ═══════
  Alive:  12
  Dead:   288
  Alive rate: 4.0%

  Backup saved: proxy.txt.bak
  ==> 288 dead proxies removed, 12 alive kept in proxy.txt
```

> **Tip:** Both scripts respect the `TEST_URL` environment variable (default: `https://httpbin.org/ip`) to change the verification endpoint.

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
| `PER_THREAD` | `3` | Requests sent per thread per cycle |
| `MAX_QUEUE` | `3` | Maximum queued targets |
| `NPORT` | `ddos` | Subdomain for the public tunnel |
| `CIPHER_INDEX` | `2` | TLS cipher suite index (0–4) |
| `PID` | — | Set to `0` to disable auto-restart |

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

`index.js` is the launcher that auto-restarts `ddos.js` if it crashes. To disable auto-restart:

```bash
PID=0 node index.js
```

### CLI Commands

Once running, use the interactive CLI:

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
| `GET /queue` | Get queue details as JSON |

**Example:**

```bash
curl "http://localhost:25694/stresser?url=https://example.com&duration=2"
```

### Public Tunnel

The tool automatically creates a public tunnel via [nport.link](https://nport.link) (powered by cloudflared). The tunnel URL is displayed at startup. Use it to control the tool remotely:

```bash
curl "https://ddos.nport.link/stresser?url=https://example.com&duration=1"
```

---

## Architecture

```
index.js                 # Spawner — auto-restarts ddos.js on crash
  └── ddos.js            # Main application
        ├── Express API  # REST endpoints for remote control
        ├── CLI (readline) # Interactive terminal interface
        ├── Attack Engine # Multi-threaded HTTP flood via proxies
        ├── Queue System  # Sequential target processing
        ├── State Manager # Persists/restores attack state to disk
        └── nport.js      # cloudflared tunnel for public access

proxy_gen.js             # Scrapes free proxy lists → saves alive proxies to proxy.txt
proxy_cleaner.js         # Tests proxies in proxy.txt → removes dead ones
```

### How It Works

1. The server starts and loads previously saved state (`attackState.json`)
2. If a tunnel is configured, it exposes the API publicly via cloudflared
3. On `start`, threads are spawned — each thread picks a random proxy and sends `PER_THREAD` requests per cycle
4. Each request includes cache-busting parameters, randomized headers, and a spoofed `X-Forwarded-For` IP
5. Attack state is saved to disk so it survives a restart
6. When a target expires, the next target from the queue begins automatically
7. `index.js` monitors the main process and restarts it if it exits unexpectedly

---

## Reset

To kill all running processes and clear saved state in one go:

```bash
bash reset.sh
```

Example output:

```
==> Killing spawner (index.js)...
    No index.js process found.
==> Killing attack process (ddos.js)...
    No ddos.js process found.
==> Removing saved state...
    No state file to remove.
==> Reset complete.
```

The script first terminates `index.js` (the spawner), then `ddos.js` (the attack process), and finally removes `attackState.json` to ensure no state is rewritten after cleanup.

---

## Author

**Kenneth Panio** — [GitHub](https://github.com/nethriondev)

---

## License

MIT
