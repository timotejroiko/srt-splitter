"use strict";

/**
 * All default settings in one place, grouped by what they affect. The
 * --source URL carries identity only (host, port, ?streamid=); all tuning
 * is CLI/env with upstream-/downstream- prefixes, in milliseconds. Edit
 * values here for permanent changes.
 *
 * Buffer sizing (all in bytes; libsrt aligns to payload multiples):
 * - Upstream RCVBUF is the shock absorber: this loop stalls reads while
 *   fanning out N writes, so depth here is what survives a burst.
 *   8MB holds ~2s @ 30 Mbps of not-yet-delivered data.
 * - UDP_SNDBUF stock default is only 64KB (~17ms @ 30 Mbps); 1MB is the
 *   one meaningful raise, it covers egress burst absorption per client.
 * - All values stay under the FC cap (25600 bufs ~= 37MB): receiver
 *   buffers must not exceed SRTO_FC.
 */
module.exports = {
	// ---- shared ----
	mode: "caller", // caller (we dial out) | listener (source dials in)
	peerIdleTimeout: 5000, // ms, dead-peer detection (--peer-idle-timeout=; lower = faster failover)
	statsIntervalSec: 60, // periodic throughput/health log; 0 = off
	backlog: 128, // downstream listen backlog, burst accepts (--backlog=)
	maxClients: 30, // downstream client cap; excess refused (--max-clients=)

	// ---- upstream ----
	upstreamLatency: 120, // TSBPD buffering on ingest, ms (--upstream-latency=; raise for lossy source path)
	callerBindHost: undefined, // local NIC for caller connect (--caller-bind-host=); undefined = system default
	upstreamConnTimeout: 3000, // ms, caller connect timeout, caller mode only (--upstream-conn-timeout=)
	streamId: undefined, // string SRT stream id, caller mode only (?streamid=); undefined = off
	upstreamPassphrase: undefined, // decrypts ingest (--upstream-passphrase=); undefined = expect clear
	upstreamPbKeyLen: 16, // AES key bytes: 16|24|32 (--upstream-pb-key-len=); used when upstreamPassphrase set
	rcvBuf: 8 * 1024 * 1024, // libsrt receive buffer (upstream shock absorber)
	upstreamSndBuf: 1 * 1024 * 1024, // libsrt send buffer (upstream, control/NAK only)
	udpRcvBuf: 8 * 1024 * 1024, // kernel UDP receive buffer (upstream)
	upstreamUdpSndBuf: 1 * 1024 * 1024, // kernel UDP send buffer (upstream, control only)

	// ---- downstream ----
	listenHost: "0.0.0.0", // client bind interface (--listen-host=)
	listenPort: 9001, // client bind port (--listen-port=)
	downstreamLatency: 120, // TSBPD floor imposed on clients, ms (--downstream-latency=; raise for lossy client paths)
	downstreamPassphrase: undefined, // encrypts egress (--downstream-passphrase=); undefined = serve clear
	downstreamPbKeyLen: 16, // AES key bytes: 16|24|32 (--downstream-pb-key-len=); used when downstreamPassphrase set
	sndBuf: 4 * 1024 * 1024, // libsrt send buffer, per egress client (--snd-buf=)
	udpSndBuf: 1 * 1024 * 1024, // kernel UDP send buffer, per egress client (--udp-snd-buf=)
	egressRcvBuf: 1 * 1024 * 1024, // libsrt receive buffer, per egress client, control only (--egress-rcv-buf=)
	egressUdpRcvBuf: 1 * 1024 * 1024, // kernel UDP receive buffer, per egress client, control only (--egress-udp-rcv-buf=)
};
