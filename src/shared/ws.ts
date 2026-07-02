import { z } from "zod";

/**
 * WebSocket protocol between the client and its CoupleDO (handoff §3.4). Both
 * partners hold a hibernating socket into the same DO for live sync. This is
 * the Phase 0 skeleton — enough to prove the upgrade path end to end; live
 * projection payloads are fleshed out in later phases.
 */

/** Client → server. */
export const clientMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("ping") }),
	z.object({ type: z.literal("subscribe") }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

/** Server → client. */
export const serverMessageSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("pong") }),
	z.object({ type: z.literal("hello"), couple_id: z.string() }),
	z.object({ type: z.literal("projection_update"), payload: z.unknown() }),
	z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;
