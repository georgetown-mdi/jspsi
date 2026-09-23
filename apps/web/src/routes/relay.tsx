import { createFileRoute } from "@tanstack/react-router";

import { RelaySettingsScreen } from "@exchange/RelaySettingsScreen";
import { seo } from "@utils/seo";

export const Route = createFileRoute("/relay")({
  // The setting lives in this browser's storage, so the page never
  // server-renders.
  ssr: false,
  component: RelaySettingsScreen,
  head: () => ({
    meta: seo({
      title: "Relay server - psilink",
      description:
        "Set the TURN relay your side of an exchange connects through.",
    }),
  }),
});
