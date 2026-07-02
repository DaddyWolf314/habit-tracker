import { defineConfig } from "drizzle-kit";

/**
 * Drizzle config for the D1 routing database. `db:generate` diffs the schema to
 * SQL under ./migrations/d1; wrangler applies those to D1 (see the
 * `migrations_dir` on the D1 binding in wrangler.jsonc).
 *
 * `db:studio`/`db:push` against remote D1 additionally need the `d1-http`
 * driver plus credentials (account id, database id, API token) — wire those in
 * once the D1 database exists.
 */
export default defineConfig({
	out: "./migrations/d1",
	schema: "./src/db/schema.ts",
	dialect: "sqlite",
});
