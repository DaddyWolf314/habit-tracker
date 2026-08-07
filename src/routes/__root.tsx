import { TanStackDevtools } from "@tanstack/react-devtools";
import type { QueryClient } from "@tanstack/react-query";
import {
	createRootRouteWithContext,
	HeadContent,
	Scripts,
} from "@tanstack/react-router";
import { TanStackRouterDevtoolsPanel } from "@tanstack/react-router-devtools";
import { PauseEverythingBar } from "../components/pause-everything";
import { PinGate } from "../components/pin-gate";
import { TabBar } from "../components/tab-bar";
import TanStackQueryDevtools from "../integrations/tanstack-query/devtools";
import { APP_NAME } from "../lib/app-config";
import appCss from "../styles.css?url";

interface MyRouterContext {
	queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
	head: () => ({
		meta: [
			{
				charSet: "utf-8",
			},
			{
				name: "viewport",
				content: "width=device-width, initial-scale=1",
			},
			{
				title: APP_NAME,
			},
		],
		links: [
			{
				rel: "stylesheet",
				href: appCss,
			},
		],
	}),
	shellComponent: RootDocument,
});

function RootDocument({ children }: { children: React.ReactNode }) {
	return (
		<html lang="en">
			<head>
				<HeadContent />
			</head>
			<body>
				<PinGate>
					{/* A plain block on a phone — the bar is fixed to the bottom and
					    takes no part in the flow. At `lg` the bar is a side rail, so the
					    shell becomes the row it and the page column sit in. Nothing here
					    reserves space for the rail (no `lg:pl-56`): the rail *is* a flex
					    item, so on the surfaces where `TabBar` renders nothing — every
					    screen before pairing completes — the page column simply gets the
					    whole width instead of an indent with nothing in it. */}
					<div className="lg:flex">
						<div className="min-w-0 flex-1">
							<PauseEverythingBar />
							{children}
						</div>
						{/* Navigation lives in the root layout so it persists across every
						    surface (#85); it renders itself away until the dynamic is
						    active. Last in the tree so its spacer sits below the page; it
						    takes the left of the row at `lg` with `order-first`. */}
						<TabBar />
					</div>
				</PinGate>
				<TanStackDevtools
					config={{
						position: "bottom-right",
					}}
					plugins={[
						{
							name: "Tanstack Router",
							render: <TanStackRouterDevtoolsPanel />,
						},
						TanStackQueryDevtools,
					]}
				/>
				<Scripts />
			</body>
		</html>
	);
}
