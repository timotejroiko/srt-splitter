"use strict";

/**
 * Core SRT relay: upstream source -> N egress clients.
 * One epoll container drives everything. All calls are blocking sync
 * bindings; the process runs no other event-loop work, so blocking is
 * the idle state, not a stall. Reads are non-blocking (RCVSYN=false)
 * and drained in a bounded loop per wakeup.
 *
 * Facts from the native binding (node-srt.cc) that shape this code:
 * - accept() retires the listen socket (success AND failure paths
 *   srt_close it), so listeners are recreated after any accept attempt.
 *   Recreation on the accept path is immediate; reconnectDelayMs only
 *   throttles retries after a bind failure.
 * - read() is srt_recvmsg: one call = one whole message, so one read
 *   fans out as one write per client and framing is preserved.
 * - srt_close() auto-removes the socket from epoll containers, so
 *   drop paths only need close (binding exposes no epoll-remove).
 * - Listener socket options are inherited by accepted sockets, so the
 *   downstream listener carries the egress buffer profile and the
 *   listener-mode upstream listener carries STREAMID.
 *
 * Slow-client policy: non-blocking sends (SNDSYN=false); any write
 * failure drops that client at the live edge. No per-client buffering.
 */

class Relay {
	constructor(cfg) {
		this.cfg = cfg;
		this.srt = null;
		this.c = null;
		this.running = true;
		this.epid = -1;
		this.downListen = -1;
		this.upListen = -1;
		this.upConn = -1;
		this.lastUpRetry = 0;
		this.lastDownRetry = 0;
		this.egress = new Set();
		this.msgsIn = 0;
		this.bytesIn = 0;
		this.bytesOut = 0;
		this.dropped = 0;
		this.lastStats = Date.now();
		this.lastMsgsIn = 0;
		this.lastBytesIn = 0;
		this.lastBytesOut = 0;
		this.lastCpuUsage = process.cpuUsage();
	}

	init(native) {
		this.srt = native.srt;
		this.c = native.c;
	}

	shutdown() {
		this.running = false;
	}

	log(...a) {
		console.log(new Date().toISOString(), ...a);
	}

	safeClose(fd) {
		try {
			if (fd !== undefined && fd !== null && fd >= 0) {
				this.srt.close(fd);
			}
		} catch {
			// double-close after native auto-close just throws; ignore
		}
	}

	stateOf(fd) {
		try {
			return this.srt.getSockState(fd);
		} catch {
			return -1;
		}
	}

	setOpt(fd, opt, value) {
		try {
			this.srt.setSockOpt(fd, opt, value);
			return true;
		} catch (err) {
			// Never log value: it may be the passphrase.
			this.log(`setSockOpt failed: opt=${opt} type=${typeof value} (${err.message})`);
			return false;
		}
	}

	// Shared live profile. TRANSTYPE=LIVE first: resets the whole live
	// profile (TLPKTDROP, TSBPDMODE, NAKREPORT, congestion) to known
	// state; latency set after. TRANSTYPE is write-only on some builds,
	// so TLPKTDROP is pinned explicitly too. All *_BUF options are
	// pre-bind only: set here.
	applyLiveProfile(fd, o) {
		return (
			this.setOpt(fd, this.c.SRTO_TRANSTYPE, 0) && // SRTT_LIVE
			this.setOpt(fd, this.c.SRTO_TLPKTDROP, true) &&
			this.setOpt(fd, this.c.SRTO_RCVBUF, o.rcvBuf) &&
			this.setOpt(fd, this.c.SRTO_SNDBUF, o.sndBuf) &&
			this.setOpt(fd, this.c.SRTO_UDP_RCVBUF, o.udpRcvBuf) &&
			this.setOpt(fd, this.c.SRTO_UDP_SNDBUF, o.udpSndBuf) &&
			this.setOpt(fd, this.c.SRTO_RCVLATENCY, this.cfg.rcvLatency) &&
			this.setOpt(fd, this.c.SRTO_PEERLATENCY, this.cfg.peerLatency) &&
			this.setOpt(fd, this.c.SRTO_PEERIDLETIMEO, this.cfg.peerIdleTimeout) &&
			this.setOpt(fd, this.c.SRTO_LINGER, this.cfg.linger) &&
			this.setOpt(fd, this.c.SRTO_PAYLOADSIZE, this.cfg.chunkSize) &&
			(!this.cfg.passphrase || this.setOpt(fd, this.c.SRTO_PASSPHRASE, this.cfg.passphrase)) &&
			(!this.cfg.passphrase || this.setOpt(fd, this.c.SRTO_PBKEYLEN, this.cfg.pbKeyLen))
		);
	}

