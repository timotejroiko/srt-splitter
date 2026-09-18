"use strict";

const DEFAULTS = require("../config");

function parseArgs(argv) {
	// A token is a flag if it is "--", "--name", or "-x". A leading dash
	// followed by a digit (e.g. "-1") is a negative numeric value.
	const isFlag = (t) => t === "-" || t.startsWith("--") || /^-[a-zA-Z]/.test(t);
	const args = {};
	const set = (rawKey, value) => {
		args[rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
	};
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--") {
			break; // end of flags; positional tail ignored
		} else if (a.startsWith("--")) {
			const body = a.slice(2);
			const eq = body.indexOf("=");
			if (eq >= 0) {
				set(body.slice(0, eq), body.slice(eq + 1));
			} else {
				const next = argv[i + 1];
				if (next === undefined || isFlag(next)) {
					set(body, true);
				} else {
					set(body, next);
					i++;
				}
			}
		} else if (/^-[a-zA-Z]$/.test(a)) {
			args[a[1]] = true;
		}
	}
	return args;
}

function num(v, fallback) {
	if (v === undefined || v === null || v === "") {
		return fallback;
	}
	const n = Number(v);
	if (!Number.isFinite(n)) {
		throw new Error("Not a number: " + v);
	}
	return n;
}

/** "--rcv-buf 16m" -> bytes. Suffixes k/m/g (case-insensitive); bare = bytes. */
function bytes(v, fallback) {
	if (v === undefined || v === null || v === "") {
		return fallback;
	}
	if (typeof v === "number") {
		return v;
	}
	const m = /^\s*([\d.]+)\s*([kmg]?)\s*$/i.exec(v);
	if (!m) {
		throw new Error("Not a byte size: " + v);
	}
	return Math.round(Number(m[1]) * { "": 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[m[2].toLowerCase()]);
}

function loadConfig(argv) {
	const a = parseArgs(argv);
	if (a.help || a.h) {
		return null;
	}
	const raw = a.source || process.env.SOURCE || "";
	if (!raw) {
		throw new Error("Missing --source srt://host:port");
	}
	let u;
	try {
		u = new URL(raw);
	} catch {
		throw new Error("Source must be srt:// URL, got: " + raw);
	}
	if (u.protocol !== "srt:") {
		throw new Error("Source must be srt:// URL, got: " + raw);
	}
	const mode = a.mode || process.env.MODE || DEFAULTS.mode;
	if (mode !== "caller" && mode !== "listener") {
		throw new Error('Mode must be caller|listener, got: "' + mode + '"');
	}
	const q = (name) => (u.searchParams.has(name) ? u.searchParams.get(name) : undefined);
	// Precedence everywhere: CLI > env > srt:// query > defaults.
	const cfg = {
		mode,
		sourceHost: u.hostname,
		sourcePort: num(u.port, 0),
		sourceBindHost: a.sourceBindHost || process.env.SOURCE_BIND_HOST || DEFAULTS.sourceBindHost,
		rcvLatency: num(a.rcvLatency ?? process.env.RCV_LATENCY ?? q("rcvlatency") ?? a.latency ?? process.env.LATENCY ?? q("latency"), DEFAULTS.rcvLatency),
		peerLatency: num(a.peerLatency ?? process.env.PEER_LATENCY ?? q("peerlatency") ?? a.latency ?? process.env.LATENCY ?? q("latency"), DEFAULTS.peerLatency),
		passphrase: a.passphrase || process.env.PASSPHRASE || q("passphrase") || DEFAULTS.passphrase,
		streamId: a.streamId || process.env.STREAM_ID || q("streamid") || DEFAULTS.streamId,
		pbKeyLen: num(a.pbKeyLen ?? process.env.PBKEYLEN ?? q("pbkeylen"), DEFAULTS.pbKeyLen),
		connTimeout: num(a.connTimeout ?? process.env.CONN_TIMEOUT ?? q("conntimeo"), DEFAULTS.connTimeout),
		peerIdleTimeout: num(a.peerIdleTimeout ?? process.env.PEER_IDLE_TIMEOUT ?? q("peeridletimeout") ?? q("peeridletimeo"), DEFAULTS.peerIdleTimeout),
		linger: num(a.linger ?? process.env.LINGER, DEFAULTS.linger),
		listenHost: a.listenHost || process.env.LISTEN_HOST || DEFAULTS.listenHost,
		listenPort: num(a.listenPort ?? process.env.LISTEN_PORT, DEFAULTS.listenPort),
		chunkSize: num(a.chunkSize ?? process.env.CHUNK_SIZE, DEFAULTS.chunkSize),
		rcvBuf: bytes(a.rcvBuf ?? process.env.RCV_BUF, DEFAULTS.rcvBuf),
		sndBuf: bytes(a.sndBuf ?? process.env.SND_BUF, DEFAULTS.sndBuf),
		upstreamSndBuf: bytes(a.upstreamSndBuf ?? process.env.UPSTREAM_SND_BUF, DEFAULTS.upstreamSndBuf),
		udpRcvBuf: bytes(a.udpRcvBuf ?? process.env.UDP_RCV_BUF, DEFAULTS.udpRcvBuf),
		udpSndBuf: bytes(a.udpSndBuf ?? process.env.UDP_SND_BUF, DEFAULTS.udpSndBuf),
		upstreamUdpSndBuf: bytes(a.upstreamUdpSndBuf ?? process.env.UPSTREAM_UDP_SND_BUF, DEFAULTS.upstreamUdpSndBuf),
		egressRcvBuf: bytes(a.egressRcvBuf ?? process.env.EGRESS_RCV_BUF, DEFAULTS.egressRcvBuf),
		egressUdpRcvBuf: bytes(a.egressUdpRcvBuf ?? process.env.EGRESS_UDP_RCV_BUF, DEFAULTS.egressUdpRcvBuf),
		reconnectDelayMs: num(a.reconnectDelay ?? process.env.RECONNECT_DELAY, DEFAULTS.reconnectDelayMs),
		epollWaitMs: num(a.epollWait ?? process.env.EPOLL_WAIT, DEFAULTS.epollWaitMs),
		backlog: num(a.backlog ?? process.env.BACKLOG, DEFAULTS.backlog),
		upReadTimeoutMs: num(a.upReadTimeout ?? process.env.UP_READ_TIMEOUT, DEFAULTS.upReadTimeoutMs),
		drainMax: num(a.drainMax ?? process.env.DRAIN_MAX, DEFAULTS.drainMax),
		statsIntervalSec: num(a.statsInterval ?? process.env.STATS_INTERVAL, DEFAULTS.statsIntervalSec)
	};
	return validateConfig(cfg);
}

// FC cap: receiver buffers must not exceed the flow-control window or
// libsrt clamps/ignores the excess (~25600 bufs x payload).
const FC_BUFS = 25600;
function validateConfig(cfg) {
	if (!cfg.sourceHost) {
		throw new Error("Source URL needs a host, got: " + cfg.sourceHost);
	}
	for (const [name, v] of [["sourcePort", cfg.sourcePort], ["listenPort", cfg.listenPort]]) {
		if (!Number.isInteger(v) || v < 1 || v > 65535) {
			throw new Error(name + " must be 1-65535, got: " + v);
		}
	}
	if (cfg.passphrase !== undefined) {
		if (cfg.passphrase.length < 10 || cfg.passphrase.length > 79) {
			throw new Error("Passphrase must be 10-79 characters, got " + cfg.passphrase.length);
		}
		if (![16, 24, 32].includes(cfg.pbKeyLen)) {
			throw new Error("pbKeyLen must be 16|24|32, got: " + cfg.pbKeyLen);
		}
	}
	if (!Number.isInteger(cfg.chunkSize) || cfg.chunkSize <= 0 || cfg.chunkSize > 1456) {
		throw new Error("chunkSize must be integer 1-1456 (live max), got: " + cfg.chunkSize);
	}
	for (const [name, v] of [["rcvLatency", cfg.rcvLatency], ["peerLatency", cfg.peerLatency]]) {
		if (!Number.isFinite(v) || v < 0) {
			throw new Error(name + " must be >= 0, got: " + v);
		}
	}
	if (!Number.isFinite(cfg.peerIdleTimeout) || cfg.peerIdleTimeout < 0) {
		throw new Error("peerIdleTimeout must be >= 0, got: " + cfg.peerIdleTimeout);
	}
	if (!Number.isFinite(cfg.linger) || cfg.linger < 0) {
		throw new Error("linger must be >= 0, got: " + cfg.linger);
	}
	if (!Number.isInteger(cfg.backlog) || cfg.backlog < 1) {
		throw new Error("backlog must be integer >= 1, got: " + cfg.backlog);
	}
	for (const [name, v] of [["connTimeout", cfg.connTimeout], ["reconnectDelayMs", cfg.reconnectDelayMs], ["epollWaitMs", cfg.epollWaitMs], ["upReadTimeoutMs", cfg.upReadTimeoutMs]]) {
		if (!Number.isFinite(v) || v < 0) {
			throw new Error(name + " must be >= 0, got: " + v);
		}
	}
	if (!Number.isInteger(cfg.drainMax) || cfg.drainMax < 1 || cfg.drainMax > 1024) {
		throw new Error("drainMax must be integer 1-1024, got: " + cfg.drainMax);
	}
	if (!Number.isFinite(cfg.statsIntervalSec) || cfg.statsIntervalSec < 0) {
		throw new Error("statsIntervalSec must be >= 0, got: " + cfg.statsIntervalSec);
	}
	for (const [name, v] of [["rcvBuf", cfg.rcvBuf], ["sndBuf", cfg.sndBuf], ["upstreamSndBuf", cfg.upstreamSndBuf], ["udpRcvBuf", cfg.udpRcvBuf], ["udpSndBuf", cfg.udpSndBuf], ["upstreamUdpSndBuf", cfg.upstreamUdpSndBuf], ["egressRcvBuf", cfg.egressRcvBuf], ["egressUdpRcvBuf", cfg.egressUdpRcvBuf]]) {
		if (!Number.isFinite(v) || v <= 0) {
			throw new Error(name + " must be > 0, got: " + v);
		}
	}
	// Receiver buffers above the FC window are dead weight: flag, don't clamp.
	for (const [name, v] of [["rcvBuf", cfg.rcvBuf], ["egressRcvBuf", cfg.egressRcvBuf]]) {
		if (v > FC_BUFS * cfg.chunkSize) {
			throw new Error(name + " " + v + " exceeds FC window (~" + (FC_BUFS * cfg.chunkSize) + " at chunkSize " + cfg.chunkSize + "); lower it or raise chunkSize");
		}
	}
	return cfg;
}


module.exports = { parseArgs, loadConfig };
