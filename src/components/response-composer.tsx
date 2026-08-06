import { useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { amendEvent } from "#/lib/api.ts";

/**
 * The one place a `response` amendment is written (ADR 0001, broadened by ADR
 * 0007): the partner's warm reaction to something the other logged.
 *
 * Shared rather than per-surface because #183 grew the second caller. The
 * conversation-flags reply was the only UI that emitted a response for as long as
 * the amendment existed; the log row now emits one too, and a response written
 * from the log is not a different act from a response written on Today — same
 * amendment, same rules, same required prose. Two copies of this form would be
 * two places to fix when either changes.
 *
 * **Prose is required**, and that is the whole difference between this and a
 * dismissable chip: a response *is* the reaction, not an acknowledgement of one,
 * so there has to be somewhere to answer. There is no visibility choice — a
 * response inherits nothing and reveals nothing; `validateResponse` has already
 * refused the one visibility that matters (`secret`) before this renders.
 */
export function ResponseComposer({
	eventId,
	submitLabel,
	placeholder = "Say something back.",
	onCancel,
	onResponded,
}: {
	eventId: string;
	/** The affordance's own word for sending — "Reply" on Today, "Respond" in the log. */
	submitLabel: string;
	placeholder?: string;
	onCancel: () => void;
	onResponded: () => void;
}) {
	const [note, setNote] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		if (!note.trim()) {
			setError("Write something back.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await amendEvent({
				kind: "response",
				target_event_id: eventId,
				note: note.trim(),
			});
			onResponded();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't send that.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-2 space-y-2">
			<Textarea
				placeholder={placeholder}
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<div className="flex gap-2">
				<Button onClick={submit} disabled={busy}>
					{busy ? "…" : submitLabel}
				</Button>
				<Button variant="ghost" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
