import { createFileRoute } from "@tanstack/react-router";

import { AcceptorBench } from "@bench/AcceptorBench";

export const Route = createFileRoute("/accept")({
  // The encoded token rides in the URL fragment, which never reaches the server,
  // so decoding and rendering must happen client-side only. The inviter's
  // deep-link points here (ACCEPT_ROUTE_PATH in psi/invitation.ts).
  ssr: false,
  component: AcceptorBench,
});
