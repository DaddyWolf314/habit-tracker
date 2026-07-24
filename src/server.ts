import {
	createStartHandler,
	defaultStreamHandler,
} from "@tanstack/react-start/server";
import { handleApi } from "./worker/api/router.ts";
import { authenticateToken, bearerToken } from "./worker/auth.ts";
import { coupleStubById } from "./worker/routing.ts";

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

		// WebSocket upgrade → the couple's DO holds the live-sync socket. The DO
		// is resolved from the caller's bearer credential through the D1 routing
		// table — never from client input — so a socket can only ever reach its
		// own couple's DO. The browser WebSocket API can't set headers, so the
		// token may arrive via `?token=` instead of `Authorization`.
		if (url.pathname === "/api/ws") {
			if (request.headers.get("Upgrade") !== "websocket") {
				return new Response("expected websocket", { status: 426 });
			}
			const token = bearerToken(request) ?? url.searchParams.get("token");
			const auth = token ? await authenticateToken(token, env) : null;
			if (!auth) {
				return new Response("unauthorized", { status: 401 });
			}
			return coupleStubById(env, auth.coupleDoId).fetch(request);
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
