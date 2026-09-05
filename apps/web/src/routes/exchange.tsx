import { createFileRoute } from "@tanstack/react-router";

import { InviterScreen } from "@exchange/InviterScreen";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/exchange")({
  component: InviterScreen,
  head: () => ({
    meta: seo({
      title: "Create an exchange - psilink",
      description: "Run a private record linkage with your partner.",
    }),
  }),
});
