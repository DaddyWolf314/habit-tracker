import { createFileRoute } from "@tanstack/react-router";
import { TodayView } from "#/components/today-view.tsx";

export const Route = createFileRoute("/today")({ component: TodayView });
