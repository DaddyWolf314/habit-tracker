import type { Visibility } from "#/shared/roles.ts";

/**
 * The journal-entry visibility control (ADR 0001), shared by every surface that
 * writes one — the Log composer and the Today prompt-answer form today.
 *
 * It exists because the three levels are *copy that must not drift*: the same
 * level described two ways on two screens is a privacy control that reads
 * differently depending on where you met it. Owning the option list here also
 * makes the property #94 was filed about structural rather than repeated — the
 * blank first option is the only initial value this control can have, so a
 * surface cannot accidentally preselect `shared` and log an unmade choice at the
 * most-exposed level.
 *
 * Deliberately renders the bare `<select>` and nothing around it: the two call
 * sites label their fields differently (one through the composer's `Field`, one
 * through its own label), and unifying that too would be a layout decision this
 * component has no business making.
 */
export function VisibilitySelect({
	className,
	value,
	onChange,
}: {
	className?: string;
	/** `""` is "not yet chosen" — never a level, and never submittable. */
	value: Visibility | "";
	onChange: (value: Visibility | "") => void;
}) {
	return (
		<select
			className={className}
			value={value}
			onChange={(e) => onChange(e.target.value as Visibility | "")}
		>
			<option value="">Choose who can see this…</option>
			<option value="shared">Shared — my partner can read this</option>
			<option value="sealed">
				Sealed — they see that I journaled, not the words
			</option>
			<option value="secret">
				Secret — fully private; they can't tell it exists
			</option>
		</select>
	);
}

/** The field label both surfaces use, so "required" is worded once. */
export const VISIBILITY_LABEL = "Visibility (required)";