	// Single upstream socket (or listener-mode accept): big RCV side is
	// the shock absorber, SND side carries control traffic only.
	applyUpOpts(fd) {
		return (
			this.applyLiveProfile(fd, {
				rcvBuf: this.cfg.rcvBuf,
				sndBuf: this.cfg.upstreamSndBuf,
				udpRcvBuf: this.cfg.udpRcvBuf,
				udpSndBuf: this.cfg.upstreamUdpSndBuf
			}) && (!this.cfg.streamId || this.setOpt(fd, this.c.SRTO_STREAMID, this.cfg.streamId))
		);
	}

	// Downstream listener; accepted egress sockets inherit these. Big
	// SND side absorbs egress bursts, RCV side is control traffic only.
	applyDownOpts(fd) {
		return this.applyLiveProfile(fd, {
			rcvBuf: this.cfg.egressRcvBuf,
			sndBuf: this.cfg.sndBuf,
			udpRcvBuf: this.cfg.egressUdpRcvBuf,
			udpSndBuf: this.cfg.udpSndBuf
		});
	}

	makeListener(host, port, backlog, applyOpts) {
		let fd = -1;
		try {
			fd = this.srt.createSocket(false);
		} catch (err) {
			this.log("createSocket failed:", err.message);
			return -1;
		}
	if (!this.setOpt(fd, this.c.SRTO_REUSEADDR, true) || !applyOpts(fd)) {
		this.safeClose(fd);
		return -1;
	}
	// Listener accepts must never block: accept() on an empty backlog
	// would stall the whole relay (all reads/writes live on this thread).
	// SRT docs name blocking accept as default; opt-out explicitly.
	this.setOpt(fd, this.c.SRTO_RCVSYN, false);
	try {
		this.srt.bind(fd, host, port);
		this.srt.listen(fd, backlog);
		this.srt.epollAddUsock(this.epid, fd, this.c.EPOLL_IN | this.c.EPOLL_ERR);
	} catch (err) {
		this.log("bind/listen failed:", err.message);
		this.safeClose(fd);
		return -1;
	}
	return fd;
}

	ensureDownListener(now) {
		if (this.downListen >= 0 || !this.running) {
			return;
		}
		if (now - this.lastDownRetry < this.cfg.reconnectDelayMs) {
			return;
		}
		this.lastDownRetry = now;
		this.downListen = this.makeListener(
			this.cfg.listenHost,
			this.cfg.listenPort,
			this.cfg.backlog,
			(fd) => this.applyDownOpts(fd)
		);
		if (this.downListen >= 0) {
			this.log("listening for clients on", this.cfg.listenHost + ":" + this.cfg.listenPort);
		}
	}

	ensureUpListener(now) {
		if (this.cfg.mode !== "listener" || this.upListen >= 0 || this.upConn >= 0 || !this.running) {
			return;
		}
		if (now - this.lastUpRetry < this.cfg.reconnectDelayMs) {
			return;
		}
		this.lastUpRetry = now;
		this.upListen = this.makeListener(
			this.cfg.sourceBindHost,
			this.cfg.sourcePort,
			1,
			(fd) => this.applyUpOpts(fd)
		);
		if (this.upListen >= 0) {
			this.log("waiting for source on", this.cfg.sourceBindHost + ":" + this.cfg.sourcePort);
		}
	}

	ensureUpstreamCaller(now) {
		if (this.cfg.mode !== "caller" || this.upConn >= 0 || !this.running) {
			return;
		}
		if (now - this.lastUpRetry < this.cfg.reconnectDelayMs) {
			return;
		}
		this.lastUpRetry = now;
		let sock = -1;
		try {
			sock = this.srt.createSocket(false);
		} catch (err) {
			this.log("upstream createSocket failed:", err.message);
			return;
		}
		if (!this.applyUpOpts(sock)) {
			this.safeClose(sock);
			return;
		}
		// Non-blocking reads: the drain loop polls until empty instead of
		// stalling on RCVTIMEO. RCVTIMEO stays as a harmless backup.
		this.setOpt(sock, this.c.SRTO_RCVSYN, false);
		this.setOpt(sock, this.c.SRTO_RCVTIMEO, this.cfg.upReadTimeoutMs);
		this.setOpt(sock, this.c.SRTO_CONNTIMEO, this.cfg.connTimeout);
		try {
			this.srt.connect(sock, this.cfg.sourceHost, this.cfg.sourcePort);
		} catch {
			this.safeClose(sock);
			return;
		}
		try {
			this.srt.epollAddUsock(this.epid, sock, this.c.EPOLL_IN | this.c.EPOLL_ERR);
		} catch (err) {
			this.log("upstream epoll add failed:", err.message);
			this.safeClose(sock);
			return;
		}
		this.upConn = sock;
		this.log("upstream connected to", this.cfg.sourceHost + ":" + this.cfg.sourcePort);
	}

