import { createFileRoute } from "@tanstack/react-router";

import { AcceptInvitation } from "@components/AcceptInvitation";

export const Route = createFileRoute("/accept")({
  // The encoded token rides in the URL fragment, which never reaches the server,
  // so decoding and rendering must happen client-side only.
  ssr: false,
  component: AcceptInvitation,
});
