"use strict";

/**
 * One-shot native setup: fetch @eyevinn/srt (scripts skipped by .npmrc),
 * pin libsrt to SRT_TAG, download a prebuilt OpenSSL zip (no vcpkg, no
 * nasm, no perl), configure libsrt once with VS-bundled cmake, then
 * compile the N-API addon once. No double build.
 *
 * Usage:
 *   npm run setup [-- --check]   --check: report detected toolchain only
 *
 * Env overrides: SRT_VERSION (default v1.5.7), OPENSSL_VERSION (3.5|4.0,
 * default 3.5 LTS), OPENSSL_ROOT_DIR (skip download, use this tree).
 *
 * Windows OpenSSL resolution order:
 * 1. OPENSSL_ROOT_DIR env, slproweb install paths (zero download).
 * 2. .deps/openssl/<ver>/x64 sidecar from a previous run (zero download).
 * 3. FireDaemon zip download + SHA-256 verify + extract (one-time).
 * vcpkg is never invoked: prebuilt import libs are all cmake needs, and
 * ENABLE_STDCXX_SYNC=ON removes the pthreads dependency on Windows.
 * Only remaining native tools: VS (cl/link) + its bundled cmake/ninja,
 * both detected via vswhere and prepended to this session's PATH only.
 */

const { spawnSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const https = require("https");
const path = require("path");

const SRT_TAG = process.env.SRT_VERSION || "v1.5.7";
const ROOT = path.join(__dirname, "..");
const DEP = path.join(ROOT, "node_modules", "@eyevinn", "srt");
const SRT_DIR = path.join(DEP, "deps", "srt");
const BUILD_DIR = path.join(DEP, "deps", "build");
const BUILD_SCRIPT = path.join(DEP, "scripts", "build-srt-sdk.js");
const SSL_SIDECAR = path.join(ROOT, ".deps", "openssl");

// FireDaemon publishes EV-signed zips with SHA-256 on the download page.
// Layout inside: x64/{include,lib/{libcrypto,libssl}.lib,bin/*.dll}.
const OPENSSL_ZIPS = {
	"3.5": {
		url: "https://www.firedaemon.com/download-firedaemon-openssl-3-5-zip",
		sha256: "a5377866b476c1661f329d3f25fc35912fa5ef01e614043b9b9a27baf8dd76a4",
		ver: "3.5.8"
	},
	"4.0": {
		url: "https://www.firedaemon.com/download-firedaemon-openssl-4-0-zip",
		sha256: "f7f76ba792d8b67d0564f0d9209579b972a0af52c0e64f2974ffe63a14831e2a",
		ver: "4.0.2"
	}
};

const log = (...a) => console.log("[setup]", ...a);
const isWin = process.platform === "win32";

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
	if ((r.status ?? 1) !== 0) {
		throw new Error(`command failed (${r.status}): ${cmd} ${args.join(" ")}`);
	}
}

function onPath(exe) {
	const probe = isWin ? ["where", exe] : ["which", exe];
	const r = spawnSync(probe[0], [probe[1]], { encoding: "utf8" });
	if (r.status !== 0) {
		return null;
	}
	return String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
}

// --- VS detection (node-gyp style: vswhere -> installationPath) ---

function vswhere(args) {
	const exe = "C:\\Program Files (x86)\\Microsoft Visual Studio\\Installer\\vswhere.exe";
	if (!fs.existsSync(exe)) {
		return null;
	}
	const r = spawnSync(exe, args, { encoding: "utf8" });
	return r.status === 0 ? String(r.stdout).trim() : null;
}

