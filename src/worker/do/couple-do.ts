import { DurableObject } from "cloudflare:workers";
import { runMigrations } from "./migrations.ts";

/**
 * CoupleDO — one SQLite-backed Durable Object per couple (handoff §3.2). It owns
 * all relationship data: members, roles, devices, the event log, amendments,
 * rules, projections, schedules, and the live WebSocket sessions. Correctness-
 * critical sequences (pairing, event append → rule eval → projection update →
 * broadcast, pause-everything) run serialized in this single event loop.
 *
 * This is the Phase 0 skeleton: schema migrations run on wake, the WebSocket
 * upgrade + hibernation handlers are wired, and the alarm entry point exists.
 * Command handling and the rules engine land in later phases.
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
