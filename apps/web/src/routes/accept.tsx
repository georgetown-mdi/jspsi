import { createFileRoute } from "@tanstack/react-router";

import { AcceptInvitation } from "@components/AcceptInvitation";

export const Route = createFileRoute("/accept")({
  // The encoded token rides in the URL fragment, which never reaches the server,
  // so decoding and rendering must happen client-side only.
  ssr: false,
  component: AcceptInvitation,
  // Narrower single-column reading width: the dense linkage terms sit at a
  // legible measure rather than running the full two-column width. The shell
  // brings its chrome edges in to match.
  staticData: { contentWidth: "lg" },
});