function detectVS() {
	if (!isWin) {
		return null;
	}
	// One -property per call: multi-property queries return empty on some
	// vswhere builds. Newest major wins (BuildTools vs Community).
	const query = (prop) => vswhere([
		"-products", "*",
		"-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
		"-format", "value", "-property", prop
	]);
	const paths = (query("installationPath") || "").replace(/\r/g, "").split("\n").map((s) => s.trim()).filter(Boolean);
	const versions = (query("installationVersion") || "").replace(/\r/g, "").split("\n").map((s) => s.trim()).filter(Boolean);
	if (!paths.length) {
		return null;
	}
	let best = 0;
	for (let i = 1; i < paths.length; i++) {
		const maj = (m, dflt) => Number(/(\d+)\./.exec(m || "")?.[1] || dflt);
		if (maj(versions[i], 0) > maj(versions[best], 0)) {
			best = i;
		}
	}
	const installationPath = paths[best];
	const installationVersion = versions[best] || "";
	const major = Number(/(\d+)\./.exec(installationVersion)?.[1] || 0);
	const cmakeBin = path.join(installationPath, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "CMake", "bin");
	const ninjaBin = path.join(installationPath, "Common7", "IDE", "CommonExtensions", "Microsoft", "CMake", "Ninja");
	return {
		installationPath,
		version: installationVersion.trim(),
		major,
		generator: major === 17 ? "Visual Studio 17 2022" : major > 17 ? `Visual Studio ${major}` : null,
		cmake: fs.existsSync(path.join(cmakeBin, "cmake.exe")) ? cmakeBin : null,
		ninja: fs.existsSync(path.join(ninjaBin, "ninja.exe")) ? ninjaBin : null
	};
}

// --- OpenSSL: prebuilt zip download, no vcpkg ---

function opensslOk(dir) {
	return !!dir && fs.existsSync(path.join(dir, "include", "openssl", "ssl.h"));
}

function detectOpenSSL(want) {
	const cands = [
		process.env.OPENSSL_ROOT_DIR,
		"C:\\Program Files\\OpenSSL-Win64", "C:\\OpenSSL-Win64",
		"C:\\Program Files\\OpenSSL", "C:\\OpenSSL",
		// Sidecar from a previous run (stable across setups).
		path.join(SSL_SIDECAR, want, "x64")
	].filter(Boolean);
	return cands.find(opensslOk) || null;
}

function download(url, dest) {
	return new Promise((resolve, reject) => {
		const get = (u) => https.get(u, (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				get(res.headers.location);
				return;
			}
			if (res.statusCode !== 200) {
				reject(new Error(`download ${res.statusCode}: ${u}`));
				return;
			}
			const out = fs.createWriteStream(dest);
			res.pipe(out);
			out.on("finish", () => out.close(resolve));
			out.on("error", reject);
		}).on("error", reject);
		get(url);
	});
}

async function fetchOpenSSL(want) {
	const spec = OPENSSL_ZIPS[want];
	if (!spec) {
		throw new Error(`OPENSSL_VERSION must be 3.5|4.0, got: ${want}`);
	}
	const dir = path.join(SSL_SIDECAR, want, "x64");
	if (opensslOk(dir)) {
		return dir;
	}
	const zip = path.join(SSL_SIDECAR, `openssl-${spec.ver}.zip`);
	fs.mkdirSync(SSL_SIDECAR, { recursive: true });
	log(`downloading prebuilt OpenSSL ${spec.ver} (~45MB, one-time)...`);
	await download(spec.url, zip);
	const sum = crypto.createHash("sha256").update(fs.readFileSync(zip)).digest("hex");
	if (sum !== spec.sha256) {
		fs.rmSync(zip, { force: true });
		throw new Error(`OpenSSL zip hash mismatch:\n  got:      ${sum}\n  expected: ${spec.sha256}`);
	}
	log("hash OK, extracting...");
	// Expand-Archive handles forward slashes; backslashes break on PS7.
	const posix = (p) => p.replace(/\\/g, "/");
	const dest = posix(path.join(SSL_SIDECAR, want));
	fs.rmSync(dest, { recursive: true, force: true });
	run("powershell.exe", ["-NoProfile", "-Command",
		`Expand-Archive -Path '${posix(zip)}' -DestinationPath '${dest}' -Force`], { shell: false });
	// Zip root holds per-arch dirs (x64/, x86/, arm64/); keep only ours.
	if (!opensslOk(dir)) {
		throw new Error(`OpenSSL zip extracted but ${dir} has no include/openssl/ssl.h; layout changed?`);
	}
	for (const sib of ["x86", "arm64"]) {
		fs.rmSync(path.join(SSL_SIDECAR, want, sib), { recursive: true, force: true });
	}
	return dir;
}

