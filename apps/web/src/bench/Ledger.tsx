import { useState } from "react";

import { IconInfoCircle } from "@tabler/icons-react";

import { Tooltip } from "@mantine/core";

import { DisclosureSection } from "../components/DisclosureSection";
import styles from "./bench.module.css";
import { useNarrowBench } from "./narrowViewport";

import type { RailFact } from "./inviterModel";
import type { ReactNode } from "react";

/** The narrow share bar's rows in ledger order: the headline disclosure facts
 * each row producer marked `shareBar` -- the producer declares its own
 * condensed subset, so a relabel cannot silently drop a row from the trust
 * surface. The leading-rows fallback is a best-effort backstop only, keeping
 * the bar non-empty should a producer mark nothing; the unit suite pins each
 * producer's marked subset, so it is not a guarantee anything relies on. */
function shareBarRows(
  rows: ReadonlyArray<LedgerRow>,
): ReadonlyArray<LedgerRow> {
  const headline = rows.filter((row) => row.shareBar === true);
  return headline.length > 0 ? headline : rows.slice(0, 3);
}

/**
 * One row of the disclosure ledger: an uppercase label, the value in the
 * bench's monospace data voice, and an optional reference to the spine step
 * that owns the value ("Step 2"). `muted` is the named empty state ("None",
 * "Nothing - matching only"), rendered in the placeholder voice; with neither
 * the row shows the em-dash "not decided yet" mark. `shareBar` carries the
 * producer's marker for the narrow condensed bar (see {@link shareBarRows}).
 */
export interface LedgerRow {
  label: string;
  value?: ReactNode;
  muted?: string;
  reference?: string;
  shareBar?: boolean;
}

/** Plain-language explanations for the ledger's row headings, surfaced by the
 * info icon beside each heading (hover, focus, or tap). Keyed by row label so
 * every producer -- the inviter's, the acceptor's, and their settled past-tense
 * variants -- gets one shared explanation; a label with no entry renders
 * without an icon. Perspective-neutral wording, since the same label can face
 * either party. */
const HEADING_INFO: Record<string, string | undefined> = {
  "You will send":
    "The columns from your file your partner will receive, and only for " +
    "records you both hold. Nothing is sent for your other records.",
  "You sent":
    "The columns from your file your partner received, and only for " +
    "records you both hold. Nothing was sent for your other records.",
  "You will receive":
    "What you get when the exchange finishes: which of your records your " +
    "partner also holds, plus any columns your partner marked as sent.",
  "You received":
    "What arrived when the exchange finished: the records you both hold, " +
    "plus any columns your partner marked as sent.",
  "Matched on":
    "The fields used to decide whether your record and your partner's " +
    "record are the same, tried in order. Only cryptographic fingerprints " +
    "of these fields are compared; the values themselves are not revealed.",
  Expires:
    "When the invitation stops working. If it expires before the exchange " +
    "runs, a new invitation is needed.",
  "Results go to":
    "Who receives the list of matched records when the exchange finishes.",
  "Results went to":
    "Who received the list of matched records when the exchange finished.",
  Agreement:
    "The data sharing agreement referenced for this exchange, if any. Both " +
    "parties see the reference before the exchange runs.",
  Transport:
    "How the exchange runs: live between your two browsers, or through " +
    "files on an SFTP server or shared directory using the command-line " +
    "tool.",
};

/** The info icon beside a ledger heading: a focusable control whose tooltip
 * explains the heading in plain language. Hover, keyboard focus, and touch all
 * open it; the accessible name says which heading it explains, and the open
 * tooltip is associated as the control's description. */
function HeadingInfo({ label, info }: { label: string; info: string }) {
  return (
    <Tooltip
      label={info}
      multiline
      w={250}
      events={{ hover: true, focus: true, touch: true }}
    >
      <button
        type="button"
        className={styles.ledgerInfo}
        aria-label={`What "${label}" means`}
      >
        <IconInfoCircle size={13} aria-hidden="true" />
      </button>
    </Tooltip>
  );
}

