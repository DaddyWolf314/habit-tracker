import { useCallback, useEffect, useState } from "react";
import { getSession } from "#/lib/api.ts";
import { hasIdentity } from "#/lib/identity.ts";
import { LIVE_REFRESH_MS, useLiveRefresh } from "#/lib/use-live-refresh.ts";
import type { Session } from "#/shared/identity.ts";

/**
 * The signed-in session, kept live on the shared cadence (#92). Chrome that
 * renders on every surface needs to know whether the dynamic is active — the tab
 * bar (#85) hangs on `roles_active` — and that flips when the *partner* confirms
 * roles, so a one-shot fetch at mount would leave one side without navigation
 * until they reloaded.
 *
 * `ready` distinguishes "not fetched yet" from "no session": identity lives in
 * localStorage, so callers must render nothing on the server pass rather than
 * flash a signed-out shape at hydration.
 *
 * Pass `poll: false` on a surface that only needs the session it mounted with.
 * The tab bar is on screen everywhere and does the polling for the app; a second
 * poller on the same route would just double the request rate for a value that
 * changes once in a couple's life.
 */
export function useSession({ poll = true }: { poll?: boolean } = {}) {
	const [session, setSession] = useState<Session | null>(null);
	const [ready, setReady] = useState(false);

	const refresh = useCallback(async () => {
		// The hook's contract is not to poll a space this device can't read.
		if (!hasIdentity()) {
			setSession(null);
			return;
		}
		setSession(await getSession());
	}, []);

	useEffect(() => {
		setReady(true);
		// A stale or revoked credential just means "no session" to chrome; the
		// onboarding surface owns clearing it (it is the one that can re-auth).
		refresh().catch(() => setSession(null));
	}, [refresh]);

	useLiveRefresh(refresh, {
		intervalMs: LIVE_REFRESH_MS,
		enabled: poll && ready && hasIdentity(),
	});

	return { session, ready, refresh };
}
