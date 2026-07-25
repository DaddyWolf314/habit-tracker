import type { Session } from "#/shared/identity.ts";

/**
 * Where the couple stands: paired or not, and which role you hold. Both ends of
 * the dynamic's lifecycle want it — the pre-dynamic home, where "1 of 2" is the
 * whole story, and Settings, where it is the readout you go looking for (#85) —
 * so it lives on its own rather than in either surface's file.
 */
export function StatusSummary({ session }: { session: Session }) {
	return (
		<dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
			<dt className="text-muted-foreground">Status</dt>
			<dd className="font-medium">{session.status}</dd>
			<dt className="text-muted-foreground">Members</dt>
			<dd className="font-medium">{session.member_count} of 2</dd>
			<dt className="text-muted-foreground">Your role</dt>
			<dd className="font-medium">{session.role ?? "not set"}</dd>
		</dl>
	);
}
