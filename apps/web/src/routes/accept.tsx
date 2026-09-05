import { createFileRoute } from "@tanstack/react-router";

import { AcceptorBench } from "@bench/AcceptorBench";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/accept")({
  // The encoded token is in the URL fragment, which never reaches the server, so
  // decoding and rendering happen client-side only. The inviter's deep link
  // points here (ACCEPT_ROUTE_PATH in psi/invitation.ts).
  ssr: false,
  component: AcceptorBench,
  head: () => ({
    meta: seo({
      title: "Accept an invitation - psilink",
      description:
        "Review the terms your partner proposed, then run the exchange.",
    }),
  }),
});
