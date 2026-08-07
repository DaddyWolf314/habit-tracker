import { type ReactNode, useId, useState } from "react";
import { Button } from "#/components/ui/button.tsx";

/**
 * A heading's explainer: one toggle, and the copy behind it (#212).
 *
 * The app has one shape for saying what a thing is, and this is it. #210 argued
 * that shape out on the Agreements screen — a ghost toggle under the heading,
 * opening onto short muted copy — and wrote it inline there, which was right for
 * one call site and wrong for six. #212 item 4 names the cost: the moment a
 * second screen wants the same affordance, "a shared disclosure primitive" is
 * what stops the app growing two toggles that behave almost alike, with two sets
 * of aria wiring to keep correct.
 *
 * The `aria-controls`/`aria-expanded` pair is the reason this is a component and
 * not a snippet. Both halves have to agree on an id, that id has to be unique per
 * instance (#148 — Today renders several of these on one screen, and the
 * Agreements screen renders one per kind), and the panel must not be in the tree
 * while collapsed or the control names a dangling node. Getting that wrong throws
 * nothing and is invisible outside a screen reader.
 *
 * The label is the caller's because it is the *reader's question*, and the reader
 * asks a different one per surface — "What's a protocol?" under a kind, "What is
 * this?" under a panel headed with a phrase. Only the closed state carries it;
 * open, the control is "Hide" everywhere, since by then the copy is on screen and
 * saying the question back is noise.
 */
export function Explainer({
	label,
	defaultOpen = false,
	children,
}: {
	/** What the closed toggle asks, in the reader's words. */
	label: string;
	/**
	 * Whether it starts open. Read **once**, as an initial state and not a
	 * controlled value: a section that fills up under the reader must not have the
	 * copy yanked out from under them mid-read, and one they empty out again should
	 * not have it spring back.
	 */
	defaultOpen?: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(defaultOpen);
	const panelId = useId();

	return (
		<>
			<Button
				size="xs"
				variant="ghost"
				className="-ml-2 mt-1"
				aria-expanded={open}
				aria-controls={panelId}
				onClick={() => setOpen((isOpen) => !isOpen)}
			>
				{open ? "Hide" : label}
			</Button>
			{open && (
				<div
					id={panelId}
					className="mt-1 space-y-1 text-xs text-muted-foreground"
				>
					{children}
				</div>
			)}
		</>
	);
}
