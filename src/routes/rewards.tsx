import { createFileRoute } from "@tanstack/react-router";
import { RewardsView } from "#/components/rewards-view.tsx";

export const Route = createFileRoute("/rewards")({
	component: RewardsView,
});
