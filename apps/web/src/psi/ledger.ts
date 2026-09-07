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

/** The clause both count-only receive rows close with, the forward-looking one
 * and the settled one, so what the row promises and what it reports cannot
 * drift apart. */
const COUNT_ONLY_NO_TABLE = "no matched rows and no shared columns";

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
    `common - the size of the overlap only, ${COUNT_ONLY_NO_TABLE}` +
    (countReportedByPartner ? "; reported by your partner" : "")
  );
}

/**
 * The receive row's value BEFORE a count-only run, shared by both seats: a
 * count-only exchange produces the overlap size for whoever the terms give it
 * to and nothing else, so the row states that rather than promising the matched
 * rows and shared columns no such run produces for anyone. Same vocabulary as
 * the settled count-only row ({@link countOnlyLedgerValue}), minus a figure
 * neither party has yet.
 */
export const COUNT_ONLY_RECEIVE_ROW_VALUE = `How many records you have in common - ${COUNT_ONLY_NO_TABLE}`;

/**
 * The receive row's value for a matched run whose row count never reached this
 * browser -- the console holds the result file and counts none of its rows.
 * The row names what arrived and where the count is, rather than displaying
 * the zero a missing figure would otherwise default to. `matchedRowsSuffix` is
 * the caller's, as in {@link settledReceiveValue}.
 */
function uncountedMatchedValue(matchedRowsSuffix: string): string {
  return (
    `Matched rows${matchedRowsSuffix} - row count not available; ` +
    "download the result to count them"
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
      return outcome.matchedRecordCount === undefined
        ? uncountedMatchedValue(matchedRowsSuffix)
        : `${new Intl.NumberFormat("en-US").format(
            outcome.matchedRecordCount,
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
  const forwardReceive =
    editor.draft.algorithm === "psi-c"
      ? COUNT_ONLY_RECEIVE_ROW_VALUE
      : "Matched rows + your partner's shared columns";
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
          ? forwardReceive
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
