"use strict";

const dns = require("dns");
const net = require("net");
const DEFAULTS = require("../config");
const { RCVBUF_CELL_SIZE } = require("./srt");

// The --source URL carries identity only (host, port, ?streamid=); all
// tuning is CLI/env with upstream-/downstream- prefixes, in milliseconds.
// Known removed tuning params are rejected with directions; truly unknown
// ones (e.g. tool-specific params like lossmaxttl) are ignored for
// paste-compat with ecosystem URLs.
const STALE_QUERY = {
	latency: "--upstream-latency / --downstream-latency",
	rcvlatency: "--upstream-latency",
	peerlatency: "--downstream-latency",
	passphrase: "--upstream-passphrase",
	pbkeylen: "--upstream-pb-key-len",
	conntimeo: "--upstream-conn-timeout",
	peeridletimeout: "--peer-idle-timeout",
	peeridletimeo: "--peer-idle-timeout",
};

function parseArgs(argv) {
	// A token is a flag if it is "--", "--name", or "-x". A leading dash
	// followed by a digit (e.g. "-1") is a negative numeric value.
	const isFlag = (t) => t === "-" || t.startsWith("--") || /^-[a-zA-Z]/.test(t);
	const camel = (rawKey) => rawKey.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
	// Every accepted --flag (canonical camelCase). Anything else is a typo
	// worth failing on instead of silently ignoring.
	const KNOWN = new Set([
		"source", "mode", "callerBindHost",
		"upstreamLatency", "upstreamPassphrase", "upstreamPbKeyLen",
		"upstreamConnTimeout", "peerIdleTimeout",
		"downstreamLatency", "downstreamPassphrase", "downstreamPbKeyLen",
		"listenHost", "listenPort", "rcvBuf", "sndBuf", "upstreamSndBuf",
		"udpRcvBuf", "udpSndBuf", "upstreamUdpSndBuf", "egressRcvBuf",
		"egressUdpRcvBuf", "backlog", "maxClients", "statsInterval", "help", "h",
	]);
	// Flags that take a value: help/h are the only bare flags.
	const VALUE_FLAGS = new Set([...KNOWN].filter((k) => k !== "help" && k !== "h"));
	const args = {};
	const seenRaw = {}; // canonical key -> kebab raw key, for error messages
	const set = (rawKey, value) => {
		const key = camel(rawKey);
		if (!KNOWN.has(key)) {
			throw new Error("Unknown option: --" + rawKey);
		}
		args[key] = value;
		seenRaw[key] = rawKey;
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
			if (a[1] !== "h") {
				throw new Error("Unknown option: -" + a[1]);
			}
			args[a[1]] = true;
		}
	}
	// A value-taking flag with no (or an empty) value used to slip through as
	// boolean true / "" (e.g. --passphrase became boolean true, --rcv-latncy
	// style typos were ignored entirely — now caught above).
	for (const key of VALUE_FLAGS) {
		if (args[key] === true || args[key] === "") {
			throw new Error("Missing value for --" + (seenRaw[key] || key));
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
	const mode = a.mode || process.env.MODE || DEFAULTS.mode;
	if (mode !== "caller" && mode !== "listener") {
		throw new Error('Mode must be caller|listener, got: "' + mode + '"');
	}
	// Caller mode dials the URL, so strict parsing applies. Listener mode
	// only binds locally, where an empty host (= all interfaces) is the
	// common case but `new URL` rejects hostless non-special schemes —
	// hence the tolerant parse there.
	let host, portStr, params;
	if (mode === "listener") {
		const m = /^srt:\/\/(\[[^\]]*\]|[^:/?#]*)(?::(\d+))?(\?[^#]*)?$/.exec(raw);
		if (!m) {
			throw new Error("Source must be srt://[host:]port[?params], got: " + raw);
		}
		host = m[1];
		if (host.startsWith("[") && host.endsWith("]")) {
			host = host.slice(1, -1);
		}
		portStr = m[2] || "";
		params = new URLSearchParams(m[3] ? m[3].slice(1) : "");
	} else {
		let u;
		try {
			u = new URL(raw);
		} catch {
			throw new Error("Source must be srt:// URL, got: " + raw);
		}
		if (u.protocol !== "srt:") {
			throw new Error("Source must be srt:// URL, got: " + raw);
		}
		params = u.searchParams;
		// WHATWG URL keeps IPv6 brackets in .hostname ("[::1]"); strip them
		// so net.isIP sees the literal.
		host = u.hostname;
		if (host.startsWith("[") && host.endsWith("]")) {
			host = host.slice(1, -1);
		}
		portStr = u.port;
	}
	// Only ?streamid= survives in the URL (handshake identity). Removed
	// params fail fast with directions; truly unknown ones (tool-specific,
	// e.g. lossmaxttl) are ignored for paste-compat with ecosystem URLs.
	const q = (name) => (params.has(name) ? params.get(name) : undefined);
	for (const key of params.keys()) {
		if (key === "streamid") {
			continue;
		}
		if (Object.hasOwn(STALE_QUERY, key)) {
			throw new Error("?"+ key + "= was removed from the URL; use " + STALE_QUERY[key] + " instead");
		}
	}
	// Precedence: CLI > env > these defaults. The URL carries identity
	// only (host, port, ?streamid=).
	const cfg = {
		mode,
		sourceHost: host,
		sourcePort: num(portStr, 0),
		// Listener mode: the URL host IS the local bind interface ("" =
		// all interfaces, see resolveSourceHost). Caller mode never binds
		// locally, so this stays a hardcoded unused placeholder there.
		sourceBindHost: mode === "listener" ? host : "0.0.0.0",
		upstreamLatency: num(a.upstreamLatency ?? process.env.UPSTREAM_LATENCY, DEFAULTS.upstreamLatency),
		downstreamLatency: num(a.downstreamLatency ?? process.env.DOWNSTREAM_LATENCY, DEFAULTS.downstreamLatency),
		upstreamPassphrase: a.upstreamPassphrase || process.env.UPSTREAM_PASSPHRASE || DEFAULTS.upstreamPassphrase,
		downstreamPassphrase: a.downstreamPassphrase || process.env.DOWNSTREAM_PASSPHRASE || DEFAULTS.downstreamPassphrase,
		streamId: q("streamid") || DEFAULTS.streamId,
		upstreamPbKeyLen: num(a.upstreamPbKeyLen ?? process.env.UPSTREAM_PBKEYLEN, DEFAULTS.upstreamPbKeyLen),
		downstreamPbKeyLen: num(a.downstreamPbKeyLen ?? process.env.DOWNSTREAM_PBKEYLEN, DEFAULTS.downstreamPbKeyLen),
		upstreamConnTimeout: num(a.upstreamConnTimeout ?? process.env.UPSTREAM_CONN_TIMEOUT, DEFAULTS.upstreamConnTimeout),
		peerIdleTimeout: num(a.peerIdleTimeout ?? process.env.PEER_IDLE_TIMEOUT, DEFAULTS.peerIdleTimeout),
		callerBindHost: a.callerBindHost || process.env.CALLER_BIND_HOST || DEFAULTS.callerBindHost,
		listenHost: a.listenHost || process.env.LISTEN_HOST || DEFAULTS.listenHost,
		listenPort: num(a.listenPort ?? process.env.LISTEN_PORT, DEFAULTS.listenPort),
		rcvBuf: bytes(a.rcvBuf ?? process.env.RCV_BUF, DEFAULTS.rcvBuf),
		sndBuf: bytes(a.sndBuf ?? process.env.SND_BUF, DEFAULTS.sndBuf),
		upstreamSndBuf: bytes(a.upstreamSndBuf ?? process.env.UPSTREAM_SND_BUF, DEFAULTS.upstreamSndBuf),
		udpRcvBuf: bytes(a.udpRcvBuf ?? process.env.UDP_RCV_BUF, DEFAULTS.udpRcvBuf),
		udpSndBuf: bytes(a.udpSndBuf ?? process.env.UDP_SND_BUF, DEFAULTS.udpSndBuf),
		upstreamUdpSndBuf: bytes(a.upstreamUdpSndBuf ?? process.env.UPSTREAM_UDP_SND_BUF, DEFAULTS.upstreamUdpSndBuf),
		egressRcvBuf: bytes(a.egressRcvBuf ?? process.env.EGRESS_RCV_BUF, DEFAULTS.egressRcvBuf),
		egressUdpRcvBuf: bytes(a.egressUdpRcvBuf ?? process.env.EGRESS_UDP_RCV_BUF, DEFAULTS.egressUdpRcvBuf),
		backlog: num(a.backlog ?? process.env.BACKLOG, DEFAULTS.backlog),
		maxClients: num(a.maxClients ?? process.env.MAX_CLIENTS, DEFAULTS.maxClients),
		statsIntervalSec: num(a.statsInterval ?? process.env.STATS_INTERVAL, DEFAULTS.statsIntervalSec)
	};
	return validateConfig(cfg);
}

// FC caps receiver buffers by the native receive-cell size, not the
// application payload size. The default IPv4 cell is MSS - IP/UDP headers.
const FC_BUFS = 25600;
// Native socket options are C ints (32-bit): the binding truncates or
// overflows anything outside this range.
const INT32_MAX = 2147483647;
function intRange(name, v, min, max) {
	if (!Number.isInteger(v) || v < min || v > max) {
		throw new Error(name + " must be integer " + min + "-" + max + ", got: " + v);
	}
}
function validateConfig(cfg) {
	// Listener mode allows an empty host (= bind all interfaces); the
	// resolved bind address is filled in by resolveSourceHost() below.
	if (!cfg.sourceHost && cfg.mode !== "listener") {
		throw new Error("Source URL needs a host, got: " + cfg.sourceHost);
	}
	// The native binding passes hosts straight to inet_pton(AF_INET) with no
	// DNS and no error check: a hostname would silently become 0.0.0.0.
	// IPv6 literals are rejected here; hostnames are resolved to IPv4 in
	// resolveSourceHost() before any socket call. Real IPv6 needs an upstream
	// native change (the binding uses sockaddr_in throughout), so it fails
	// fast instead of connecting to the wrong address.
	if (net.isIP(cfg.sourceHost) === 6) {
		throw new Error("IPv6 is not supported by the SRT binding (IPv4 only), got source host: " + cfg.sourceHost);
	}
	// Local bind addresses must be literal IPv4. sourceBindHost needs no
	// check: in caller mode it is the hardcoded placeholder, in listener
	// mode it carries the raw URL host here and becomes a literal IP in
	// resolveSourceHost() below.
	if (!net.isIP(cfg.listenHost)) {
		throw new Error("listenHost must be a literal IP address (hostnames are not resolved for local binds), got: " + cfg.listenHost);
	}
	if (net.isIP(cfg.listenHost) === 6) {
		throw new Error("listenHost must be IPv4 (IPv6 is not supported by the SRT binding), got: " + cfg.listenHost);
	}
	if (cfg.callerBindHost !== undefined) {
		if (!net.isIP(cfg.callerBindHost)) {
			throw new Error("callerBindHost must be a literal IP address, got: " + cfg.callerBindHost);
		}
		if (net.isIP(cfg.callerBindHost) === 6) {
			throw new Error("callerBindHost must be IPv4 (IPv6 is not supported by the SRT binding), got: " + cfg.callerBindHost);
		}
	}
	for (const [name, v] of [["sourcePort", cfg.sourcePort], ["listenPort", cfg.listenPort]]) {
		if (!Number.isInteger(v) || v < 1 || v > 65535) {
			throw new Error(name + " must be 1-65535, got: " + v);
		}
	}
	for (const [name, v, klen] of [["upstreamPassphrase", cfg.upstreamPassphrase, cfg.upstreamPbKeyLen], ["downstreamPassphrase", cfg.downstreamPassphrase, cfg.downstreamPbKeyLen]]) {
		if (v === undefined) {
			continue;
		}
		if (typeof v !== "string") {
			throw new Error(name + " must be a string, got " + typeof v);
		}
		const byteLength = Buffer.byteLength(v, "utf8");
		if (byteLength < 10 || byteLength > 79) {
			throw new Error(name + " must be 10-79 UTF-8 bytes, got " + byteLength);
		}
		if (![16, 24, 32].includes(klen)) {
			throw new Error(name + " key length must be 16|24|32, got: " + klen);
		}
	}
	for (const [name, v] of [["streamId", cfg.streamId]]) {
		if (v !== undefined && typeof v !== "string") {
			throw new Error(name + " must be a string, got " + typeof v);
		}
		if (typeof v === "string" && Buffer.byteLength(v, "utf8") > 512) {
			throw new Error(name + " must be <= 512 UTF-8 bytes, got " + Buffer.byteLength(v, "utf8"));
		}
	}
	// Native socket options are 32-bit ints: fractions would silently
	// truncate in the binding and huge values overflow, so enforce integer
	// int32 range up front instead of failing (or misbehaving) natively.
	for (const [name, v] of [["upstreamLatency", cfg.upstreamLatency], ["downstreamLatency", cfg.downstreamLatency], ["peerIdleTimeout", cfg.peerIdleTimeout], ["upstreamConnTimeout", cfg.upstreamConnTimeout]]) {
		intRange(name, v, 0, INT32_MAX);
	}
	if (!Number.isInteger(cfg.backlog) || cfg.backlog < 1 || cfg.backlog > INT32_MAX) {
		throw new Error("backlog must be integer 1-" + INT32_MAX + ", got: " + cfg.backlog);
	}
	if (!Number.isInteger(cfg.maxClients) || cfg.maxClients < 1 || cfg.maxClients > INT32_MAX) {
		throw new Error("maxClients must be integer 1-" + INT32_MAX + ", got: " + cfg.maxClients);
	}
	if (!Number.isFinite(cfg.statsIntervalSec) || cfg.statsIntervalSec < 0) {
		throw new Error("statsIntervalSec must be >= 0, got: " + cfg.statsIntervalSec);
	}
	for (const [name, v] of [["rcvBuf", cfg.rcvBuf], ["sndBuf", cfg.sndBuf], ["upstreamSndBuf", cfg.upstreamSndBuf], ["udpRcvBuf", cfg.udpRcvBuf], ["udpSndBuf", cfg.udpSndBuf], ["upstreamUdpSndBuf", cfg.upstreamUdpSndBuf], ["egressRcvBuf", cfg.egressRcvBuf], ["egressUdpRcvBuf", cfg.egressUdpRcvBuf]]) {
		intRange(name, v, 1, INT32_MAX);
	}
	// Receiver buffers above the FC window are dead weight: flag, don't clamp.
	const maxRcvBuf = FC_BUFS * RCVBUF_CELL_SIZE;
	for (const [name, v] of [["rcvBuf", cfg.rcvBuf], ["egressRcvBuf", cfg.egressRcvBuf]]) {
		if (v > maxRcvBuf) {
			throw new Error(name + " " + v + " exceeds FC window (~" + maxRcvBuf + " bytes); lower it");
		}
	}
	return cfg;
}


module.exports = { parseArgs, loadConfig, resolveSourceHost };

// Hostnames reach the native binding unresolved (see validateConfig), so
// resolve the upstream endpoint to IPv4 once at startup. Literal IPv4
// passes through untouched; DNS failures and IPv6-only results are hard
// errors. In listener mode the URL host is the local bind interface:
// empty means all interfaces (hardcoded 0.0.0.0), otherwise the resolved
// address becomes the bind address.
async function resolveSourceHost(cfg) {
	if (!cfg.sourceHost) {
		cfg.sourceHost = cfg.sourceBindHost = "0.0.0.0";
		return cfg;
	}
	if (!net.isIP(cfg.sourceHost)) {
		let addrs;
		try {
			addrs = await dns.promises.lookup(cfg.sourceHost, { family: 4, all: true });
		} catch (err) {
			throw new Error("Cannot resolve source host '" + cfg.sourceHost + "': " + err.message);
		}
		if (!addrs.length) {
			throw new Error("Source host '" + cfg.sourceHost + "' has no IPv4 address (IPv6 is not supported by the SRT binding)");
		}
		cfg.sourceHost = addrs[0].address;
	}
	if (cfg.mode === "listener") {
		cfg.sourceBindHost = cfg.sourceHost;
	}
	return cfg;
}
