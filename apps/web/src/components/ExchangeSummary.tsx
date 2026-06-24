import { Paper, Stack, Text } from "@mantine/core";

import { ColumnChips } from "@components/ColumnChips";
import { InvitationTerms } from "@components/InvitationTerms";

import type { Ref } from "react";

import type { LinkageTerms } from "@psilink/core";

/**
 * The standardized "exchange proposal" panel: the agreed linkage terms
 * ({@link InvitationTerms}) in a bordered card, optionally followed by this
 * party's own outbound disclosure as chips. One component for every place the
 * agreed terms sit beside an editor or a run -- the inviter's Advanced-options
 * preview, the acceptor's review and "Prepare your data" screens, and both
 * roles' exchange-executing screen -- so the wrapper, the heading nesting, and
 * the "columns you will send" chips render the same way everywhere; only the
 * per-viewer copy differs, and that is owned by `perspective` inside
 * {@link InvitationTerms}.
 *
 * The send-columns block renders only when {@link sendColumns} is provided. It
 * is THIS party's own disclosure -- what leaves this machine for matched rows --
 * distinct from the terms' own send/receive framing. The acceptor supplies it
 * from its live metadata once a file is chosen, so it is omitted on the review
 * screen (no file yet) and on the inviter, whose declared send already renders
 * inside {@link InvitationTerms} under the "proposing" perspective. An empty
 * array is meaningful: it renders the explicit "no columns are sent"
 * confirmation rather than nothing.
 */
export function ExchangeSummary({
  linkageTerms,
  perspective,
  headingOrder,
  expires,
  disclosedPayloadColumns,
  headingRef,
  sendColumns,
}: {
  linkageTerms: LinkageTerms;
  /** Which viewer this renders for; drives the heading and per-party copy (see
   * {@link InvitationTerms}). */
  perspective: "review" | "accepted" | "proposing";
  /** Semantic heading level for the terms heading (see {@link InvitationTerms}). */
  headingOrder?: 2 | 3;
  /** The invitation's expiry instant (ISO 8601), if it carries one. */
  expires?: string;
  /** The columns the invitation declared the inviter will send, passed through
   * to {@link InvitationTerms}. */
  disclosedPayloadColumns?: Array<string>;
  headingRef?: Ref<HTMLHeadingElement>;
  /** This party's own disclosed columns ("Columns you will send to your
   * partner"), rendered as chips below the terms. Omit where the set is not yet
   * known (the acceptor review screen) or already shown inside the terms (the
   * inviter's "proposing" preview). An empty array renders the explicit
   * "no columns are sent" confirmation. */
  sendColumns?: Array<string>;
}) {
  return (
    <Paper withBorder p="md">
      <InvitationTerms
        linkageTerms={linkageTerms}
        perspective={perspective}
        headingOrder={headingOrder}
        expires={expires}
        disclosedPayloadColumns={disclosedPayloadColumns}
        headingRef={headingRef}
      />
      {sendColumns !== undefined && (
        <Stack gap={4} mt="md">
          <Text size="sm" fw={600}>
            Columns you will send to your partner
          </Text>
          {sendColumns.length > 0 ? (
            <ColumnChips
              columns={sendColumns}
              label="Columns you will send to your partner"
            />
          ) : (
            <Text size="sm" c="dimmed">
              No columns are sent to your partner; only the linkage result
              (which of your rows matched) is produced.
            </Text>
          )}
        </Stack>
      )}
    </Paper>
  );
}
