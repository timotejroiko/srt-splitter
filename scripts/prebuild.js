"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const platform = process.env.PREBUILD_PLATFORM || process.platform;
const arch = process.env.PREBUILD_ARCH || process.arch;
const sourceDir = path.join(ROOT, "node_modules", "@eyevinn", "srt", "build", "Release");
const outputDir = path.join(ROOT, "prebuilds", `${platform}-${arch}`);
const nativeSource = path.join(sourceDir, "node_srt.node");

const runtimePattern = {
	win32: /\.dll$/i,
	linux: /\.so(?:\.\d+)*$/i,
	darwin: /\.dylib(?:\.\d+)*$/i
}[platform];

if (!runtimePattern) {
	throw new Error(`unsupported prebuild platform: ${platform}`);
}
if (!fs.existsSync(nativeSource)) {
	throw new Error(`native addon not found: ${nativeSource}; run npm run setup first`);
}

fs.rmSync(outputDir, { recursive: true, force: true });
fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(nativeSource, path.join(outputDir, "srt.node"));

const runtimeFiles = fs.readdirSync(sourceDir)
	.filter((name) => runtimePattern.test(name))
	.map((name) => path.join(sourceDir, name));
for (const source of runtimeFiles) {
	fs.copyFileSync(source, path.join(outputDir, path.basename(source)));
}

console.log(`prebuilt ${platform}-${arch}: srt.node${runtimeFiles.length ? ` + ${runtimeFiles.length} runtime libraries` : ""}`);
