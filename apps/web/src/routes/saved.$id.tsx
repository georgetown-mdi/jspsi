import { createFileRoute, redirect } from "@tanstack/react-router";

import { ManagedRunSurface } from "@bench/ManagedRunSurface";
import { isConsoleBuild } from "@utils/clientConfig";

export const Route = createFileRoute("/saved/$id")({
  // The managed-exchange store is IndexedDB, origin-isolated and browser-only, so
  // the run surface must render client-side.
  ssr: false,
  // The recurring run surface belongs only to the hosted browser build; a console
  // build has no managed store, so it never reaches a saved exchange.
  beforeLoad: () => {
    if (isConsoleBuild()) throw redirect({ to: "/" });
  },
  component: RunRoute,
});

function RunRoute() {
  const { id } = Route.useParams();
  // Key by id so a client-side navigation between two saved exchanges (this route
  // matches once on the dynamic param and would otherwise NOT remount) tears down and
  // rebuilds the surface: every per-exchange state slot resets, so exchange A's
  // leftover state -- including a live re-invite token in its panel -- can never render
  // on exchange B's page.
  return <ManagedRunSurface key={id} id={id} />;
}
