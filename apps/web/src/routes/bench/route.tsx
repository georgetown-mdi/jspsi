import { createFileRoute } from "@tanstack/react-router";

/**
 * Layout route for the `/bench/*` subtree, kept so older links still resolve.
 * The console renders on the primary routes (`/`, `/accept`, `/exchange`,
 * `/verify`); every leaf under here redirects to its primary path with the URL
 * fragment intact. This layout only anchors the `/bench` path segment.
 */
export const Route = createFileRoute("/bench")({});
