import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { handleApi } from "./worker/api/router.ts";
import { coupleStub } from "./worker/routing.ts";

/**
 * Custom Worker entry (replaces `@tanstack/react-start/server-entry`). It wraps
 * the TanStack Start request handler, forwards the WebSocket upgrade to the
 * couple's Durable Object, and — crucially — re-exports the DO class so the
 * runtime can instantiate it.
 */
const handleStart = createStartHandler(defaultStreamHandler);

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<Response> {
		const url = new URL(request.url);

		// WebSocket upgrade → the couple's DO holds the live-sync socket.
		if (url.pathname === "/api/ws") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("expected websocket", { status: 426 });
			}
			// Phase 0: couple id via query param. Phase 1 resolves it from the
			// bearer credential through the D1 routing table instead.
			const coupleId = url.searchParams.get("couple");
			if (!coupleId) {
				return new Response("missing couple", { status: 400 });
			}
			return coupleStub(env, coupleId).fetch(request);
		}

		// JSON API: identity, devices, pairing, roles, dissolve/export.
		if (url.pathname.startsWith("/api/")) {
			return handleApi(request, env);
		}

		// Everything else — SSR, server functions, API routes — is TanStack Start.
		// It reads Cloudflare bindings from the `cloudflare:workers` env global.
		return handleStart(request);
	},
};

export { CoupleDO } from "./worker/do/couple-do.ts";
