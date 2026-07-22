import { createFileRoute } from "@tanstack/react-router";

import { DirectExchangeBench } from "@bench/DirectExchangeBench";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/direct")({
  // The bench reads the console build flag and drives the appliance's same-origin
  // job API, so it renders client-side only (like the accept route).
  ssr: false,
  component: DirectExchangeBench,
  head: () => ({
    meta: seo({
      title: "psilink - direct exchange",
      description:
        "Run an exchange you have already arranged, against a server you and your partner agreed on.",
    }),
  }),
});
