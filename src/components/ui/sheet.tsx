import { XIcon } from "lucide-react";
import { Dialog as SheetPrimitive } from "radix-ui";
import type * as React from "react";

import { cn } from "#/lib/utils.ts";

/**
 * A bottom sheet built on Radix Dialog — the modal surface the spec asks a write
 * action to open onto (handoff §9.4, #91), rather than a panel wedged into the
 * page. Radix gives us the focus trap, Escape/backdrop dismissal, and the
 * dialog aria wiring; the styling anchors the panel to the bottom of the content
 * column so it reads as a drawer on phone-width screens, and re-centres it as an
 * ordinary dialog above `sm`, where the bottom edge of the window is nowhere
 * near the hand or the eye. See {@link SheetContent} for that half.
 */
const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.Close;

function SheetOverlay({
	className,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
	return (
		<SheetPrimitive.Overlay
			data-slot="sheet-overlay"
			className={cn(
				"fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
				className,
			)}
			{...props}
		/>
	);
}

/**
 * The sheet body. `title` is always rendered (Radix requires an accessible name);
 * `description` is optional and visually hidden — it satisfies the aria-describedby
 * warning without cluttering the header.
 */
function SheetContent({
	className,
	children,
	title,
	description,
	...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
	title: React.ReactNode;
	description?: React.ReactNode;
}) {
	return (
		<SheetPrimitive.Portal>
			<SheetOverlay />
			<SheetPrimitive.Content
				data-slot="sheet-content"
				className={cn(
					"fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[85vh] w-full max-w-2xl flex-col rounded-t-2xl border bg-background shadow-lg data-[state=closed]:animate-out data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:slide-in-from-bottom",
					// A drawer is a phone gesture — it comes up from the edge your thumb
					// is already at. On a pointer screen the same panel anchored to the
					// bottom of a tall window reads as something half off the display,
					// and the eye has to travel to the bottom edge to use a form the
					// button for was at the top. Above `sm` it is a centred dialog
					// instead: same component, same focus trap, same escape hatch.
					"sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl",
					// The slide is cancelled rather than left to fight the centring
					// translate, and a dialog that is already in the middle gets the
					// scale-in a dialog usually gets.
					"sm:data-[state=closed]:slide-out-to-bottom-0 sm:data-[state=closed]:zoom-out-95 sm:data-[state=open]:slide-in-from-bottom-0 sm:data-[state=open]:zoom-in-95",
					className,
				)}
				{...props}
			>
				<div className="flex items-center justify-between border-b px-4 py-3">
					<SheetPrimitive.Title
						data-slot="sheet-title"
						className="text-lg font-semibold"
					>
						{title}
					</SheetPrimitive.Title>
					<SheetPrimitive.Close
						data-slot="sheet-close"
						className="rounded-md p-1 text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
						aria-label="Close"
					>
						<XIcon className="size-5" />
					</SheetPrimitive.Close>
				</div>
				<SheetPrimitive.Description
					data-slot="sheet-description"
					className={
						description ? "px-4 pt-3 text-sm text-muted-foreground" : "sr-only"
					}
				>
					{description}
				</SheetPrimitive.Description>
				<div className="overflow-y-auto px-4 py-4">{children}</div>
			</SheetPrimitive.Content>
		</SheetPrimitive.Portal>
	);
}

export { Sheet, SheetTrigger, SheetClose, SheetContent };
