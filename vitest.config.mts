import { defineConfig } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const here = fileURLToPath(new URL(".", import.meta.url));

/**
 * `obsidian` is provided by the host app at runtime and has no npm implementation to import, so any
 * module that touches it was previously untestable — which is exactly how the riskiest file in the
 * repo (store.ts, and its CSV schema migrations) ended up with no tests at all. Aliasing it to a
 * small in-memory stub makes those modules importable under the test runner without changing a line
 * of production code.
 */
export default defineConfig({
	resolve: {
		alias: {
			obsidian: resolve(here, "test/obsidianStub.ts"),
		},
	},
});
