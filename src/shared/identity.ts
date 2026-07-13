import { z } from "zod";
import { type Role, roleSchema } from "./roles.ts";

/**
 * Identity, device, pairing, and role-confirmation contracts (handoff §2). The
 * bearer credential travels in the `Authorization: Bearer <secret>` header; the
 * server hashes it and never stores plaintext. These schemas are the shape of
 * the JSON API between the client and the Worker routes.
 */

/** A member's lifecycle-relevant state, as seen by the caller. */
export const coupleStatusSchema = z.enum(["pairing", "active", "dissolved"]);
export type CoupleStatus = z.infer<typeof coupleStatusSchema>;

/** Result of creating a brand-new identity + couple (Partner A). */
export const createIdentityResultSchema = z.object({
	couple_do_id: z.string(),
	member_id: z.string(),
});
export type CreateIdentityResult = z.infer<typeof createIdentityResultSchema>;

/** Whoami for an authenticated request. */
export const sessionSchema = z.object({
	couple_do_id: z.string(),
	member_id: z.string(),
	identity_hash: z.string(),
	role: roleSchema.nullable(),
	status: coupleStatusSchema,
	member_count: z.number().int(),
	invitations_closed: z.boolean(),
	roles_active: z.boolean(),
	/** Safeword engaged: all tracking frozen, no consequences accrue (#40). */
	paused: z.boolean(),
	/** A partner-assisted recovery is in progress; either member may cancel (#41). */
	recovery_pending: z.boolean(),
});
export type Session = z.infer<typeof sessionSchema>;

/** A registered device in the "your devices" panel. */
export const deviceSchema = z.object({
	device_id: z.string(),
	label: z.string().nullable(),
	created_at: z.number().int(),
	revoked_at: z.number().int().nullable(),
	current: z.boolean(),
});
export type Device = z.infer<typeof deviceSchema>;

/** Newly minted device token — the raw token is returned exactly once. */
export const mintDeviceResultSchema = z.object({
	token: z.string(),
	device: deviceSchema,
});
export type MintDeviceResult = z.infer<typeof mintDeviceResultSchema>;

export const mintDeviceInputSchema = z.object({
	label: z.string().max(100).optional(),
});
export const revokeDeviceInputSchema = z.object({
	device_id: z.string(),
});

/** A short-lived, single-use invitation for the second partner. */
export const inviteResultSchema = z.object({
	code: z.string(),
	expires_at: z.number().int(),
});
export type InviteResult = z.infer<typeof inviteResultSchema>;

export const redeemInviteInputSchema = z.object({
	code: z.string(),
});

/**
 * A proposed role assignment: member id → role. Both partners must confirm the
 * same assignment before the dynamic activates (handoff §2, pairing flow).
 */
export const roleAssignmentSchema = z.record(z.string(), roleSchema);
export type RoleAssignment = z.infer<typeof roleAssignmentSchema>;

export const proposeRolesInputSchema = z.object({
	assignment: roleAssignmentSchema,
});

/** A member as shown in the role-confirmation UI. */
export const roleMemberSchema = z.object({
	member_id: z.string(),
	role: roleSchema.nullable(),
	is_self: z.boolean(),
});
export type RoleMember = z.infer<typeof roleMemberSchema>;

export const roleConfirmationStateSchema = z.object({
	members: z.array(roleMemberSchema),
	assignment: roleAssignmentSchema.nullable(),
	proposed_by: z.string().nullable(),
	confirmed_by: z.array(z.string()),
	active: z.boolean(),
});
export type RoleConfirmationState = z.infer<typeof roleConfirmationStateSchema>;

/** One entry in the append-only agreement/consent history. */
export const consentEntrySchema = z.object({
	id: z.string(),
	at: z.number().int(),
	kind: z.string(),
	detail: z.string().nullable(),
});
export type ConsentEntry = z.infer<typeof consentEntrySchema>;

/**
 * A flat, RPC-serializable record. Used for the export's event/counter rows,
 * which are empty in Phase 1 and gain real shapes in later phases (kept
 * non-recursive so it crosses the Durable Object RPC boundary cleanly).
 */
export type ExportRow = Record<string, string | number | boolean | null>;

/**
 * A member's exportable view of the relationship (handoff §2, abuse-edge). Any
 * authenticated member can export at any time. Every relationship surface is
 * present: the event log and its amendments (which together reconstruct the
 * composite truth), the installed rules, and the counter/timer/anchor
 * projections — "the member's full view" the abuse-edge mitigation requires.
 */
export interface CoupleExport {
	exported_at: number;
	couple_do_id: string;
	status: CoupleStatus;
	self: { member_id: string; role: Role | null };
	members: Array<{ member_id: string; role: Role | null }>;
	devices: Device[];
	consent_history: ConsentEntry[];
	events: ExportRow[];
	amendments: ExportRow[];
	rules: ExportRow[];
	counters: ExportRow[];
	timers: ExportRow[];
	anchors: ExportRow[];
}
