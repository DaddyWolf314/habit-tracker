import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = fileURLToPath(new URL("./src", import.meta.url));

/**
 * Standalone Vitest config. Deliberately does NOT load vite.config.ts (and its
 * Cloudflare plugin, which rejects Vitest's worker environment options).
 *
 * Two tiers run here. Unit tests cover isomorphic logic — crypto, identity,
 * schemas — in plain Node. `couple-do.test.ts` drives the real `CoupleDO` over
 * a `better-sqlite3`-backed `SqlStorage`, the same engine the DO embeds (#164,
 * `src/worker/do/harness.ts`); what stays verifiable only against the platform
 * — alarm *firing*, hibernation, WebSockets — is still exercised against the
 * dev server.
 */
export default defineConfig({
	resolve: {
		alias: [
			// `couple-do.ts` imports the `DurableObject` base class from a module
			// only workerd provides. The stub supplies the two fields `super()`
			// sets; everything else comes off the injected `DurableObjectState`.
			{
				find: /^cloudflare:workers$/,
				replacement: `${src}/worker/do/cloudflare-workers.stub.ts`,
			},
			{ find: /^#\//, replacement: `${src}/` },
		],
	},
	test: {
		environment: "node",
		include: ["src/**/*.test.{ts,tsx}"],
	},
});
