import { z } from "zod";
import { describeTraceRow, type TraceRow, type TraceTone } from "./trace.ts";

/**
 * Support introspection (handoff §3.5) — the audited answer to "why did this
 * projection change." It is deliberately *not* a global query escape hatch:
 * introspection only ever reaches one couple's Durable Object, and every access
 * is written to that DO's own audit log, so a support read is transparent
 * relationship data, never a silent backdoor. This module owns the pure part —
 * turning a projection's Trace-ledger rows into an explanation; the DO adds the
 * audit-log write.
 */

/** What a client asks to introspect: one projection key, e.g. `counter:foo`. */
export const introspectInputSchema = z.object({
	projection: z.string().min(1),
});
export type IntrospectInput = z.infer<typeof introspectInputSchema>;

/**
 * An append-only audit-log row: who introspected which projection, and when.
 * `action` is currently always `"introspect"`; kept as a column so future
 * audited reads share one log.
 */
export interface AuditEntry {
	id: number;
	at: number;
	actor: string;
	action: string;
	target: string | null;
}

/** One line of the causal chain — a described trace row, flattened for RPC. */
export interface ExplanationLine {
	id: number;
	at: number;
	tone: TraceTone;
	summary: string;
	note?: string;
}

/** The causal explanation for one projection: a headline plus the full chain. */
export interface ProjectionExplanation {
	projection: string;
	/** The most recent change's one-line answer, or a no-history note. */
	headline: string;
	/** Every recorded change to the projection, newest first. */
	chain: ExplanationLine[];
}

/** An introspection's result: the explanation plus the audit row it appended. */
export interface IntrospectionResult {
	explanation: ProjectionExplanation;
	audit: AuditEntry;
}

/**
 * Explains a projection from its Trace-ledger rows (expected newest-first, as the
 * DO queries them). The newest row is the headline — the direct answer to "why
 * did this just change" — and the whole chain is carried for the drill-in. An
 * empty history degrades to a plain note rather than throwing: the audit surface
 * must never crash on a projection that has no recorded changes.
 */
export function explainProjection(
	projection: string,
	rows: TraceRow[],
): ProjectionExplanation {
	const chain: ExplanationLine[] = rows.map((row) => {
		const line = describeTraceRow(row);
		return {
			id: row.id,
			at: row.at,
			tone: line.tone,
			summary: line.summary,
			...(line.note !== undefined ? { note: line.note } : {}),
		};
	});
	const headline =
		chain.length > 0
			? chain[0].summary
			: `No recorded changes for ${projection}.`;
	return { projection, headline, chain };
}
