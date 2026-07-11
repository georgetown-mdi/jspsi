import { createFileRoute } from "@tanstack/react-router";

/**
 * Layout route for the legacy `/bench/*` subtree. The bench is now mounted on
 * the primary routes (`/`, `/accept`, `/exchange`, `/verify`); every leaf under
 * here redirects to its primary path, preserving the URL fragment (see each
 * leaf). This layout only anchors the `/bench` path segment.
 */
export const Route = createFileRoute("/bench")({});
