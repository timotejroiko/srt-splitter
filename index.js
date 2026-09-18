#!/usr/bin/env node
"use strict";

/**
 * SRT splitter: one upstream source -> many clients.
 * Orchestration only: config -> native binding -> relay loop -> cleanup.
 */

const { loadConfig, resolveSourceHost } = require("./src/config");
const { printHelp } = require("./src/help");
const { createSrt } = require("./src/srt");
const { Relay } = require("./src/relay");

async function main() {
	let cfg;
	try {
		cfg = loadConfig(process.argv);
		if (cfg) {
			cfg = await resolveSourceHost(cfg);
		}
	} catch (err) {
		console.error("config error:", err.message);
		printHelp();
		process.exit(2);
	}
	if (!cfg) {
		printHelp();
		process.exit(0);
	}

	let relay;
	try {
		relay = new Relay(cfg);
		relay.init(createSrt());
	} catch (err) {
		console.error("init error:", err.message);
		process.exit(1);
	}
	let stopping = false;
	const stop = () => {
		if (stopping) {
			process.exit(1); // second signal: exit now instead of waiting out the epoll block
		}
		stopping = true;
		relay.shutdown();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	process.on("SIGHUP", stop);

	try {
		relay.open();
	} catch (err) {
		console.error(err.message);
		process.exit(1);
	}
	try {
		while (relay.running) {
			relay.poll();
			// The relay uses synchronous native calls. Yield between polls
			// so libuv can dispatch SIGINT/SIGTERM/SIGHUP callbacks.
			await new Promise(setImmediate);
		}
	} finally {
		relay.close();
	}
}

main().catch((err) => {
	console.error("fatal error:", err.message);
	process.exitCode = 1;
});
