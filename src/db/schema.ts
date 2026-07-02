import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * D1 routing layer (handoff §3.3). Maps a bearer credential to the couple's
 * Durable Object — and *nothing else*. Membership, roles, devices, and all
 * relationship data live inside the CoupleDO, so this table cannot enumerate
 * any couple's contents. Privacy is structural, not policy.
 *
 * A credential is either the root secret (the recovery phrase) or a per-device
 * token; both resolve to the same identity and couple. Only the hash is stored,
 * treated like a password hash.
 */
export const credentials = sqliteTable(
	"credentials",
	{
		/** SHA-256 of the bearer token presented in the Authorization header. */
		credentialHash: text("credential_hash").primaryKey(),
		/** Stable per-member identity; survives device token rotation. */
		identityHash: text("identity_hash").notNull(),
		/** Hex id of the couple's Durable Object. */
		coupleDoId: text("couple_do_id").notNull(),
		kind: text("kind", { enum: ["root", "device"] }).notNull(),
		label: text("label"),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		/** Set when revoked (device logout, recovery rebind). Non-null ⇒ rejected. */
		revokedAt: integer("revoked_at", { mode: "timestamp" }),
	},
	(table) => [index("credentials_identity_idx").on(table.identityHash)],
);

export type Credential = typeof credentials.$inferSelect;
export type NewCredential = typeof credentials.$inferInsert;
