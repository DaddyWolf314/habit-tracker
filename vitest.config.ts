import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Standalone Vitest config. Deliberately does NOT load vite.config.ts (and its
 * Cloudflare plugin, which rejects Vitest's worker environment options). Unit
 * tests here cover isomorphic logic — crypto, identity, schemas — in plain Node;
 * full DO/Worker flows are exercised against the dev server.
 */
export default defineConfig({
	resolve: {
		alias: [{ find: /^#\//, replacement: `${fileURLToPath(new URL("./src", import.meta.url))}/` }],
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.{ts,tsx}"],
	},
});
