import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/")({
  // Client-only so beforeLoad runs in the browser, where the URL fragment is
  // available (it never reaches the server). The lobby carries no fragment, but
  // the redirect preserves any present hash for uniformity with the accept leaf.
  ssr: false,
  beforeLoad: () => {
    // hash: true carries the current location's fragment through the redirect
    // (router buildLocation reads currentLocation.hash); the fragment stays out
    // of the server request and out of logs.
    throw redirect({ to: "/", hash: true, replace: true });
  },
});
