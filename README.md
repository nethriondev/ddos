# NETH ORION DDoS v3.0

A multi-threaded HTTP stress testing tool with a CLI interface, REST API, proxy rotation, target queuing, and automatic public tunnel exposure.

> **Disclaimer:** This tool is intended for authorized security testing and research only. You must have explicit permission from the target owner before use. Misuse may violate applicable laws.

---

## Features

- **Multi-threaded Attacks** — Configurable thread count (default: 1,000) for concurrent request flooding
- **Proxy Rotation** — Loads proxies from `proxy.txt` and supports both HTTP and SOCKS5 proxies
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

## Configuration

### 1. Proxy List

Create a `proxy.txt` file in the project root with one proxy per line:

```
ip:port
socks5://ip:port
```

Both HTTP and SOCKS5 proxies are supported. Without proxies, attacks will not start.

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

To kill all processes and clear saved state:

```bash
bash reset.sh
```

---

## Author

**Kenneth Panio** — [GitHub](https://github.com/nethriondev)

---

## License

MIT License

Copyright (c) 2025 Kenneth Panio (nethriondev)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
