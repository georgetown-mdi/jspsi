import { createFileRoute } from "@tanstack/react-router";

import { SavedExchanges } from "@bench/SavedExchanges";

export const Route = createFileRoute("/saved/")({
  // The managed-exchange store is IndexedDB, origin-isolated and browser-only, so
  // the list must render client-side.
  ssr: false,
  component: SavedExchanges,
});
