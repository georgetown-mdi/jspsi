import { createFileRoute } from "@tanstack/react-router";

import { SavedExchangesHome } from "@bench/SavedExchanges";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/")({
  // The home route reads the managed-exchange store (IndexedDB, origin-isolated and
  // browser-only) to decide whether to render the list or the quick path, so it must
  // render client-side.
  ssr: false,
  component: SavedExchangesHome,
  head: () => ({
    meta: seo({
      title: "psilink - private record linkage",
      description:
        "Find the records you both hold - without either of you seeing the other's data.",
    }),
  }),
});