	acceptDownstream() {
		let fd = -1;
		try {
			fd = this.srt.accept(this.downListen);
		} catch {
			fd = -1;
		}
		this.downListen = -1;
		// The old listen fd is dead (native closed it): recreate now.
		// Bypassing the retry throttle here is correct; a bind failure
		// inside re-arms it via lastDownRetry.
		this.lastDownRetry = 0;
		this.ensureDownListener(Date.now());
		if (fd === undefined || fd === null || fd < 0) {
			return;
		}
		if (!this.setOpt(fd, this.c.SRTO_SNDSYN, false)) {
			this.safeClose(fd);
			return;
		}
		try {
			this.srt.epollAddUsock(this.epid, fd, this.c.EPOLL_ERR);
		} catch (err) {
			this.log("client epoll add failed:", err.message);
			this.safeClose(fd);
			return;
		}
		this.egress.add(fd);
		this.log("+client fd=" + fd, "n=" + this.egress.size);
	}

	acceptUpstream() {
		let fd = -1;
		try {
			fd = this.srt.accept(this.upListen);
		} catch {
			fd = -1;
		}
		this.safeClose(this.upListen);
		this.upListen = -1;
		if (fd === undefined || fd === null || fd < 0) {
			// Listen fd died with the attempt: recreate without waiting
			// out the bind-retry throttle.
			this.lastUpRetry = 0;
			return;
		}
		// Listener opts (incl. STREAMID) are inherited; reads go
		// non-blocking like the caller path.
		this.setOpt(fd, this.c.SRTO_RCVSYN, false);
		this.setOpt(fd, this.c.SRTO_RCVTIMEO, this.cfg.upReadTimeoutMs);
		try {
			this.srt.epollAddUsock(this.epid, fd, this.c.EPOLL_IN | this.c.EPOLL_ERR);
		} catch (err) {
			this.log("upstream epoll add failed:", err.message);
			this.safeClose(fd);
			return;
		}
		this.upConn = fd;
		this.log("source connected fd=" + fd);
	}

	dropEgress(fd, reason) {
		if (!this.egress.has(fd)) {
			return;
		}
		this.egress.delete(fd);
		this.safeClose(fd);
		this.dropped++;
		this.log("-client fd=" + fd, "(" + reason + ", n=" + this.egress.size + ")");
	}

	dropUpstream(reason) {
		if (this.upConn < 0) {
			return;
		}
		this.safeClose(this.upConn);
		this.upConn = -1;
		this.log("upstream lost (" + reason + "), reconnecting");
	}

	// Bounded drain: one EPOLL_IN wakeup may hold many messages; reading
	// only one per wakeup costs a full epoll round-trip per chunk. The
	// cap bounds fanout stall (N sync writes per message) so a burst
	// can't starve accepts; level-triggered epoll re-fires for the rest.
	drainUpstream() {
		for (let i = 0; i < this.cfg.drainMax; i++) {
			let chunk;
			try {
				chunk = this.srt.read(this.upConn, this.cfg.chunkSize);
			} catch {
				break; // empty (non-blocking) or error; state checked once below
			}
			if (!Buffer.isBuffer(chunk) || chunk.length === 0) {
				break;
			}
			this.msgsIn++;
			this.bytesIn += chunk.length;
			// Same Buffer to every client: sync write copies into libsrt.
			// Direct Set iteration: delete-during-iteration is safe, current fd just dropped.
			for (const fd of this.egress) {
				try {
					if (this.srt.write(fd, chunk) === -1) {
						this.dropEgress(fd, "send failed");
					} else {
						this.bytesOut += chunk.length;
					}
				} catch {
					this.dropEgress(fd, "send error");
				}
			}
		}
		// Single state probe per drain, not per failed read: a clean
		// empty ends here while still connected.
		if (this.upConn >= 0 && this.stateOf(this.upConn) !== this.c.SRTS_CONNECTED) {
			this.dropUpstream("read");
		}
	}

	handleErr(fd) {
		if (fd === this.upConn) {
			if (this.stateOf(fd) !== this.c.SRTS_CONNECTED) {
				this.dropUpstream("epoll-err");
			}
			return;
		}
		if (this.egress.has(fd)) {
			// Transient ERR on a connected client is not fatal; keep it
			// and let the next failed write drop it. Prevents mass
			// disconnects on spurious edge signals.
			if (this.stateOf(fd) !== this.c.SRTS_CONNECTED) {
				this.dropEgress(fd, "epoll-err");
			}
			return;
		}
		if ((fd === this.downListen && this.stateOf(fd) !== this.c.SRTS_LISTENING) ||
			(fd === this.upListen && this.stateOf(fd) !== this.c.SRTS_LISTENING)) {
			this.safeClose(fd);
			if (fd === this.downListen) {
				this.downListen = -1;
			} else {
				this.upListen = -1;
			}
		}
	}

