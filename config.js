"use strict";

/**
 * All default settings in one place. Edit values here for permanent
 * changes, or override per-run via CLI flags / env (see src/config.js
 * for precedence: CLI > env > srt:// query > these defaults).
 *
 * Buffer sizing (all in bytes; libsrt aligns to payload multiples):
 * - Upstream RCVBUF is the shock absorber: this loop stalls reads while
 *   fanning out N writes, so depth here is what survives a burst.
 *   8MB ~= 2s @ 30 Mbps.
 * - UDP_SNDBUF stock default is only 64KB (~17ms @ 30 Mbps); 1MB is the
 *   one meaningful raise, it covers egress burst absorption per client.
 * - All values stay under the FC cap (25600 bufs ~= 37MB): receiver
 *   buffers must not exceed SRTO_FC.
 */
module.exports = {
	// Upstream source
	mode: "caller", // caller (we dial out) | listener (source dials in)
	sourceBindHost: "0.0.0.0", // local bind for listener-mode upstream

	// SRT session: TSBPD playout delay, ms. RCV = my receiver's floor;
	// PEER = demand placed on the far end's receiver. Negotiated per
	// direction as max(RCVLATENCY, peer's PEERLATENCY) at handshake.
	rcvLatency: 120, // loss-recovery window on ingest (raise for lossy source path)
	peerLatency: 120, // playout demand on clients (raise for lossy client paths)
	connTimeout: 3000, // ms, caller connect timeout
	passphrase: undefined, // string, encryption; undefined = off
	streamId: undefined, // string SRT stream id; undefined = off
	pbKeyLen: 16, // AES key bytes: 16|24|32; applied only when passphrase set
	peerIdleTimeout: 5000, // ms, dead-peer detection (lower = faster failover)
	linger: 0, // s, close() block time; TRANSTYPE=LIVE already defaults off, pinned anyway

	// Client-facing listener
	listenHost: "0.0.0.0",
	listenPort: 9001,

	// Payload: read size AND declared max send size (PAYLOADSIZE must match
	// or libsrt rejects/fragments). Live max is 1456; 1316 = MTU-optimal.
	chunkSize: 1316,

	// Socket buffers (bytes; CLI accepts k/m/g suffix, e.g. --rcv-buf 16m).
	// Split by direction: the big values below serve the single upstream
	// socket (RCV side) and each egress client (SND side). The reverse
	// direction carries control traffic only, so the egress* values stay
	// small: per-client memory ~= sndBuf + udpSndBuf + egressRcvBuf +
	// egressUdpRcvBuf (~7MB at defaults, was ~21MB uniform).
	rcvBuf: 8 * 1024 * 1024, // libsrt receive buffer (upstream shock absorber)
	sndBuf: 4 * 1024 * 1024, // libsrt send buffer (per egress client)
	upstreamSndBuf: 1 * 1024 * 1024, // libsrt send buffer (upstream, control/NAK only)
	udpRcvBuf: 8 * 1024 * 1024, // kernel UDP receive buffer (upstream)
	udpSndBuf: 1 * 1024 * 1024, // kernel UDP send buffer (per egress client)
	upstreamUdpSndBuf: 1 * 1024 * 1024, // kernel UDP send buffer (upstream, control only)
	egressRcvBuf: 1 * 1024 * 1024, // libsrt receive buffer (per egress client, control only)
	egressUdpRcvBuf: 1 * 1024 * 1024, // kernel UDP receive buffer (per egress client, control only)

	// Loop timings
	reconnectDelayMs: 1000, // retry delay for binds/connects/listener recreation
	epollWaitMs: 500, // epoll block time; also caps SIGINT shutdown lag
	backlog: 128, // downstream listen backlog (burst accepts)
	upReadTimeoutMs: 1000, // RCVTIMEO backup; reads are non-blocking, see drainMax
	drainMax: 128, // max messages read per upstream wakeup; bounds fanout stall
	statsIntervalSec: 60 // periodic throughput/health log; 0 = off
};
