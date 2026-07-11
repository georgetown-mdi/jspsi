import { createFileRoute } from "@tanstack/react-router";

import { BenchLobby } from "@bench/BenchLobby";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/")({
  component: BenchLobby,
  head: () => ({
    meta: seo({
      title: "psilink - private record linkage",
      description:
        "Find the records you both hold - without either of you seeing the other's data.",
    }),
  }),
});
