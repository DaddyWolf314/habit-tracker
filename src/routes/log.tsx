import { createFileRoute } from "@tanstack/react-router";
import { LogView } from "#/components/log-view.tsx";

export const Route = createFileRoute("/log")({ component: LogView });
