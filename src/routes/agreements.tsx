import { createFileRoute } from "@tanstack/react-router";
import { AgreementsView } from "#/components/agreements-view.tsx";

export const Route = createFileRoute("/agreements")({
	component: AgreementsView,
});
