import { useState } from "react";
import { ResponseComposer } from "#/components/response-composer.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
	anchorElapsedDays,
	anchorElapsedMs,
	elapsedDaysText,
} from "#/shared/anchors.ts";
import type { ConversationFlagView } from "#/shared/conversations.ts";

/**
 * Open conversation flags on Today (#88, ADR 0007) — R18's surface.
 *
 * `check_in AND flag=wants_conversation → notify partner` has shipped since the
 * rule pack existed, and its whole effect was a trace row: the sub could say "I
 * want to talk" and the app would tell no one. This panel is the "notify partner"
 * half that was never built.
 *
 * Replying is not a dismissal. It logs a `response` amendment against the
 * check-in, which is what *closes* the flag — so "we talked" ends up in the
 * record, attached to what prompted it, rather than a badge someone tapped away.
 * The flag never expires: the app cannot observe a conversation, so only a person
 * may end one. That is why an unanswered ask just keeps sitting here.
 *
 * The form itself is the shared {@link ResponseComposer}: since #183 the log can
 * write a response too, and a response written here is not a different act from a
 * response written there.
 */
export function ConversationFlagsPanel({
	flags,
	selfId,
	onChange,
}: {
	flags: ConversationFlagView[];
	selfId: string | null;
	onChange: () => void;
}) {
	const [replying, setReplying] = useState<string | null>(null);

	if (flags.length === 0) return null;

	// Day granularity, so this is read once per render rather than ticked: the
	// Today poll re-renders often enough, and nothing here counts down.
	const now = Date.now();

	return (
		<section className="rounded-lg border p-4">
			<h2 className="text-lg font-semibold">Conversations</h2>
			<ul className="mt-3 space-y-2">
				{flags.map((flag) => {
					const mine = selfId !== null && flag.actor === selfId;
					return (
						<li key={flag.event_id} className="rounded-md border px-3 py-2">
							<div className="flex items-start gap-3">
								<div className="min-w-0 flex-1">
									<div className="font-medium">
										{mine ? "You asked to talk" : "Your partner asked to talk"}
									</div>
									{flag.note && (
										<p className="mt-1 text-sm text-muted-foreground">
											{flag.note}
										</p>
									)}
									<div className="mt-1 text-xs text-muted-foreground">
										{askedText(
											anchorElapsedDays(anchorElapsedMs(flag.occurred_at, now)),
										)}
										{flag.mood !== null && ` · mood ${flag.mood}/5`}
									</div>
								</div>
								{/* No affordance on your own ask: the point is that the other
								    person answers, and there is nothing here to dismiss. */}
								{mine ? (
									<span className="text-sm text-muted-foreground">
										Waiting for a reply
									</span>
								) : (
									replying !== flag.event_id && (
										<Button
											size="sm"
											onClick={() => setReplying(flag.event_id)}
										>
											Reply
										</Button>
									)
								)}
							</div>
							{replying === flag.event_id && (
								<ResponseComposer
									eventId={flag.event_id}
									submitLabel="Reply"
									onCancel={() => setReplying(null)}
									onResponded={() => {
										setReplying(null);
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
 * How long the ask has been standing. Reuses the clocks' "days since" phrasing —
 * its own docstring calls it "one formatter for every surface" — so a span of days
 * reads the same here as it does on the panel above.
 */
function askedText(days: number | null): string {
	if (days === null || days === 0) return "Asked today";
	return `Asked ${elapsedDaysText(days)} ago`;
}
