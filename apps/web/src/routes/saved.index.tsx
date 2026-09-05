import { createFileRoute, redirect } from "@tanstack/react-router";

import { SavedExchanges } from "@recurring/SavedExchanges";
import { isConsoleBuild } from "@utils/clientConfig";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/saved/")({
  // Always renders the recurring-exchange list, including its empty state and
  // the store-degrade message. The home route at `/` shows the list only once an
  // exchange exists; this path always shows it, so the import control stays
  // reachable after an eviction. Client-only because it reads the
  // managed-exchange store (IndexedDB).
  ssr: false,
  // The recurring surface exists only in the hosted browser build; a console
  // build has no managed store, so it never reaches the list.
  beforeLoad: () => {
    if (isConsoleBuild()) throw redirect({ to: "/" });
  },
  component: SavedExchanges,
  head: () => ({
    meta: seo({
      title: "Recurring exchanges - psilink",
      description:
        "The recurring exchanges saved in this browser, run again without a new invitation.",
    }),
  }),
});
