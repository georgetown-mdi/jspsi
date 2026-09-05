import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/exchange")({
  // Client-only so beforeLoad runs in the browser, where the URL fragment is
  // available; the redirect keeps any hash the URL has.
  ssr: false,
  beforeLoad: () => {
    throw redirect({ to: "/exchange", hash: true, replace: true });
  },
});
