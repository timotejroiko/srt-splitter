"use strict";

/**
 * Lazy native binding + numeric constants.
 * Required lazily so --help and config errors work without the addon
 * installed. Fallbacks come from libsrt srt-enums.h for builds whose
 * addon omits statics.
 *
 * LIVE_MAX_PAYLOAD is the live-mode message ceiling under the default
 * IPv4 MSS (1500 - 28 IP/UDP - 16 SRT). RCVBUF_CELL_SIZE is separate:
 * libsrt converts SRTO_RCVBUF bytes into cells of MSS - IP/UDP headers.
 * Receive buffers use the cell size; reads and PAYLOADSIZE use the payload
 * ceiling.
 */
const DEFAULT_MSS = 1500;
const IPV4_UDP_HEADER = 28;
const SRT_DATA_HEADER = 16;
const RCVBUF_CELL_SIZE = DEFAULT_MSS - IPV4_UDP_HEADER;
const LIVE_MAX_PAYLOAD = RCVBUF_CELL_SIZE - SRT_DATA_HEADER;
function createSrt() {
	const { SRT } = require("@eyevinn/srt");
	const srt = new SRT();
	const so = (name, fb) => (SRT[name] !== undefined ? SRT[name] : fb);
	const c = {
		EPOLL_IN: so("EPOLL_IN", 1),
		EPOLL_OUT: so("EPOLL_OUT", 4),
		EPOLL_ERR: so("EPOLL_ERR", 8),
		SRTO_SNDSYN: so("SRTO_SNDSYN", 1),
		SRTO_RCVSYN: so("SRTO_RCVSYN", 2),
		SRTO_REUSEADDR: so("SRTO_REUSEADDR", 15),
		SRTO_SNDBUF: so("SRTO_SNDBUF", 5),
		SRTO_RCVBUF: so("SRTO_RCVBUF", 6),
		SRTO_UDP_SNDBUF: so("SRTO_UDP_SNDBUF", 8),
		SRTO_UDP_RCVBUF: so("SRTO_UDP_RCVBUF", 9),
		SRTO_RCVTIMEO: so("SRTO_RCVTIMEO", 14),
		SRTO_CONNTIMEO: so("SRTO_CONNTIMEO", 36),
		SRTO_RCVLATENCY: so("SRTO_RCVLATENCY", 43),
		SRTO_PEERLATENCY: so("SRTO_PEERLATENCY", 44),
		SRTO_PASSPHRASE: so("SRTO_PASSPHRASE", 26),
		SRTO_PBKEYLEN: so("SRTO_PBKEYLEN", 27),
		SRTO_STREAMID: so("SRTO_STREAMID", 46),
		SRTO_PAYLOADSIZE: so("SRTO_PAYLOADSIZE", 49),
		SRTO_TRANSTYPE: so("SRTO_TRANSTYPE", 50),
		SRTO_PEERIDLETIMEO: so("SRTO_PEERIDLETIMEO", 55),
		SRTO_TLPKTDROP: so("SRTO_TLPKTDROP", 31),
		SRTS_LISTENING: so("SRTS_LISTENING", 3),
		SRTS_CONNECTING: so("SRTS_CONNECTING", 4),
		SRTS_CONNECTED: so("SRTS_CONNECTED", 5)
	};
	return { srt, c };
}

module.exports = { createSrt, LIVE_MAX_PAYLOAD, RCVBUF_CELL_SIZE };
