"use strict";

// Build-time patches for files under node_modules/@eyevinn/srt.
// All patches are targeted exact-snippet replaces: idempotent, re-applied
// every setup run. If a snippet is gone (upstream changed), a warning is
// logged and the build continues with whatever upstream ships — no fork.

const fs = require("fs");

function patchOnce(src, oldStr, newStr) {
	if (src.includes(newStr)) {
		return { src, status: "already-patched" };
	}
	if (!src.includes(oldStr)) {
		return { src, status: "upstream-changed" };
	}
	return { src: src.replace(oldStr, newStr), status: "applied" };
}

// Upstream build script surgery (was inline in setup.js).
function patchBuildScript({ buildScript, vs, opensslRoot, isWin, log }) {
	let src = fs.readFileSync(buildScript, "utf8");
	const orig = src;
	if (isWin && vs && vs.generator) {
		src = src.replaceAll("Visual Studio 16 2019", vs.generator);
	}
	// Upstream bug: bare mkdirSync crashes on a stale dir.
	src = src.replace("fs.mkdirSync(buildDir);", "fs.mkdirSync(buildDir, { recursive: true });");
	// Slim flags (apps/examples off, C++11 threads so pthreads is never
	// consulted on Windows). Idempotent: collapse repeats left by earlier
	// runs back to one copy, then ensure one exists.
	const slim = "'-DENABLE_APPS=OFF', '-DENABLE_EXAMPLES=OFF', '-DENABLE_STDCXX_SYNC=ON'";
	while (src.includes(slim + ", " + slim)) {
		src = src.replaceAll(slim + ", " + slim, slim);
	}
	const slimPatch = patchOnce(src, "'-A', process.arch", "'-A', process.arch, " + slim);
	src = slimPatch.src;
	if (slimPatch.status === "upstream-changed") {
		console.warn("[setup] WARNING: upstream build script changed, slim flags NOT applied. Check " + buildScript);
	}
	if (isWin) {
		// Cut the vcpkg openssl/pthreads/integrate paragraphs: cmake gets
		// -DOPENSSL_ROOT_DIR pointing at the prebuilt tree instead.
		// Idempotent: only cut when the original block is still present.
		const start = src.indexOf('console.log("Building OpenSSL");');
		const end = src.indexOf('console.log("Running cmake generator");');
		if (start >= 0 && end >= 0 && end > start) {
			src = src.slice(0, start) + 'console.log("Skipping vcpkg, using OPENSSL_ROOT_DIR");\n  ' + src.slice(end);
		}
		if (!src.includes("-DOPENSSL_ROOT_DIR=")) {
			// Escape backslashes: the patched line is single-quoted JS in
			// the target file, so C:\x becomes an octal escape under
			// "use strict" and kills the script (seen: \U in \Users).
			const esc = opensslRoot.replace(/\\/g, "\\\\");
			src = src.replace(/'-DCMAKE_TOOLCHAIN_FILE=[^']*'/, `'"-DOPENSSL_ROOT_DIR=${esc}"'`);
		}
	}
	if (src !== orig) {
		fs.writeFileSync(buildScript, src);
		log("patched upstream build script for this run");
	}
}

// Native binding fixes (upstream Eyevinn/node-srt issues, no fork).
function patchBindingCc({ bindingCc, log }) {
	if (!fs.existsSync(bindingCc)) {
		console.warn("[setup] WARNING: binding source missing, skipping native patches: " + bindingCc);
		return;
	}
	let src = fs.readFileSync(bindingCc, "utf8");
	// 1. Read() leaks the full receive buffer on every failed read (including the
	// normal non-blocking "no data" terminator): malloc without free on the
	// SRT_ERROR path. Free before throwing.
	const readOld = [
		"  int nb = srt_recvmsg(socketValue, (char *)buffer, (int)bufferSize);",
		"  if (nb == SRT_ERROR) {",
		"    string err(string(\"srt_recvmsg: \")",
		"      + string(srt_getlasterror_str()));",
	].join("\n");
	const readNew = [
		"  int nb = srt_recvmsg(socketValue, (char *)buffer, (int)bufferSize);",
		"  if (nb == SRT_ERROR) {",
		"    free(buffer);",
		"    string err(string(\"srt_recvmsg: \")",
		"      + string(srt_getlasterror_str()));",
	].join("\n");
	// 2. Accept() destroys the listener on success (matches upstream PR #81):
	// remove the success-path srt_close so one listener serves many clients.
	// The failure path is left as-is; the relay recreates the listener only
	// when it is no longer LISTENING. Block includes the preceding lines so
	// the patched state is distinguishable from the original.
	const acceptOld = [
		"    return Napi::Number::New(env, SRT_ERROR);",
		"  }",
		"  srt_close(socketValue);",
		"  socketValue = Napi::Number::New(env, SRT_INVALID_SOCK);",
		"  return Napi::Number::New(env, their_fd);",
	].join("\n");
	const acceptNew = [
		"    return Napi::Number::New(env, SRT_ERROR);",
		"  }",
		"  return Napi::Number::New(env, their_fd);",
	].join("\n");
	for (const [label, oldStr, newStr] of [
		["Read() leak (free on error)", readOld, readNew],
		["Accept() keep listener on success", acceptOld, acceptNew],
	]) {
		const r = patchOnce(src, oldStr, newStr);
		src = r.src;
		if (r.status === "applied") {
			log("patched binding: " + label);
		} else if (r.status === "already-patched") {
			log("binding patch already applied, skipping: " + label);
		} else {
			console.warn("[setup] WARNING: upstream binding changed, patch NOT applied: " + label + ". Check " + bindingCc);
		}
	}
	fs.writeFileSync(bindingCc, src);
}

module.exports = { patchBuildScript, patchBindingCc };
