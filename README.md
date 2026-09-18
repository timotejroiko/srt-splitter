# srt-splitter

`srt-splitter` receives one SRT stream and relays it to multiple SRT clients.

It uses a single upstream connection and accepts downstream client connections on a local SRT listener. The upstream can be reached in caller mode, or it can connect to the splitter in listener mode.

## Requirements

- Node.js 18 or newer
- An SRT-compatible source
- Network access between the source, splitter, and downstream clients

Prebuilt native addons are included for:

- Linux x64
- Linux arm64
- macOS arm64
- Windows x64

## Install

Install directly from GitHub:

```bash
npm install timotejroiko/srt-splitter
```

From a checkout:

```bash
git clone https://github.com/timotejroiko/srt-splitter.git
cd srt-splitter
npm ci
```

## Basic usage

### Caller mode

Caller mode is the default. The splitter connects to the upstream source and listens for downstream clients on port `9001`.

```bash
npx srt-splitter \
  --source srt://192.168.1.10:9000 \
  --listen-host 0.0.0.0 \
  --listen-port 9001
```

Clients can then connect to:

```text
srt://192.168.1.20:9001
```

The equivalent command from a checkout is:

```bash
npm start -- \
  --source srt://192.168.1.10:9000 \
  --listen-host 0.0.0.0 \
  --listen-port 9001
```

### Listener mode

In listener mode, the upstream source connects to the splitter. Bind the upstream listener to all interfaces with `0.0.0.0`:

```bash
npx srt-splitter \
  --mode listener \
  --source srt://0.0.0.0:9000 \
  --listen-port 9001
```

The source connects to `srt://splitter.example.com:9000`; downstream clients connect to `srt://splitter.example.com:9001`.

## Common options

```text
--source srt://HOST:PORT       Upstream endpoint; required
--mode caller|listener         Upstream connection mode; default: caller
--listen-host IP               Downstream bind address; default: 0.0.0.0
--listen-port N                Downstream port; default: 9001
--max-clients N                Maximum downstream clients; default: 30
--upstream-latency MS          Upstream SRT latency; default: 120
--downstream-latency MS        Downstream SRT latency; default: 120
--upstream-passphrase STR      Decrypt the upstream stream
--downstream-passphrase STR    Encrypt downstream streams
--stats-interval S             Periodic health log interval; 0 disables it
--help                         Show all options
```

Show the complete option list with:

```bash
npx srt-splitter --help
```

The `--source` URL carries the upstream host, port, and optional `streamid` query parameter. Tuning options are supplied as flags or environment variables. CLI options take precedence over environment variables, which take precedence over the defaults in `config.js`.

Example with tuning and a stream ID:

```bash
npx srt-splitter \
  --source "srt://source.example.com:9000?streamid=live" \
  --listen-host 127.0.0.1 \
  --listen-port 9001 \
  --max-clients 10 \
  --upstream-latency 200 \
  --downstream-latency 200
```

Buffer options accept byte values with `k`, `m`, or `g` suffixes, for example `--rcv-buf 16m`.

## Environment variables

Every configurable CLI option has an environment-variable equivalent. Examples:

```bash
SOURCE=srt://source.example.com:9000
LISTEN_HOST=0.0.0.0
LISTEN_PORT=9001
MAX_CLIENTS=30
UPSTREAM_LATENCY=120
DOWNSTREAM_LATENCY=120
```

The full mapping is shown by `npx srt-splitter --help`. Use CLI flags when a value must override the environment.

## Security

The downstream listener is unauthenticated by default. Any host that can reach `LISTEN_HOST:LISTEN_PORT` can consume the stream.

For a local-only listener:

```bash
npx srt-splitter \
  --source srt://source.example.com:9000 \
  --listen-host 127.0.0.1
```

For network access, restrict the listener port with a firewall and configure `--downstream-passphrase` when downstream encryption is required. Use `--upstream-passphrase` when the upstream source is encrypted.

Passphrases must be 10–79 UTF-8 bytes, and encryption key lengths are `16`, `24`, or `32` bytes:

```bash
npx srt-splitter \
  --source srt://source.example.com:9000 \
  --upstream-passphrase 'upstream-secret' \
  --downstream-passphrase 'downstream-secret' \
  --upstream-pb-key-len 16 \
  --downstream-pb-key-len 16
```

## Building the native addon

The repository disables npm install scripts. After installing dependencies, build the native addon explicitly:

```bash
npm ci
npm run setup
```

To create or refresh the checked-in platform prebuild for the current environment:

```bash
npm run prebuild
```

The application loads a matching file from `prebuilds/<platform>-<arch>/srt.node` when one is available.

## Stopping the relay

`SIGINT`, `SIGTERM`, and `SIGHUP` trigger a graceful shutdown:

```bash
Ctrl+C
```
