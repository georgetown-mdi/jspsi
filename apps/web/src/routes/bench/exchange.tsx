import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/exchange")({
  // Client-only so beforeLoad runs in the browser, where the URL fragment is
  // available; the redirect preserves any present hash for uniformity with the
  // accept leaf (the inviter surface carries no fragment).
  ssr: false,
  beforeLoad: () => {
    throw redirect({ to: "/exchange", hash: true, replace: true });
  },
});
