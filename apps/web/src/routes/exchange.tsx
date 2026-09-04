import { createFileRoute } from "@tanstack/react-router";

import { InviterBench } from "@bench/InviterBench";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/exchange")({
  component: InviterBench,
  head: () => ({
    meta: seo({
      title: "Run an exchange - psilink",
      description: "Run a private record linkage with your partner.",
    }),
  }),
});
