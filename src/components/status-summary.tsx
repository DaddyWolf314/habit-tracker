import type { CoupleStatus, Session } from "#/shared/identity.ts";
import type { Role } from "#/shared/roles.ts";

/**
 * How each couple status reads to a person (#149). The stored value is a
 * lifecycle marker — "dissolved" is a database word, not something you say —
 * so each one is spelled out against `CONTEXT.md`'s vocabulary: **pairing** is
 * the flow that binds the second member, an **active** couple is one whose
 * **dynamic** has been activated by mutual role confirmation, and **dissolve**
 * is the domain's own word for the ending (never "cancel" or "leave").
 */
const STATUS_LABELS: Record<CoupleStatus, string> = {
	pairing: "Pairing in progress",
	active: "Dynamic active",
	dissolved: "Dissolved",
};

/**
 * How each role reads (#149). Capitalization and nothing more, deliberately:
 * `roleSchema`'s docstring calls these three *permission buckets* and puts
 * custom labels in settings, so spelling them out here ("Dominant") would print
 * a name the couple never chose and pre-empt the labels they will. A label the
 * couple sets later replaces the value on the left of this map, not the words.
 */
const ROLE_LABELS: Record<Role, string> = {
	dom: "Dom",
	sub: "Sub",
	switch: "Switch",
};

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
			<dd className="font-medium">{STATUS_LABELS[session.status]}</dd>
			<dt className="text-muted-foreground">Members</dt>
			{/* "1 of 2" is the whole story on the pre-dynamic home, so it stays
			    exactly as phrased — #149 scoped the count out on purpose. */}
			<dd className="font-medium">{session.member_count} of 2</dd>
			<dt className="text-muted-foreground">Your role</dt>
			<dd className="font-medium">
				{session.role === null ? "Not set" : ROLE_LABELS[session.role]}
			</dd>
		</dl>
	);
}
