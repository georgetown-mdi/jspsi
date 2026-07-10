import { createFileRoute } from "@tanstack/react-router";

import { AcceptorBench } from "@bench/AcceptorBench";

export const Route = createFileRoute("/bench/accept")({
  // The encoded token rides in the URL fragment, which never reaches the server,
  // so decoding and rendering must happen client-side only (as the legacy
  // /accept route does).
  ssr: false,
  component: AcceptorBench,
});
