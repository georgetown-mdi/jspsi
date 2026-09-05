import { createFileRoute } from "@tanstack/react-router";

import { Lobby } from "@exchange/Lobby";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/quick")({
  component: Lobby,
  head: () => ({
    meta: seo({
      title: "psilink - private record linkage",
      description:
        "Find the records you both hold - without either of you seeing the other's data.",
    }),
  }),
});