function detect() {
	const vs = detectVS();
	return {
		vs,
		cmake: onPath("cmake") || (vs && vs.cmake && path.join(vs.cmake, "cmake.exe")) || null,
		openssl: isWin ? detectOpenSSL(process.env.OPENSSL_VERSION || "3.5") : "(system)"
	};
}

function report(d) {
	console.log("--- toolchain ---");
	console.log("VS:", d.vs ? `${d.vs.installationPath} (v${d.vs.version})` : "not found");
	console.log("cmake:", d.cmake || "not found");
	console.log("openssl:", d.openssl || "not found (auto-downloaded on setup)");
}

// --- build-script surgery (idempotent, re-applied every run) ---

function patchBuildScript(vs, opensslRoot) {
	let src = fs.readFileSync(BUILD_SCRIPT, "utf8");
	const orig = src;
	if (isWin && vs && vs.generator) {
		src = src.replaceAll("Visual Studio 16 2019", vs.generator);
	}
	// Upstream bug: bare mkdirSync crashes on a stale dir.
	src = src.replace("fs.mkdirSync(buildDir);", "fs.mkdirSync(buildDir, { recursive: true });");
	// Slim flags (apps/examples off, C++11 threads so pthreads is never
	// consulted on Windows).
	src = src.replace("'-A', process.arch", "'-A', process.arch, '-DENABLE_APPS=OFF', '-DENABLE_EXAMPLES=OFF', '-DENABLE_STDCXX_SYNC=ON'");
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
		fs.writeFileSync(BUILD_SCRIPT, src);
		log("patched upstream build script for this run");
	}
}

// --- main flow ---

function ensureDep() {
	if (!fs.existsSync(path.join(DEP, "package.json"))) {
		log("fetching @eyevinn/srt (build scripts skipped by .npmrc)...");
		run("npm", ["install", "--ignore-scripts"], { cwd: ROOT, shell: isWin });
	}
}

function pinSrt() {
	const tag = (() => {
		const r = spawnSync("git", ["-C", SRT_DIR, "describe", "--tags", "--exact-match", "HEAD"], { encoding: "utf8" });
		return r.status === 0 ? String(r.stdout).trim() : null;
	})();
	if (tag !== SRT_TAG) {
		if (fs.existsSync(path.join(SRT_DIR, ".git"))) {
			run("git", ["-C", SRT_DIR, "fetch", "--tags", "origin"]);
			run("git", ["-C", SRT_DIR, "checkout", SRT_TAG]);
		}
		// No .git (fresh npm tree without deps yet): build script clones
		// at NODE_SRT_CHECKOUT below, so nothing to do here.
		log(`libsrt tag -> ${SRT_TAG} (was: ${tag || "none"})`);
	}
	// Stale cmake cache from another version would poison the configure.
	fs.rmSync(BUILD_DIR, { recursive: true, force: true });
}

function copyRuntimeDlls(opensslRoot) {
	// node_srt.node links the OpenSSL DLLs dynamically; they must sit next
	// to it or Windows loader fails at require() time.
	const outDir = path.join(DEP, "build", "Release");
	const binDir = path.join(opensslRoot, "bin");
	let copied = 0;
	for (const f of fs.readdirSync(binDir)) {
		if (/^lib(crypto|ssl)-.*\.dll$/i.test(f)) {
			fs.copyFileSync(path.join(binDir, f), path.join(outDir, f));
			copied++;
		}
	}
	if (!copied) {
		throw new Error("no libcrypto/libssl DLLs found in " + binDir);
	}
	log(`runtime DLLs -> build/Release (${copied} files)`);
}

