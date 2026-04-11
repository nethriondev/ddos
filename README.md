# DDoS Attack Tool

Botnet tool with API and CLI for stress testing.

## Installation

```sh
git clone https://github.com/nethriondev/ddos
cd ddos
npm install
```

Create `proxy.txt` and `ua.txt` files in the project directory.

## Usage

### Start
```sh
node index.js
```

### CLI Commands
```
start <url> [hours]  - Start attack
stop                 - Stop all attacks
status               - Show status
add <url> [hours]    - Add target
remove <url>         - Remove target
help                 - Show help
exit                 - Exit
```

### API Endpoints
```
GET /stresser?url=<url>&duration=<hours>
GET /stop
GET /status
```

## Proof

![Attack Proof 1](https://i.imgur.com/iBxIBkW.jpeg)
![Attack Proof 2](https://i.imgur.com/r8uPGWa.jpeg)
![Attack Proof 3](https://i.imgur.com/OURqG1k.jpeg)

## Requirements
- Node.js
- Proxy list in proxy.txt
- User agents in ua.txt

## License
MIT