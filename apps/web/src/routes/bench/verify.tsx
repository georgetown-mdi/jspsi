import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/verify")({
  // Client-only so beforeLoad runs in the browser, where the URL fragment is
  // available; the redirect keeps any hash the URL has.
  ssr: false,
  beforeLoad: () => {
    throw redirect({ to: "/verify", hash: true, replace: true });
  },
});
