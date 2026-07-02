import { DurableObject } from "cloudflare:workers";
import type { CoupleStatus, Session } from "#/shared/identity.ts";
import { coupleError } from "./errors.ts";
import { runMigrations } from "./migrations.ts";

interface MemberRow {
	id: string;
	identity_hash: string;
	role: string | null;
	joined_at: number;
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

	// ── SQL helpers ──────────────────────────────────────────────────────────

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
