import { createFileRoute } from "@tanstack/react-router";
import { Onboarding } from "#/components/onboarding.tsx";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
	return <Onboarding />;
}
