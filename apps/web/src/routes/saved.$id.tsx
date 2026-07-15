import { createFileRoute } from "@tanstack/react-router";

import { ManagedRunSurface } from "@bench/ManagedRunSurface";

export const Route = createFileRoute("/saved/$id")({
  // The managed-exchange store is IndexedDB, origin-isolated and browser-only, so
  // the run surface must render client-side.
  ssr: false,
  component: RunRoute,
});

function RunRoute() {
  const { id } = Route.useParams();
  return <ManagedRunSurface id={id} />;
}
