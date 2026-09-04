import { createFileRoute } from "@tanstack/react-router";

import { BenchLobby } from "@bench/BenchLobby";
import { RecoveredExchangePanel } from "@bench/RecoveredExchangePanel";
import { SavedExchangesHome } from "@bench/SavedExchanges";
import { isConsoleBuild } from "@utils/clientConfig";
import { seo } from "@utils/seo";

/** The home route. A hosted build renders the managed-exchange home, which
 * shows the recurring list once the store holds one. A console build has no
 * managed store: it renders the strand-recovery panel above the plain lobby, so
 * a returning operator can pick up an exchange still running from an earlier
 * visit (the panel renders nothing when there is none). */
function IndexHome() {
  if (isConsoleBuild())
    return (
      <>
        <RecoveredExchangePanel />
        <BenchLobby />
      </>
    );
  return <SavedExchangesHome />;
}

export const Route = createFileRoute("/")({
  // The home route reads the managed-exchange store (IndexedDB, origin-isolated and
  // browser-only) to decide whether to render the list or the quick path, so it must
  // render client-side.
  ssr: false,
  component: IndexHome,
  head: () => ({
    meta: seo({
      title: "psilink - private record linkage",
      description:
        "Find the records you both hold - without either of you seeing the other's data.",
    }),
  }),
});
