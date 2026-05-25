# NETH ORION DDoS v4.0

A multi-threaded stress testing tool. Just point it at a URL and it floods the target with HTTP, UDP, TCP, WebSocket, and Socket.IO traffic all at once. Comes with a CLI, API, proxy support, and auto-resume if it crashes.

> **Only use this on targets you own or have written permission to test.**

---

## Effectiveness

| Attack Layer | What It Does | Effectiveness |
|---|---|---|
| **HTTP Flood** | Sends thousands of requests per second using keep-alive connections, cache-busting, and randomized browser profiles | ⭐⭐⭐⭐⭐ **Very effective** — tricks CDNs and WAFs into thinking requests are real browsers |
| **UDP Flood** | Saturates the target IP with UDP packets from all threads simultaneously | ⭐⭐⭐⭐ **Strong** — eats bandwidth on the network layer |
| **Raw TCP Flood** | Opens thousands of raw TCP connections with HTTP GET requests, then immediately kills them | ⭐⭐⭐⭐ **Strong** — burns connection tables and CPU on the target |
| **Proxy Rotation** | Mixes proxies with direct connections — each thread picks randomly | ⭐⭐⭐ **Moderate** — helps bypass IP-based rate limits |
| **L7 Bypass Engine** | Mimics real Chrome/Firefox browsers — TLS fingerprints, Sec-* headers, cookies, request timing jitter | ⭐⭐⭐⭐⭐ **Very effective** — bypasses Cloudflare and most WAFs |
| **Media Stress** | Auto-detects video/audio/images and sends byte-range requests + cache-busting headers to force disk I/O | ⭐⭐⭐⭐ **Strong** — crushes media servers by forcing disk seeks and large responses |
| **WebSocket Flood** | Opens persistent WS connections per thread, sends random binary frames (1KB-64KB) every 20-170ms, auto-reconnects | ⭐⭐⭐⭐ **Strong** — 1000 threads = 1000 persistent connections eating server memory + file descriptors |
| **Socket.IO Flood** | Connects via HTTP long-polling then upgrades to WS, emits random events with large JSON payloads | ⭐⭐⭐⭐⭐ **Devastating** — polling handshake generates extra HTTP requests, JSON event routing is CPU-intensive |
| **Target Queue** | Attack multiple targets one after another, up to 20 queued | Useful for automation, not directly an attack layer |

**Bottom line:** The tool hits the target from 5 layers (L4 UDP + L4 TCP + L7 HTTP + WebSocket + Socket.IO) all at once on every thread. Against most servers, this is overwhelming. Against CDN-protected targets, the L7 bypass engine and proxy rotation help you get through.

---

## Quick Start

```bash
git clone https://github.com/nethriondev/ddos
cd ddos
npm install

# Launch
npm start
```

Then type `help` at the prompt to see commands, or hit the API at `http://localhost:25694`.

---

## Features In Plain English

- **All 5 layers hit at once** — each thread runs UDP + TCP + HTTP + WebSocket + Socket.IO floods simultaneously
- **Auto-detects media** — if the target serves video/audio/images, it sends extra nasty headers (byte-range requests, ETag checks) to force disk I/O and large responses
- **WebSocket flood** — opens persistent connections on every thread, sends random binary frames non-stop
- **Socket.IO flood** — connects via polling + upgrades to WS, spams random events with JSON payloads
- **Bypasses Cloudflare** — mimicks real browsers so WAFs don't block you
- **Uses proxies** — mixes direct connections with SOCKS5/HTTP proxies to dodge IP bans
- **Auto-resume** — if it crashes, it picks up where it left off
- **Target queue** — add multiple URLs, they attack one after another
- **Public tunnel** — exposes the API so you can control it from anywhere
- **CLI + API** — type commands or use curl

---

## Files You Need To Know

| File | What It Does |
|---|---|
| `ddos.js` | The main attack engine — this is what runs |
| `index.js` | Spawns ddos.js and restarts it if it crashes |
| `proxy.txt` | List of proxies (one per line). Create it manually or use the generator |
| `proxy_gen.js` | Scrapes free proxies from the internet and tests them |
| `proxy_cleaner.js` | Removes dead proxies from your list |
| `reset.sh` | Kills all processes and clears saved state |

---

## Configuration

Create a `.env` file (or just use defaults):

| Variable | Default | What It Does |
|---|---|---|
| `MAX_THREADS` | `1000` | How many threads to attack with. Higher = more pressure |
| `PER_THREAD` | `3` | Requests per thread per cycle |
| `UDP_FLOOD` | `true` | Set to `false` to turn off UDP flooding |
| `RAW_TCP` | `true` | Set to `false` to turn off TCP flooding |
| `KEEP_ALIVE` | `true` | Keep connections open (faster). Set to `false` if servers block it |
| `L7_BYPASS` | `true` | Browser mimicry. Set to `false` for simpler requests |
| `WS_FLOOD` | `true` | Set to `false` to turn off WebSocket flood |
| `SOCKETIO_FLOOD` | `true` | Set to `false` to turn off Socket.IO flood |
| `MAX_QUEUE` | `20` | Max targets you can queue up |
| `PORT` | `25694` | Local API port |

---

## Commands

| Command | What It Does |
|---|---|
| `start https://target.com 2` | Attack for 2 hours |
| `add https://target2.com 1` | Add another target to the queue |
| `stop` | Stop everything |
| `status` | See what's happening (requests/sec, status codes) |
| `queue` | See queued targets |
| `help` | List all commands |

### API (same thing via curl)

```bash
curl "http://localhost:25694/stresser?url=https://target.com&duration=2"
curl "http://localhost:25694/stop"
curl "http://localhost:25694/status"
```

---

## Proxies (Optional)

**Get fresh proxies:**
```bash
node proxy_gen.js
```

This scrapes free proxy lists, tests them, and saves working ones to `proxy.txt`.

**Clean dead proxies:**
```bash
node proxy_cleaner.js
```

Without proxies, it still works — just uses direct connections.

---

## Troubleshooting

**Port in use?**
```bash
lsof -i :25694   # Find what's using it
kill -9 <PID>    # Kill it
```

**Everything stuck?** Nuclear reset:
```bash
bash reset.sh
```

---

## License

MIT
