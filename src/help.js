"use strict";

function printHelp() {
	console.log(`srt-splitter: one SRT source -> many SRT clients

Usage:
  node index.js --source srt://HOST:PORT [flags]

Flags (env in parens; config.js holds defaults, CLI wins):
  --source URL            upstream identity (SOURCE, required): host, port,
                          optional ?streamid= (caller mode only). Caller mode
                          dials the remote host. Listener mode binds the local
                          host and port; empty host means 0.0.0.0
                          (e.g. srt://:9000). Hostnames resolve to IPv4;
                          IPv6 is not supported by the native binding.
                          The URL only carries streamid. Known removed
                          tuning parameters in the query are rejected;
                          unknown parameters are ignored for URL compatibility.
  --mode caller|listener  we dial out, or source dials in (MODE)
  --peer-idle-timeout MS  dead-peer detection (PEER_IDLE_TIMEOUT)
  --stats-interval S      periodic throughput log; 0 = off (STATS_INTERVAL, 60)
  Upstream (ingest, ms):
  --upstream-latency MS   TSBPD buffering on ingest (UPSTREAM_LATENCY)
  --upstream-conn-timeout MS  caller connect timeout, caller mode only (UPSTREAM_CONN_TIMEOUT)
  --upstream-passphrase STR  decrypts ingest, 10-79 UTF-8 bytes (UPSTREAM_PASSPHRASE)
  --upstream-pb-key-len 16|24|32  AES key bytes (UPSTREAM_PBKEYLEN, 16)
  --caller-bind-host IP   local literal IPv4 for caller connect (CALLER_BIND_HOST); else system default
  --rcv-buf SIZE          libsrt receive buffer, upstream shock absorber (RCV_BUF)
  --upstream-snd-buf SIZE libsrt send buffer, upstream control only (UPSTREAM_SND_BUF)
  --udp-rcv-buf SIZE      kernel UDP receive buffer, upstream (UDP_RCV_BUF)
  --upstream-udp-snd-buf SIZE kernel UDP send buffer, upstream (UPSTREAM_UDP_SND_BUF)
  Downstream (clients):
  --listen-host IP        client-facing literal IPv4 bind (LISTEN_HOST)
  --listen-port N         client-facing port (LISTEN_PORT)
  --downstream-latency MS TSBPD floor imposed on clients (DOWNSTREAM_LATENCY)
  --downstream-passphrase STR  encrypts egress, 10-79 UTF-8 bytes (DOWNSTREAM_PASSPHRASE)
  --downstream-pb-key-len 16|24|32  AES key bytes (DOWNSTREAM_PBKEYLEN, 16)
  --snd-buf SIZE          libsrt send buffer per egress client (SND_BUF)
  --udp-snd-buf SIZE      kernel UDP send buffer per client (UDP_SND_BUF)
  --egress-rcv-buf SIZE   libsrt receive buffer per client (EGRESS_RCV_BUF)
  --egress-udp-rcv-buf SIZE kernel UDP receive buffer per client (EGRESS_UDP_RCV_BUF)
  --backlog N             downstream listen backlog (BACKLOG)
  --max-clients N         downstream client cap; excess refused (MAX_CLIENTS, 30)

Note: the client listener is unauthenticated; anyone who can reach it
can consume the stream. Bind LISTEN_HOST to loopback or firewall the port.

Effective delay per direction is max(RCVLATENCY, peer's PEERLATENCY),
negotiated at handshake; each side's --*-latency sets both values on
its sockets. streamid is caller-mode only.

Sizes accept k/m/g suffix, e.g. --rcv-buf 16m.`);
}

module.exports = { printHelp };
