import { createFileRoute } from "@tanstack/react-router";

import { SavedExchanges } from "@bench/SavedExchanges";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/saved/")({
  // The canonical always-list route: it renders the full recurring-exchange list
  // surface unconditionally, including the designed empty state and the store-degrade
  // message. The home route at `/` shows this list only once an exchange exists; this
  // path always shows it, so eviction recovery's import affordance stays discoverable.
  // Client-only because it reads the managed-exchange store (IndexedDB).
  ssr: false,
  component: SavedExchanges,
  head: () => ({
    meta: seo({
      title: "Recurring exchanges - psilink",
      description:
        "The recurring exchanges saved in this browser, run again without a new invitation.",
    }),
  }),
});
