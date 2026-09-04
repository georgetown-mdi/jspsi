import { createFileRoute, redirect } from "@tanstack/react-router";

import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { isConsoleBuild } from "@utils/clientConfig";

export const Route = createFileRoute("/saved/$id")({
  // The managed-exchange store is IndexedDB, origin-isolated and browser-only, so
  // the run surface must render client-side.
  ssr: false,
  // The recurring run surface exists only in the hosted browser build; a console
  // build has no managed store, so it never reaches a saved exchange.
  beforeLoad: () => {
    if (isConsoleBuild()) throw redirect({ to: "/" });
  },
  component: RunRoute,
});

function RunRoute() {
  const { id } = Route.useParams();
  // Key by id so navigating between two saved exchanges remounts the surface.
  // This route matches once on the dynamic param and would otherwise keep its
  // state, letting exchange A's leftovers -- including a live re-invite token --
  // render on exchange B's page.
  return <ManagedRunSurface key={id} id={id} />;
}