async function main() {
	if (process.argv.includes("--check")) {
		report(detect());
		return;
	}
	ensureDep();
	if (!isWin) {
		// POSIX needs no surgery: the binding's own install script is
		// ./configure && make && node-gyp rebuild, which works against
		// system OpenSSL/pthreads. Just pin the tag and run it once.
		pinSrt();
		log(`building libsrt ${SRT_TAG} via upstream script...`);
		run(process.execPath, [BUILD_SCRIPT], {
			cwd: DEP,
			env: { ...process.env, NODE_SRT_CHECKOUT: SRT_TAG }
		});
		log("compiling N-API addon...");
		run("npm", ["--prefix", DEP, "run", "rebuild"], { shell: false });
		log(`done: libsrt ${SRT_TAG} + addon ready`);
		return;
	}
	const d = detect();
	// Session-only PATH, node-gyp style: VS-bundled cmake/ninja only.
	const prepend = [];
	if (d.vs && d.vs.cmake) {
		prepend.push(d.vs.cmake);
	}
	if (d.vs && d.vs.ninja) {
		prepend.push(d.vs.ninja);
	}
	if (prepend.length) {
		process.env.PATH = [...prepend, process.env.PATH].join(path.delimiter);
		log("session PATH += " + prepend.join(", "));
	}
	if (!d.cmake) {
		throw new Error("cmake not found: install VS C++ cmake component or put cmake on PATH (see --check)");
	}
	let opensslRoot = d.openssl;
	if (!opensslRoot) {
		opensslRoot = await fetchOpenSSL(process.env.OPENSSL_VERSION || "3.5");
	}
	log("OpenSSL: " + opensslRoot);
	pinSrt();
	patchBuildScript(d.vs, opensslRoot);
	log(`building libsrt ${SRT_TAG} (single configure)...`);
	run(process.execPath, [BUILD_SCRIPT], {
		cwd: DEP,
		env: { ...process.env, NODE_SRT_CHECKOUT: SRT_TAG, OPENSSL_ROOT_DIR: opensslRoot }
	});
	log("compiling N-API addon (configure, retarget ClangCL->MSVC, build)...");
	// The installed node was built with clang=1 stamped in its config, so
	// gyp emits <PlatformToolset>ClangCL</PlatformToolset>, which VS Build
	// Tools SKUs don't ship (and -D/GYP_DEFINES can't override it: the
	// value comes from process.config via common.gypi, not defines).
	// Configure first, rewrite the toolset to the detected VS major
	// (v143 for VS17), then build. node-addon-api's nothing.vcxproj gets
	// the same treatment; it fails the build otherwise. The dep nests its
	// own copy under @eyevinn/node-addon-api (hoisted copy also covered).
	const toolset = d.vs && d.vs.major >= 17 ? `v${126 + d.vs.major}` : "v143";
	run("npx", ["node-gyp", "configure"], { cwd: DEP, shell: isWin });
	for (const proj of [
		path.join(DEP, "build", "node_srt.vcxproj"),
		path.join(DEP, "node_modules", "node-addon-api", "nothing.vcxproj"),
		path.join(ROOT, "node_modules", "@eyevinn", "node-addon-api", "nothing.vcxproj"),
		path.join(ROOT, "node_modules", "node-addon-api", "nothing.vcxproj")
	]) {
		if (fs.existsSync(proj)) {
			const before = fs.readFileSync(proj, "utf8");
			const after = before.replaceAll("<PlatformToolset>ClangCL</PlatformToolset>", `<PlatformToolset>${toolset}</PlatformToolset>`);
			if (after !== before) {
				fs.writeFileSync(proj, after);
				log(`retargeted ${path.basename(proj)} -> ${toolset}`);
			}
		}
	}
	run("npx", ["node-gyp", "build"], { cwd: DEP, shell: isWin });
	const lib = isWin ? "srt.lib" : "libsrt.a";
	if (!fs.existsSync(path.join(BUILD_DIR, isWin ? "Release" : "lib", lib))) {
		throw new Error("build finished but lib missing; check output above");
	}
	if (isWin) {
		copyRuntimeDlls(opensslRoot);
	}
	log(`done: libsrt ${SRT_TAG} + OpenSSL + addon ready`);
}

(async () => {
	try {
		await main();
	} catch (err) {
		console.error("[setup] " + err.message);
		process.exit(1);
	}
})();
