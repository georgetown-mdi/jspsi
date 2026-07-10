import { createFileRoute } from "@tanstack/react-router";

/**
 * Layout route for the linkage bench subtree: every route under `/bench`
 * inherits the bench chrome here, opting the whole redesign out of the legacy
 * shell in one place (see `resolveChrome`).
 */
export const Route = createFileRoute("/bench")({
  staticData: { chrome: "bench" },
});
