import { Alert } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

/** The dropped-citation Alert's title. Exported because the Matching keys tab
 * announces it through a persistent live region -- the short heading, not the
 * full body twice (once as a live update, once in reading order next to the
 * Alert). */
export const CITATION_DROP_TITLE =
  "The imported rule-set citation will not be included";

/**
 * The notice that an imported document's rule-set citation is left out of the
 * terms the editor emits; `importedCitationDropNotice` supplies the body, which
 * names the cause and, where an edit here reaches it, the way back.
 *
 * One component for the two steps that show it -- Matching keys, where the edit
 * that costs the citation is made, and Review & create, where the terms are
 * confirmed -- so an operator who imports in one and creates from the other
 * cannot meet two wordings of the same fact, and one who works through either
 * step alone still meets it once.
 *
 * It blocks nothing: re-emitting the citation would claim a provenance the rules
 * do not have, so the operator is told what the outgoing document will say rather
 * than stopped from creating it. It is a `note`, not a Problems entry -- every
 * Problems entry holds the create gate shut.
 */
export function CitationDropNotice({ notice }: { notice: string }) {
  return (
    <Alert
      role="note"
      color="yellow"
      icon={<IconAlertCircle aria-hidden />}
      title={CITATION_DROP_TITLE}
      mt="md"
    >
      {notice}
    </Alert>
  );
}
