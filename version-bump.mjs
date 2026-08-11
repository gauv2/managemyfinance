import { readFileSync, writeFileSync } from "fs";

// Run by `npm version <patch|minor|major>` (see the "version" script in package.json).
// Keeps manifest.json and versions.json in step with package.json, so the git tag
// npm creates matches manifest.json exactly — which is what BRAT and Obsidian's
// own updater use to locate the release assets.

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
	console.error("version-bump.mjs must be run via `npm version`, not directly.");
	process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", JSON.stringify(versions, null, "\t") + "\n");

console.log(`Bumped manifest.json and versions.json to ${targetVersion} (minAppVersion ${minAppVersion}).`);
