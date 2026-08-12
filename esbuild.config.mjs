import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import { copyFileSync, existsSync } from "node:fs";

const banner = `/*
Bundled build output for the Finance Obsidian plugin. Edit source under src/, not this file.
*/
`;

const prod = process.argv[2] === "production";

// Obsidian can't be pointed at this repo directly, so nothing shows up in the vault until main.js/
// manifest.json/styles.css are copied into its plugins folder. Doing that copy here, on every build,
// means a plain `npm run build` (or a live `npm run dev` rebuild) is always enough — no separate manual
// deploy step to forget. Override FP_VAULT_PLUGIN_DIR for a different machine/vault; missing dir = no-op.
const VAULT_PLUGIN_DIR = process.env.FP_VAULT_PLUGIN_DIR ?? "C:/Users/gaura/Obsidian/.obsidian/plugins/managemyfinance";

function deployToVault() {
	if (!existsSync(VAULT_PLUGIN_DIR)) return;
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		copyFileSync(file, `${VAULT_PLUGIN_DIR}/${file}`);
	}
	console.log(`[deploy] synced main.js, manifest.json, styles.css -> ${VAULT_PLUGIN_DIR}`);
}

const context = await esbuild.context({
	banner: { js: banner },
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2018",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	plugins: [{ name: "deploy-to-vault", setup: (build) => build.onEnd(deployToVault) }],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
