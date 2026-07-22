import { createFileRoute, redirect } from "@tanstack/react-router";

import { SavedExchanges } from "@bench/SavedExchanges";
import { isConsoleBuild } from "@utils/clientConfig";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/saved/")({
  // The canonical always-list route: it renders the full recurring-exchange list
  // surface unconditionally, including the designed empty state and the store-degrade
  // message. The home route at `/` shows this list only once an exchange exists; this
  // path always shows it, so eviction recovery's import affordance stays discoverable.
  // Client-only because it reads the managed-exchange store (IndexedDB).
  ssr: false,
  // The recurring surface belongs only to the hosted browser build; a console build
  // has no managed store, so it never reaches the list.
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
