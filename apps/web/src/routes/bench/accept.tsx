import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/accept")({
  // Client-only so beforeLoad runs in the browser, where the URL fragment is
  // available. The invitation token rides ONLY in the fragment, which never
  // reaches the server, so the redirect must resolve client-side and preserve
  // the hash: a dropped hash breaks the deep link and a server-visible hash
  // leaks it.
  ssr: false,
  beforeLoad: () => {
    // hash: true carries the current location's fragment (the token) through the
    // redirect to the primary /accept route unchanged.
    throw redirect({ to: "/accept", hash: true, replace: true });
  },
});
