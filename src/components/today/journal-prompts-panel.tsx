import { useEffect, useState } from "react";
import { Button } from "#/components/ui/button.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { logEvent } from "#/lib/api.ts";
import { type OpenPromptView, PROMPT_ID_KEY } from "#/shared/journaling.ts";
import type { Visibility } from "#/shared/roles.ts";
import { formatRemaining } from "#/shared/timers.ts";

const fieldClass =
	"w-full rounded-md border border-input bg-transparent px-3 py-1.5 text-sm shadow-sm";

/** The urgency badge for one open prompt: overdue / paused / time left. */
function urgency(p: OpenPromptView, now: number): string {
	if (p.expired) return "overdue";
	if (p.paused) return "paused";
	if (p.deadline_at === null) return "";
	return `${formatRemaining(p.deadline_at - now)} left`;
}

/**
 * The sub's answer surface on the Today screen (issue #106). `CountdownsPanel`
 * shows the `journal_countdown` ticking but stays a dom-owned control surface, so
 * a sub had no path to answer an assigned prompt without hunting for the generic
 * composer on the Log screen. This panel closes that gap: it lists the caller's
 * outstanding prompts (already filtered server-side to prompts assigned *to
 * them*, so a dom sees none and the panel renders nothing) and lets them answer
 * inline. Answering is not a timer command — it logs a `journal_entry` echoing
 * the prompt's `prompt_id` (rule R20 closes the countdown on the ref match), so
 * this goes through {@link logEvent}, exactly as `LogComposer` does.
 */
export function JournalPromptsPanel({
	openPrompts,
	onChange,
}: {
	openPrompts: OpenPromptView[];
	onChange: () => void;
}) {
	const [now, setNow] = useState(() => Date.now());
	const [answering, setAnswering] = useState<string | null>(null);

	// Tick once a second so the "time left" badge counts down, mirroring
	// CountdownsPanel — a pure display re-render; the authoritative deadline is
	// re-fetched by the Today poll and after every answer.
	useEffect(() => {
		const id = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(id);
	}, []);

	// A dom has no prompts assigned to them, so the panel is naturally sub-facing;
	// render nothing rather than show an empty journaling card on a shared screen.
	if (openPrompts.length === 0) return null;

	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Journal prompts</h2>
			<ul className="mt-3 space-y-2">
				{openPrompts.map((p) => {
					const badge = urgency(p, now);
					return (
						<li key={p.prompt_id} className="rounded-md border px-3 py-2">
							<div className="flex items-start gap-3">
								<div className="min-w-0 flex-1">
									<div className="font-medium">
										{p.question ?? "(no question)"}
									</div>
									{p.floor && (
										<div className="text-xs text-muted-foreground">
											Needs at least {p.floor} visibility to count.
										</div>
									)}
								</div>
								{badge && (
									<span
										className={`w-20 text-right text-sm font-semibold tabular-nums ${
											p.expired ? "text-destructive" : ""
										}`}
									>
										{badge}
									</span>
								)}
								{answering !== p.prompt_id && (
									<Button size="sm" onClick={() => setAnswering(p.prompt_id)}>
										Answer
									</Button>
								)}
							</div>
							{answering === p.prompt_id && (
								<PromptAnswerForm
									prompt={p}
									onCancel={() => setAnswering(null)}
									onAnswered={() => {
										setAnswering(null);
										onChange();
									}}
								/>
							)}
						</li>
					);
				})}
			</ul>
		</section>
	);
}

/**
 * The inline answer form for one prompt. Prose goes in `note`; visibility is an
 * explicit author choice (ADR 0001 — there is no silent default), defaulting to
 * `shared`. A below-floor answer is still the sub's right to log — the server
 * takes it but it won't discharge the countdown — so the form never blocks it;
 * the floor hint above the form is the only nudge.
 */
function PromptAnswerForm({
	prompt,
	onCancel,
	onAnswered,
}: {
	prompt: OpenPromptView;
	onCancel: () => void;
	onAnswered: () => void;
}) {
	const [note, setNote] = useState("");
	const [visibility, setVisibility] = useState<Visibility>("shared");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit() {
		if (!note.trim()) {
			setError("Write something to answer with.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			await logEvent({
				type: "journal_entry",
				metadata: { [PROMPT_ID_KEY]: prompt.prompt_id },
				note: note.trim(),
				visibility,
			});
			onAnswered();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't log that.");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="mt-2 space-y-2">
			<Textarea
				placeholder="What's on your mind?"
				value={note}
				onChange={(e) => setNote(e.target.value)}
			/>
			<div>
				{/** biome-ignore lint/a11y/noLabelWithoutControl: label wraps the select */}
				<label className="text-xs text-muted-foreground">Visibility</label>
				<select
					className={`${fieldClass} mt-1`}
					value={visibility}
					onChange={(e) => setVisibility(e.target.value as Visibility)}
				>
					<option value="shared">Shared — my partner can read this</option>
					<option value="sealed">
						Sealed — they see that I journaled, not the words
					</option>
					<option value="secret">
						Secret — fully private; they can't tell it exists
					</option>
				</select>
			</div>

			{error && <p className="text-sm text-destructive">{error}</p>}

			<div className="flex gap-2">
				<Button onClick={submit} disabled={busy}>
					{busy ? "…" : "Answer"}
				</Button>
				<Button variant="ghost" onClick={onCancel} disabled={busy}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
