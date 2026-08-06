import { createFileRoute } from "@tanstack/react-router";
import { VocabularyView } from "#/components/vocabulary-view.tsx";

export const Route = createFileRoute("/vocabulary")({
	component: VocabularyView,
});
