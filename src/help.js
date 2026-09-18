"use strict";

function printHelp() {
	console.log(`srt-splitter: one SRT source -> many SRT clients

Usage:
  node index.js --source srt://HOST:PORT?latency=120 [flags]

Flags (env in parens; config.js holds defaults, CLI wins):
  --source URL            upstream source (SOURCE, required)
  --mode caller|listener  we dial out, or source dials in (MODE)
  --source-bind-host      local bind for listener-mode upstream (SOURCE_BIND_HOST)
  --listen-host / --listen-port    client-facing bind (LISTEN_HOST, LISTEN_PORT)
  --rcv-latency MS        my receiver floor; ingest recovery window (RCV_LATENCY)
  --peer-latency MS       demand on far-end receiver; client recovery (PEER_LATENCY)
  --latency MS            legacy shorthand: sets both latencies at once (LATENCY)
  --passphrase STR        SRT encryption passphrase, 10-79 chars (PASSPHRASE)
  --stream-id STR         SRT stream id (STREAM_ID)
  --pb-key-len 16|24|32  AES key bytes, needs passphrase (PBKEYLEN, 16)
  --peer-idle-timeout MS  dead-peer detection (PEER_IDLE_TIMEOUT)
  --linger S              close() block time; 0 = fire-and-forget (LINGER)
  --conn-timeout MS       upstream connect timeout (CONN_TIMEOUT)
  --chunk-size N          read size + declared max send size, 1-1456 (CHUNK_SIZE)
  --rcv-buf SIZE          libsrt receive buffer, upstream shock absorber (RCV_BUF)
  --snd-buf SIZE          libsrt send buffer per egress client (SND_BUF)
  --udp-rcv-buf SIZE      kernel UDP receive buffer, upstream (UDP_RCV_BUF)
  --upstream-snd-buf SIZE libsrt send buffer, upstream control only (UPSTREAM_SND_BUF)
  --upstream-udp-snd-buf SIZE kernel UDP send buffer, upstream (UPSTREAM_UDP_SND_BUF)
  --egress-rcv-buf SIZE   libsrt receive buffer per client (EGRESS_RCV_BUF)
  --egress-udp-rcv-buf SIZE kernel UDP receive buffer per client (EGRESS_UDP_RCV_BUF)
  --reconnect-delay MS    retry delay for binds/connects (RECONNECT_DELAY)
  --epoll-wait MS         epoll block time; caps shutdown lag (EPOLL_WAIT)
  --backlog N             downstream listen backlog (BACKLOG)
  --stats-interval S      periodic throughput log; 0 = off (STATS_INTERVAL, 60)

Note: the client listener is unauthenticated; anyone who can reach it
can consume the stream. Bind LISTEN_HOST to loopback or firewall the port.

Effective delay per direction is max(RCVLATENCY, peer's PEERLATENCY),
negotiated at handshake. srt:// query also takes rcvlatency=/peerlatency=.

Sizes accept k/m/g suffix, e.g. --rcv-buf 16m.`);
}

module.exports = { printHelp };
