/**
 * The disclosure ledger's rows: what a run discloses, built from the editor
 * ahead of the run and from the outputs after it. The producer marks the rows
 * the narrow viewport's condensed share bar keeps, so a relabel cannot silently
 * drop one from that trust surface.
 */

import { disclosedColumnNames } from "@psilink/core";

import { isolatedColumnName } from "@components/ColumnName";

import { TRANSPORT_LEDGER_LABELS } from "./transportChooser";

import { enabledKeys } from "./inviterEditor";

import {
  RESULTS_DIRECTION_LABELS,
  dateTimeLabel,
  lifetimeLabel,
} from "./formatting";
import type { InviterEditor } from "./inviterEditor";

import type { RunOutputs } from "./runOutputs";

/** One disclosure-ledger row: `value` renders in the data voice, `muted`
 * renders in the empty-state voice ("None", "Nothing"), neither renders the
 * em-dash placeholder. `shareBar` marks the row as one of the headline
 * disclosure facts the narrow viewport's condensed "What you will share" bar
 * keeps -- declared here by the producer, so a relabel can never silently
 * drop a row from that trust surface. */
interface InviterLedgerRow {
  label: string;
  reference?: string;
  value?: string | ReadonlyArray<string>;
  muted?: string;
  shareBar?: boolean;
}

/** What a completed exchange settled, folded into the ledger: the invitation
 * is consumed (its expiry no longer means anything), and the receive row can
 * state what actually arrived -- the matched-row count, the size of the overlap a
 * count-only exchange reported, or that the agreed terms withheld the result table
 * from this party. Discriminated on the same `kind` the run's outputs hold
 * ({@link RunOutputs}), so the three outcomes cannot be read as one another and a
 * ledger that stops handling one is a compile error. */
export type LedgerOutcome =
  | { kind: "matched"; matchedRecordCount?: number }
  | { kind: "withheld" }
  | {
      kind: "counted";
      intersectionCount: number;
      /** Whether the count arrived as the PARTNER's report rather than a figure
       * this party computed, taken from {@link RunOutputs} so the ledger states
       * the count with the one fact that qualifies it. */
      countReportedByPartner: boolean;
    };

/** Fold a completed run's outputs into the ledger outcome, dropping the download
 * URLs the ledger has no use for. Shared by both seats so neither maps the
 * outcome its own way. */
export function ledgerOutcomeOf(outputs: RunOutputs): LedgerOutcome {
  switch (outputs.kind) {
    case "matched":
      return {
        kind: "matched",
        matchedRecordCount: outputs.matchedRecordCount,
      };
    case "withheld":
      return { kind: "withheld" };
    case "counted":
      return {
        kind: "counted",
        intersectionCount: outputs.intersectionCount,
        countReportedByPartner: outputs.countReportedByPartner,
      };
  }
}

/**
 * The receive row's value for a count-only exchange, shared by both seats'
 * ledgers. States the size of the overlap only, with no matched rows or
 * shared columns. When the count arrived as the partner's report rather than
 * a figure this party computed, the value closes with a provenance clause
 * naming that; the seat that computed its own count takes the sentence
 * unchanged.
 */
function countOnlyLedgerValue(
  intersectionCount: number,
  countReportedByPartner: boolean,
): string {
  return (
    `${new Intl.NumberFormat("en-US").format(intersectionCount)} records in ` +
    "common - the size of the overlap only, no matched rows and no shared columns" +
    (countReportedByPartner ? "; reported by your partner" : "")
  );
}

/**
 * The settled receive row's value for whichever outcome the run produced, shared by
 * both seats so the three readings stay one set of words. `matchedRowsSuffix` is the
 * only seat-specific part -- what rode along with the matched rows, which the inviter
 * states generically and the acceptor names from the invitation.
 */
export function settledReceiveValue(
  outcome: LedgerOutcome,
  matchedRowsSuffix: string,
): string {
  switch (outcome.kind) {
    case "counted":
      return countOnlyLedgerValue(
        outcome.intersectionCount,
        outcome.countReportedByPartner,
      );
    case "withheld":
      return "No result table - withheld by the agreed terms";
    case "matched":
      return `${new Intl.NumberFormat("en-US").format(
        outcome.matchedRecordCount ?? 0,
      )} matched rows${matchedRowsSuffix}`;
  }
}

/**
 * The disclosure ledger for the spine, filling in as the exchange takes shape:
 * before a file is read every value is the em-dash placeholder; once a session
 * exists the send list, matched-on keys, expiry, and result direction are read
 * live from the draft. Once minted, `expires` replaces the relative lifetime
 * phrase; once complete, `outcome` replaces the forward-looking rows.
 *
 * The send row names the operator's OWN disclosed CSV headers, so they take the
 * isolation their column-name surfaces show them with ({@link isolatedColumnName})
 * rather than the escape partner-controlled text takes.
 */
export function inviterLedgerRows(
  editor: InviterEditor | undefined,
  expiresIso?: string,
  outcome?: LedgerOutcome,
): Array<InviterLedgerRow> {
  if (editor === undefined) {
    return [
      { label: "You will send", reference: "Step 2", shareBar: true },
      { label: "You will receive", reference: "Step 2" },
      { label: "Matched on", reference: "Step 2", shareBar: true },
      { label: "Expires", reference: "Step 3", shareBar: true },
      { label: "Results go to", reference: "Step 3" },
      { label: "Agreement" },
      { label: "How it runs", reference: "Step 3" },
    ];
  }
  const sent = disclosedColumnNames(editor.draft.metadata);
  const keys = enabledKeys(editor.draft);
  return [
    sent.length > 0
      ? {
          label: "You will send",
          reference: "Step 2",
          value: sent.map(isolatedColumnName).join(", "),
          shareBar: true,
        }
      : {
          label: "You will send",
          reference: "Step 2",
          muted: "Nothing - matching only",
          shareBar: true,
        },
    {
      label: "You will receive",
      reference: "Step 2",
      value:
        outcome === undefined
          ? "Matched rows + your partner's shared columns"
          : settledReceiveValue(outcome, " + shared columns"),
    },
    keys.length > 0
      ? {
          label: "Matched on",
          reference: "Step 2",
          value: keys.map((key, index) => `${index + 1}. ${key.name}`),
          shareBar: true,
        }
      : {
          label: "Matched on",
          reference: "Step 2",
          muted: "No keys",
          shareBar: true,
        },
    {
      label: "Expires",
      reference: "Step 3",
      value:
        outcome !== undefined
          ? "Invitation used"
          : expiresIso !== undefined
            ? dateTimeLabel(new Date(expiresIso))
            : lifetimeLabel(editor.draft.lifetimeSeconds),
      shareBar: true,
    },
    {
      label: "Results go to",
      reference: "Step 3",
      value: RESULTS_DIRECTION_LABELS[editor.draft.outputDirection],
    },
    editor.draft.legalAgreement?.reference !== undefined &&
    editor.draft.legalAgreement.reference !== ""
      ? { label: "Agreement", value: editor.draft.legalAgreement.reference }
      : { label: "Agreement", muted: "None" },
    {
      label: "How it runs",
      reference: "Step 3",
      value: TRANSPORT_LEDGER_LABELS[editor.transport ?? "browser"],
    },
  ];
}
