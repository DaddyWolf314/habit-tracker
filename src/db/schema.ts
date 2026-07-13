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

/**
 * Short-lived, single-use pairing invitations (handoff §2, pairing flow). Lives
 * in the routing layer so the second partner can be routed to the couple's DO
 * at redeem time — before they are a member. Only the code hash is stored; the
 * code itself is a brief bearer credential for joining.
 */
export const invites = sqliteTable(
	"invites",
	{
		codeHash: text("code_hash").primaryKey(),
		coupleDoId: text("couple_do_id").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		usedAt: integer("used_at", { mode: "timestamp" }),
	},
	(table) => [index("invites_couple_idx").on(table.coupleDoId)],
);

export type Invite = typeof invites.$inferSelect;

/**
 * Single-use partner-assisted recovery codes (handoff §2, #41). Like an invite,
 * this lives in the routing layer purely to route the lost-token member's *fresh*
 * identity to the couple's DO at redeem time — before it is bound. The DO owns
 * the recovery state machine (waiting period, approval, rebind); this table only
 * bridges the code. Only the code hash is stored.
 */
export const recoveries = sqliteTable(
	"recoveries",
	{
		codeHash: text("code_hash").primaryKey(),
		coupleDoId: text("couple_do_id").notNull(),
		/** The member slot being recovered, echoed back to the redeemer. */
		memberId: text("member_id").notNull(),
		createdAt: integer("created_at", { mode: "timestamp" })
			.notNull()
			.default(sql`(unixepoch())`),
		expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
		usedAt: integer("used_at", { mode: "timestamp" }),
	},
	(table) => [index("recoveries_couple_idx").on(table.coupleDoId)],
);

export type Recovery = typeof recoveries.$inferSelect;