const FACT_TONE_CLASS = {
  edited: `${styles.val} ${styles.valEdited}`,
  attention: `${styles.val} ${styles.valAttention}`,
} as const;

/** A Customize row's quiet fact: the em-dash "nothing yet" mark when absent,
 * the model's tone color when present. The fact is plain text inside the row,
 * so an attention state is never conveyed by color alone. */
function CustomizeFactValue({ entry }: { entry: RailFact }) {
  return (
    <span
      className={
        entry.tone === undefined ? styles.val : FACT_TONE_CLASS[entry.tone]
      }
    >
      {entry.fact ?? "\u2014"}
    </span>
  );
}

/**
 * The ledger's Customize group, shown only while the terms are editable: one
 * plain button per optional surface (normal tab order, no menu semantics),
 * pairing the surface's label with its quiet fact. The open tab's row carries
 * `aria-current="true"` and the accent style; a surface not yet reachable
 * (no file read) renders its row disabled. `groupNote` is the line above the
 * rows -- the "Customize" heading on the wide ledger, the "Filled in from your
 * file." note inside the narrow disclosure whose toggle already reads
 * "Customize".
 */
function LedgerCustomize({
  facts,
  groupNote,
}: {
  facts: ReadonlyArray<RailFact>;
  /** The line above the rows. Absent on the wide ledger (the uppercase
   * "Customize" heading); the narrow disclosure passes the softer "Filled in
   * from your file." note, its toggle already carrying the "Customize" name. */
  groupNote?: string;
}) {
  return (
    <div className={styles.ledgerCustomize}>
      <p
        className={
          groupNote === undefined
            ? styles.ledgerGroupLabel
            : styles.customizeGroupNote
        }
      >
        {groupNote ?? "Customize"}
      </p>
      <ul>
        {facts.map((entry) => (
          <li key={entry.label}>
            <button
              type="button"
              className={styles.customizeRow}
              disabled={entry.onSelect === undefined}
              onClick={entry.onSelect}
              aria-current={entry.current === true ? "true" : undefined}
            >
              <span
                className={
                  entry.current === true ? styles.customizeCurrent : undefined
                }
              >
                {entry.label}
              </span>
              <CustomizeFactValue entry={entry} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The sealed-terms tag and sample-data notice shown under the ledger title:
 * standing trust state that survives every viewport, so it renders above the
 * disclosures on a narrow layout too. */
function LedgerStanding({
  tag,
  demoNotice,
}: {
  tag?: string;
  demoNotice?: { label: string; onClear?: () => void };
}) {
  return (
    <>
      {tag !== undefined && <span className={styles.sealedTag}>{tag}</span>}
      {demoNotice !== undefined && (
        <div className={styles.demoNotice}>
          <span>{demoNotice.label}</span>
          {demoNotice.onClear !== undefined && (
            <button
              type="button"
              className={styles.demoClear}
              onClick={demoNotice.onClear}
            >
              Clear
            </button>
          )}
        </div>
      )}
    </>
  );
}

/** The ledger's fact rows as a definition list. */
function LedgerRows({ rows }: { rows: ReadonlyArray<LedgerRow> }) {
  return (
    <dl>
      {rows.map((row) => {
        const info = HEADING_INFO[row.label];
        return (
          <div key={row.label} className={styles.ledgerRow}>
            <dt>
              <span className={styles.ledgerTerm}>
                {row.label}
                {info !== undefined && (
                  <HeadingInfo label={row.label} info={info} />
                )}
              </span>
              {row.reference !== undefined && (
                <span className={styles.ledgerRef}>{row.reference}</span>
              )}
            </dt>
            <dd>
              {row.value ?? (
                <span className={styles.dash}>{row.muted ?? "\u2014"}</span>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/**
 * The standing disclosure ledger on the bench's right: always visible,
 * filling in as the exchange takes shape -- the running answer to "what leaves
 * this machine". Rendered as an `<aside>` landmark named by its title. While
 * the terms are editable it also hosts the Customize group's surface rows
 * ({@link LedgerCustomize}); the hosting bench withholds `customize` once the
 * terms seal or the run launches.
 *
 * At or below the narrow cut-over the aside folds to a collapsible "What you
 * will share" bar (a condensed three-row subset plus the trust footer) and,
 * when editable, a separate Customize disclosure. The hosting {@link
 * BenchShell} pins this aside ahead of the work column at that width, making
 * the share bar the page's first interactive element.
 */
export function Ledger({
  title = "This exchange",
  tag,
  demoNotice,
  rows,
  customize,
  footer,
}: {
  title?: string;
  /** A standing state marker under the title -- "Terms locked when the
   * invitation was created" once the invitation is minted and the ledger
   * stops being editable. */
  tag?: string;
  /** A quiet standing notice shown while the loaded file is the synthetic
   * sample (pristine or edited). `onClear` renders its Clear action; the
   * hosting bench withholds it once the terms seal (an invitation minted or an
   * exchange file saved), where a one-click teardown would be destructive. */
  demoNotice?: { label: string; onClear?: () => void };
  rows: ReadonlyArray<LedgerRow>;
  /** The optional surfaces' Customize rows; absent once the terms seal (the
   * share/save/launched phases). */
  customize?: ReadonlyArray<RailFact>;
  footer?: ReactNode;
}) {
  const narrow = useNarrowBench();
  if (narrow) {
    return (
      <NarrowLedger
        title={title}
        tag={tag}
        demoNotice={demoNotice}
        rows={rows}
        customize={customize}
        footer={footer}
      />
    );
  }
  return (
    <aside className={styles.ledger} aria-label={title}>
      <h2>{title}</h2>
      <LedgerStanding tag={tag} demoNotice={demoNotice} />
      <LedgerRows rows={rows} />
      {customize !== undefined && <LedgerCustomize facts={customize} />}
      {footer !== undefined && <p className={styles.trust}>{footer}</p>}
    </aside>
  );
}

/**
 * The ledger at a narrow viewport: a collapsible "What you will share" bar
 * over the condensed top rows plus the trust footer, and -- while the terms
 * are editable -- a separate Customize disclosure holding the same surface
 * rows. Both default collapsed but present, one tap from their contents.
 * Still an `<aside>` named by the ledger title, so the trust landmark survives
 * the fold. The share bar comes first so it is the page's first interactive
 * element ahead of the sample notice's Clear action; the standing tag and
 * sample notice follow it, always visible.
 */
function NarrowLedger({
  title,
  tag,
  demoNotice,
  rows,
  customize,
  footer,
}: {
  title: string;
  tag?: string;
  demoNotice?: { label: string; onClear?: () => void };
  rows: ReadonlyArray<LedgerRow>;
  customize?: ReadonlyArray<RailFact>;
  footer?: ReactNode;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  return (
    <aside className={styles.narrowLedger} aria-label={title}>
      <div className={styles.shareBar}>
        <DisclosureSection
          label="What you will share"
          headingOrder={2}
          open={shareOpen}
          onToggle={setShareOpen}
        >
          <div className={styles.shareBarBody}>
            <LedgerRows rows={shareBarRows(rows)} />
            {footer !== undefined && <p className={styles.trust}>{footer}</p>}
          </div>
        </DisclosureSection>
      </div>
      {customize !== undefined && (
        <div className={styles.customizeDisclosure}>
          <DisclosureSection
            label="Customize"
            open={customizeOpen}
            onToggle={setCustomizeOpen}
          >
            <LedgerCustomize
              facts={customize}
              groupNote="Filled in from your file."
            />
          </DisclosureSection>
        </div>
      )}
      <LedgerStanding tag={tag} demoNotice={demoNotice} />
    </aside>
  );
}
