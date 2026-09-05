import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/")({
  // Client-only so beforeLoad runs in the browser, where the URL fragment is
  // available (it never reaches the server); the redirect keeps any hash the
  // URL has.
  ssr: false,
  beforeLoad: () => {
    // hash: true keeps the current location's fragment through the redirect
    // (router buildLocation reads currentLocation.hash), so the fragment stays
    // out of the server request and out of logs.
    throw redirect({ to: "/", hash: true, replace: true });
  },
});
