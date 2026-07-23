import { createFileRoute } from "@tanstack/react-router";
import { RulesView } from "#/components/rules-view.tsx";

export const Route = createFileRoute("/rules")({ component: RulesView });
