import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema.ts";

/**
 * Drizzle client bound to the D1 routing database. Constructed per request from
 * the Worker's `DB` binding — D1 is accessed through a binding, not a URL, so
 * there is no module-level singleton.
 */
export function getRoutingDb(d1: D1Database) {
	return drizzle(d1, { schema });
}

export type RoutingDb = ReturnType<typeof getRoutingDb>;
