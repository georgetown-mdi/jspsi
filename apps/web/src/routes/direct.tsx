import { createFileRoute } from "@tanstack/react-router";

import { DirectExchangeScreen } from "@exchange/DirectExchangeScreen";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/direct")({
  // DirectExchangeScreen reads the console build flag and calls the console's
  // same-origin job API, so this route renders client-side only.
  ssr: false,
  component: DirectExchangeScreen,
  head: () => ({
    meta: seo({
      title: "Direct exchange - psilink",
      description:
        "Run an exchange you have already arranged, against a server you and your partner agreed on.",
    }),
  }),
});
