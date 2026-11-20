/**
 * The one line that wires an App's channel to `app-data/v1`.
 *
 * Every App that uses these modules writes the same three statements — adapt
 * the channel, mount the provider, release nothing — so the package writes them
 * once and an App names the result:
 *
 *     providers: { [APP_DATA_CONTRACT]: appDataAdapter }
 *
 * ── Why the parameter is structural ─────────────────────────────────────────
 *
 * It is typed against `AppDataChannel`, this package's own three-member
 * description of an App channel, and NOT against the SDK's `AppTransport` — a
 * View module may not import the SDK's root entry, and a type-only import is
 * still an import as far as the boundary check is concerned. The two shapes line
 * up, so `appDataAdapter` satisfies `PortAdapterFactory` without this package
 * ever naming it. That is structural typing doing exactly the job it is for: two
 * packages agreeing on a shape without either depending on the other.
 *
 * ── Why there is no `destroy` ───────────────────────────────────────────────
 *
 * This port owns nothing. It is a view onto a channel the App's provider
 * created and will close; a `destroy` here would be a second owner of one
 * resource, which is how a channel ends up closed while something is still
 * reading it.
 */

import type { ReactNode } from "react";
import { AppDataProvider } from "./context.js";
import { createAppDataPort, type AppDataChannel } from "./port.js";

export interface AppDataAdapter {
  provide(children: ReactNode): ReactNode;
}

export function appDataAdapter(channel: AppDataChannel): AppDataAdapter {
  const port = createAppDataPort(channel);
  return {
    provide: (children) => <AppDataProvider port={port}>{children}</AppDataProvider>,
  };
}
