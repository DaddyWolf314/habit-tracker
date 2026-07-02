import { DurableObject } from "cloudflare:workers";
import type { CoupleStatus, Device, Session } from "#/shared/identity.ts";
import { coupleError } from "./errors.ts";
import { runMigrations } from "./migrations.ts";

interface MemberRow {
	id: string;
	identity_hash: string;
	role: string | null;
	joined_at: number;
	[key: string]: SqlStorageValue;
}

interface DeviceRow {
	device_id: string;
	token_hash: string;
	label: string | null;
	created_at: number;
	revoked_at: number | null;
	[key: string]: SqlStorageValue;
}

/**
 * CoupleDO — one SQLite-backed Durable Object per couple (handoff §3.2). It owns
 * all relationship data: members, roles, devices, the event log, amendments,
 * rules, projections, schedules, and the live WebSocket sessions. Correctness-
 * critical sequences (pairing, event append → rule eval → projection update →
 * broadcast, pause-everything) run serialized in this single event loop.
 *
 * Phase 1 adds the identity/pairing state machine: binding members, minting and
 * revoking device tokens, the invite flow, and mutual role confirmation. The
 * rules engine and live projections still land in later phases.
 */
export class CoupleDO extends DurableObject<Env> {
	private readonly sql: SqlStorage;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.sql = ctx.storage.sql;
		// Lazy, idempotent per-DO migrations; block so no request sees a
		// half-migrated schema (handoff §3.5).
		ctx.blockConcurrencyWhile(async () => {
			runMigrations(this.sql);
		});
	}

	// ── Couple / member state ────────────────────────────────────────────────

	/**
	 * Binds the founding partner and opens the couple for pairing. Rejects if the
	 * couple already has any member — a DO is created fresh per couple.
	 */
	async createCouple(identityHash: string): Promise<{ member_id: string }> {
		if (this.members().length > 0) {
			throw coupleError("CONFLICT", "couple already created");
		}
		const memberId = crypto.randomUUID();
		this.sql.exec(
			`INSERT INTO members (id, identity_hash, role, joined_at) VALUES (?, ?, NULL, ?)`,
			memberId,
			identityHash,
			Date.now(),
		);
		this.setSetting("status", "pairing");
		this.setSetting("invitations_closed", "0");
		return { member_id: memberId };
	}

	/**
	 * Binds the second partner via a redeemed invite and permanently closes
	 * invitations — so no third member can ever be added (handoff §2). Rejects if
	 * the couple is already full, invitations are closed, or the identity is
	 * already a member.
	 */
	async joinCouple(identityHash: string): Promise<{ member_id: string }> {
		if (this.getSetting("invitations_closed") === "1") {
			throw coupleError("GONE", "invitations are closed");
		}
		const members = this.members();
		if (members.length === 0)
			throw coupleError("BAD_REQUEST", "couple not initialized");
		if (members.length >= 2) throw coupleError("CONFLICT", "couple is full");
		if (members.some((m) => m.identity_hash === identityHash)) {
			throw coupleError("CONFLICT", "already a member of this couple");
		}
		const memberId = crypto.randomUUID();
		this.sql.exec(
			`INSERT INTO members (id, identity_hash, role, joined_at) VALUES (?, ?, NULL, ?)`,
			memberId,
			identityHash,
			Date.now(),
		);
		// Permanently close the couple to further members.
		this.setSetting("invitations_closed", "1");
		return { member_id: memberId };
	}

	/** Whoami for a member, plus couple-level status. */
	async getState(identityHash: string): Promise<Session> {
		const member = this.memberByIdentity(identityHash);
		if (!member) throw coupleError("NOT_FOUND", "not a member of this couple");
		const status = this.status();
		return {
			couple_do_id: this.ctx.id.toString(),
			member_id: member.id,
			identity_hash: identityHash,
			role: (member.role as Session["role"]) ?? null,
			status,
			member_count: this.members().length,
			invitations_closed: this.getSetting("invitations_closed") === "1",
			roles_active: status === "active",
		};
	}

	// ── Device tokens (handoff §2) ───────────────────────────────────────────

	/** Records a newly minted device token in the caller's member record. */
	async addDevice(
		identityHash: string,
		tokenHash: string,
		label: string | null,
	): Promise<Device> {
		const member = this.memberByIdentity(identityHash);
		if (!member) throw coupleError("NOT_FOUND", "not a member of this couple");
		const deviceId = crypto.randomUUID();
		const now = Date.now();
		this.sql.exec(
			`INSERT INTO devices (token_hash, member_id, label, created_at, revoked_at, device_id)
				VALUES (?, ?, ?, ?, NULL, ?)`,
			tokenHash,
			member.id,
			label,
			now,
			deviceId,
		);
		return {
			device_id: deviceId,
			label,
			created_at: now,
			revoked_at: null,
			current: false,
		};
	}

	/**
	 * Lists the caller's devices for the "your devices" panel. The token hash is
	 * never returned; the device the caller is using is flagged `current`.
	 */
	async listDevices(
		identityHash: string,
		callerCredentialHash: string,
	): Promise<Device[]> {
		const member = this.memberByIdentity(identityHash);
		if (!member) throw coupleError("NOT_FOUND", "not a member of this couple");
		return this.devicesOf(member.id).map((row) => ({
			device_id: row.device_id,
			label: row.label,
			created_at: row.created_at,
			revoked_at: row.revoked_at,
			current: row.token_hash === callerCredentialHash,
		}));
	}

	/**
	 * Revokes one device and returns its token hash so the caller can flip the
	 * matching routing-layer credential to revoked (auth rejects it thereafter).
	 */
	async revokeDevice(
		identityHash: string,
		deviceId: string,
	): Promise<{ token_hash: string }> {
		const member = this.memberByIdentity(identityHash);
		if (!member) throw coupleError("NOT_FOUND", "not a member of this couple");
		const device = this.devicesOf(member.id).find(
			(d) => d.device_id === deviceId,
		);
		if (!device) throw coupleError("NOT_FOUND", "no such device");
		if (device.revoked_at === null) {
			this.sql.exec(
				`UPDATE devices SET revoked_at = ? WHERE device_id = ?`,
				Date.now(),
				deviceId,
			);
		}
		return { token_hash: device.token_hash };
	}

	// ── SQL helpers ──────────────────────────────────────────────────────────

	protected devicesOf(memberId: string): DeviceRow[] {
		return this.sql
			.exec<DeviceRow>(
				`SELECT device_id, token_hash, label, created_at, revoked_at
					FROM devices WHERE member_id = ? ORDER BY created_at`,
				memberId,
			)
			.toArray();
	}

	protected members(): MemberRow[] {
		return this.sql
			.exec<MemberRow>(`SELECT id, identity_hash, role, joined_at FROM members`)
			.toArray();
	}

	protected memberByIdentity(identityHash: string): MemberRow | undefined {
		return this.sql
			.exec<MemberRow>(
				`SELECT id, identity_hash, role, joined_at FROM members WHERE identity_hash = ?`,
				identityHash,
			)
			.toArray()[0];
	}

	protected status(): CoupleStatus {
		return (this.getSetting("status") as CoupleStatus | undefined) ?? "pairing";
	}

	protected getSetting(key: string): string | undefined {
		return this.sql
			.exec<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key)
			.toArray()[0]?.value;
	}

	protected setSetting(key: string, value: string): void {
		this.sql.exec(
			`INSERT INTO settings (key, value) VALUES (?, ?)
				ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
			key,
			value,
		);
	}

	// ── WebSocket + alarms ───────────────────────────────────────────────────

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get("Upgrade") === "websocket") {
			return this.acceptSocket();
		}
		// Placeholder command surface; Phase 1+ routes real commands here.
		return new Response("CoupleDO OK", { status: 200 });
	}

	/** Upgrades to a hibernatable WebSocket held open for live sync. */
	private acceptSocket(): Response {
		const { 0: client, 1: server } = new WebSocketPair();
		// Hibernation API: the runtime can evict the DO from memory while the
		// socket stays open, so two long-idle connections per couple cost ~nothing.
		this.ctx.acceptWebSocket(server);
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		// Phase 0 skeleton: reply so the socket path is verifiable end to end.
		// Real client/server protocol handling arrives with live projections.
		void message;
		ws.send(JSON.stringify({ type: "pong" }));
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
		_wasClean: boolean,
	): Promise<void> {
		ws.close(code, reason);
	}

	override async webSocketError(
		_ws: WebSocket,
		_error: unknown,
	): Promise<void> {
		// Skeleton: nothing to clean up yet.
	}

	override async alarm(): Promise<void> {
		// Single-alarm scheduler (handoff §3.2): on fire, process everything due
		// in `schedule`, then re-arm at MIN(next_fire_at). Built in Phase 4.
	}
}
