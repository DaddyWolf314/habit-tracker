import { createFileRoute } from "@tanstack/react-router";
import { DevicesPanel } from "#/components/devices-panel.tsx";

export const Route = createFileRoute("/devices")({ component: DevicesPanel });