	open() {
		this.epid = this.srt.epollCreate();
		this.downListen = this.makeListener(
			this.cfg.listenHost,
			this.cfg.listenPort,
			this.cfg.backlog,
			(fd) => this.applyDownOpts(fd)
		);
		if (this.downListen < 0) {
			throw new Error("cannot listen on :" + this.cfg.listenPort);
		}
		this.log("listening for clients on", this.cfg.listenHost + ":" + this.cfg.listenPort);
		if (this.cfg.mode === "listener") {
			this.ensureUpListener(Date.now());
		}
	}

	poll() {
		const now = Date.now();
		this.ensureDownListener(now);
		if (this.cfg.mode === "caller") {
			this.ensureUpstreamCaller(now);
		} else {
			this.ensureUpListener(now);
		}
		let events = [];
		try {
			events = this.srt.epollUWait(this.epid, this.cfg.epollWaitMs) || [];
		} catch (err) {
			this.log("epoll:", err.message);
			return;
		}
		for (const ev of events) {
			if (!this.running) {
				break;
			}
			const fd = ev.socket;
			const fl = ev.events;
			// Live routing: accept calls recycle listen fds mid-batch, so
			// stale snapshotted ids would double-accept and churn (or
			// drop) the fresh listener. Stale ids fall through to the ERR
			// check, which ignores unknown fds.
		if (fl & this.c.EPOLL_IN) {
			if (fd === this.downListen) {
				// One accept per wakeup. The native accept() retires the
				// listen socket either way, and a recreated listener has
				// no reliable "backlog empty" signal: epoll re-fires on
				// the STALE fd (level-triggered state survives close),
				// and accept on the fresh fd blocks if the backlog
				// drained. epoll re-fires while connects remain, so burst
				// clients are picked up on subsequent wakeups (~instant,
				// not a full epollWaitMs: EPOLL_IN is level-triggered).
				this.acceptDownstream();
			} else if (fd === this.upListen) {
				this.acceptUpstream();
			} else if (fd === this.upConn) {
				this.drainUpstream();
			}
		}
		if (fl & this.c.EPOLL_ERR) {
			this.handleErr(fd);
		}
	}
		this.maybeStats(now);
	}

	maybeStats(now) {
		const iv = this.cfg.statsIntervalSec;
		if (!iv || iv <= 0) {
			return;
		}
		if (now - this.lastStats < iv * 1000) {
			return;
		}
		const dt = (now - this.lastStats) / 1000;
		const dIn = this.msgsIn - this.lastMsgsIn;
		const dBytesIn = this.bytesIn - this.lastBytesIn;
		const dBytesOut = this.bytesOut - this.lastBytesOut;
		const cpu = process.cpuUsage(this.lastCpuUsage);
		const cpuPercent = (cpu.user + cpu.system) / (dt * 10000);
		const rssMiB = process.memoryUsage().rss / (1024 * 1024);
		let up = "";
		if (this.upConn >= 0) {
			try {
				const s = this.srt.stats(this.upConn, false);
				up =
					" upRecv=" + Number(s.mbpsRecvRate).toFixed(2) + "Mbps" +
					" loss=" + s.pktRcvLoss +
					" drop=" + s.pktRcvDrop +
					" rtt=" + s.msRTT + "ms";
			} catch {
				// socket went away mid-poll; next line covers it
			}
		}
		this.log(
			"stats dt=" + dt.toFixed(0) + "s" +
			" in=" + dIn + "msgs/" + (dBytesIn * 8 / dt / 1e6).toFixed(2) + "Mbps" +
			" out=" + (dBytesOut * 8 / dt / 1e6).toFixed(2) + "Mbps" +
			" clients=" + this.egress.size +
			" dropped=" + this.dropped +
			" ram=" + rssMiB.toFixed(1) + "MiB" +
			" cpu=" + cpuPercent.toFixed(1) + "%" + up
		);
		this.lastStats = now;
		this.lastMsgsIn = this.msgsIn;
		this.lastBytesIn = this.bytesIn;
		this.lastBytesOut = this.bytesOut;
		this.lastCpuUsage = process.cpuUsage();
	}

	close() {
		for (const fd of this.egress) {
			this.safeClose(fd);
		}
		this.egress.clear();
		this.safeClose(this.upConn);
		this.safeClose(this.upListen);
		this.safeClose(this.downListen);
		// No epoll release: the binding exposes none, and epid dies with
		// the process. Closed sockets auto-leave the container.
	}
}

module.exports = { Relay };
