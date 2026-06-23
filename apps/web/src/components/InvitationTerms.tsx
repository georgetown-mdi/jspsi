import { useId, useState } from "react";

import {
  Collapse,
  Group,
  List,
  Stack,
  Text,
  Title,
  UnstyledButton,
  VisuallyHidden,
} from "@mantine/core";

import { IconChevronRight } from "@tabler/icons-react";

import { summarizeInvitation } from "@psi/invitationSummary";

import type { ReactNode, Ref } from "react";

import type { LinkageTerms } from "@psilink/core";

import type { InvitationKeySummary } from "@psi/invitationSummary";

function yesNo(value: boolean): string {
  return value ? "Yes" : "No";
}

/** A labelled block: a bold caption above its value(s). */
function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={600}>
        {label}
      </Text>
      {children}
    </Stack>
  );
}

/**
 * One linkage key as a collapsible disclosure: the always-visible header is the
 * key's name and a short derived one-liner of the fields it matches on (each with
 * a terse breadth marker when its element loosens matching), and the expanded body
 * is the per-element transform/swap/fuzzy detail ({@link MatchKeyDetails}). The
 * header is the honest, always-visible anchor -- the field one-liner is derived
 * from the schema-validated semantic types (see
 * {@link InvitationKeySummary.headerFields}), so a partner-controlled key name
 * cannot misrepresent what the key matches on.
 *
 * The disclosure mirrors the master-detail pattern below: aria-expanded +
 * aria-controls on the toggle, the id on the always-mounted wrapper (not the
 * Collapse panel) so it survives Mantine's reduced-motion unmount, and the panel
 * hidden from assistive tech + the tab order while closed. The toggle's accessible
 * name is the key name alone; the field one-liner is associated as its description
 * (aria-describedby) rather than folded into the name, so a screen reader hears
 * "<key name>, button, collapsed" and then the fields as the description.
 */
function MatchKeyDisclosure({ summary }: { summary: InvitationKeySummary }) {
  const [open, setOpen] = useState(false);
  // Stable ids across SSR/hydration; one component instance per key, so useId is
  // called once per widget (never inside a map).
  const panelId = useId();
  const sublineId = useId();
  return (
    <Stack gap={2} role="listitem">
      <UnstyledButton
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-expanded={open}
        aria-controls={panelId}
        aria-describedby={sublineId}
      >
        <Group gap={4}>
          <IconChevronRight
            size={16}
            aria-hidden
            style={{
              transform: open ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 150ms ease",
            }}
          />
          <Text size="sm" fw={500}>
            {summary.name}
          </Text>
        </Group>
      </UnstyledButton>
      {/* Always-visible, AT-associated breadth signal. The "Matches on " lead-in
          and the markers are fixed copy, and each field entry is a fixed compact
          label: the sanitized unknown-field fallback is unreachable for a decoded
          token (a dangling field reference is rejected at decode) and cosmetic-only
          if ever reached, so the joined line carries no unescaped partner text. */}
      <Text id={sublineId} size="xs" c="dimmed">
        Matches on {summary.headerFields.join(" - ")}
        {summary.hasSwap && " (matched in either order)"}
      </Text>
      <div id={panelId}>
        <Collapse expanded={open}>
          <MatchKeyDetails summary={summary} />
        </Collapse>
      </div>
    </Stack>
  );
}

/**
 * The per-element transform/swap detail for one linkage key, shown in the expanded
 * body of its {@link MatchKeyDisclosure}: each ordered element with the transform
 * or fuzzy comparison that alters its match, and a swap note. Each element's
 * transforms lead with their plain matching consequence (the literal slice phrase
 * or the glossary description), with the raw function name and parameters following
 * as technical detail rather than leading.
 */
function MatchKeyDetails({ summary }: { summary: InvitationKeySummary }) {
  // A block, not a <List.Item>: it carries flow content (a nested element list, a
  // swap note), which Mantine's List.Item would place inside an inline <span>,
  // producing invalid markup. The key name is not repeated here -- the disclosure
  // header carries it.
  return (
    <Stack gap={2}>
      {/* Elements (and their transforms/parameters) render as a Stack of
          blocks, not a Mantine List: a transform with parameters needs nested
          structure, which a List.Item -- whose children sit in an inline span
          -- cannot hold validly. Keyed by index: element order is fixed for a
          given key, and a field label is not unique across elements. */}
      <Stack gap={4}>
        {summary.elements.map((element, index) => (
          <Stack key={index} gap={2}>
            <Text size="sm">
              {element.fieldLabel}
              {element.fuzzyComparison !== undefined && (
                <Text span size="xs" c="dimmed">
                  {" "}
                  - also matches approximate variants ({element.fuzzyComparison}
                  )
                  {/* Flag a proposed expansion the run does not yet perform, so
                      the acceptor is not told a looser match occurs when it
                      does not. */}
                  {!element.fuzzyComparisonApplied &&
                    " (proposed; not yet applied)"}
                </Text>
              )}
            </Text>
            {/* Each transform, and each of its parameters, is its own block --
                never joined: a partner-controlled function name or parameter
                value may contain any separator, which joined text would render
                as spurious extra steps or parameters. */}
            {element.transforms.map((transform, ti) => (
              <Stack key={ti} gap={0} pl="md">
                {/* Lead with the plain matching consequence: the literal slice
                    phrase when faithful, else the glossary description, else --
                    for a function core does not recognize -- the bare sanitized
                    name. All are fixed/sanitized copy, not raw partner free text. */}
                <Text size="xs" c="dimmed">
                  {transform.effect !== undefined
                    ? `Matches on ${transform.effect}`
                    : transform.description !== undefined
                      ? transform.description
                      : `Applies ${transform.function}`}
                </Text>
                {/* The raw function name as secondary detail when a plainer lead
                    replaced it, so the technical identity stays available. */}
                {(transform.effect !== undefined ||
                  transform.description !== undefined) && (
                  <Text size="xs" c="dimmed" pl="md" fs="italic">
                    {transform.function}
                  </Text>
                )}
                {transform.params.map((param, pi) => (
                  <Text key={pi} size="xs" c="dimmed" pl="md">
                    {param}
                  </Text>
                ))}
                {/* Runtime-coercion notes for params the function overrides
                    (e.g. replacement: null runs as the empty string). Rendered
                    as their own element, with the fixed "runs as" copy as static
                    JSX text between two core-derived values -- never folded into
                    a partner-controlled param line -- so the note cannot be
                    impersonated by text placed inside a param value. The
                    italic styling marks it as a system note visually; the
                    VisuallyHidden lead-in carries that same provenance to a
                    screen reader (a partner controls only param-value text, so
                    it cannot inject this element), since italics are not
                    announced. */}
                {transform.coercions?.map((coercion, ci) => (
                  <Text key={ci} size="xs" c="dimmed" pl="md" fs="italic">
                    <VisuallyHidden>Runtime note: </VisuallyHidden>
                    {coercion.param} runs as {coercion.runsAs}
                  </Text>
                ))}
              </Stack>
            ))}
          </Stack>
        ))}
      </Stack>
      {summary.hasSwap && (
        <Text size="xs" c="dimmed">
          {summary.swap !== undefined
            ? `${summary.swap[0]} and ${summary.swap[1]} may be matched in either order`
            : "Two of these elements may be matched in either order"}
        </Text>
      )}
      {/* When both swapped elements carry transforms, the receiver applies each
          element's transforms to the OTHER element's field value (the field
          references swap, the transforms stay put), which the generic swap note
          above does not convey. swapTransformInterchange implies swap is set. */}
      {summary.swapTransformInterchange && summary.swap !== undefined && (
        <Text size="xs" c="dimmed">
          When matched in that order, the transforms shown for {summary.swap[0]}{" "}
          are applied to {summary.swap[1]}&rsquo;s value, and those for{" "}
          {summary.swap[1]} to {summary.swap[0]}&rsquo;s value.
        </Text>
      )}
    </Stack>
  );
}

/**
 * Renders the inviter's linkage terms decoded from an invitation for review. Each
 * linkage key is its own default-collapsed disclosure under "Records are matched
 * on": the always-visible header is the key name and a short derived one-liner of
 * the fields it matches on (each carrying a terse breadth marker -- "(partial)",
 * "(fuzzy)" -- when its element loosens matching), and the expanded body holds the
 * per-element transform/swap/fuzzy detail. The remaining dense detail (personal-
 * data constraints, payload columns, legal agreement, and dedup notes) sits behind
 * a single default-collapsed "Other details" disclosure. The matching method and
 * result sharing stay always-visible.
 *
 * Two facts whose detail lives in that disclosure also carry an always-visible
 * PRESENCE hint in the core, since either would otherwise be invisible until the
 * acceptor expands Details: an extra-payload-egress request (a count of the columns
 * the inviter requests FROM the acceptor) and an attached legal agreement (a
 * fixed-copy flag). Only the presence is surfaced -- the column list and the
 * agreement text stay in Details, not duplicated into the core.
 *
 * `perspective` chooses only the heading and intro copy for the three contexts
 * this renders in: the acceptor `review`ing a partner's proposal (pre-consent),
 * the acceptor viewing the terms it has `accepted` (during the run, so the copy is
 * past-tense rather than "proposes"), and the inviter looking at the terms it is
 * `proposing` (its own identity, so it is not labelled "Invitation from <self>").
 * The terms body is identical for all three. `headingOrder` sets only the
 * heading's semantic level (its visual size is fixed), so the outline nests
 * correctly under the page's `h1` (acceptor) or section `h2` (inviter).
 *
 * All partner-controlled free text is sanitized for display by
 * {@link summarizeInvitation}, mirroring the CLI's `displayInvitation`: the
 * inviter crafts the token, so its identity, key names, and legal/payload text
 * are untrusted and could otherwise carry control, bidi, or homoglyph characters
 * that JSX escaping alone does not neutralize.
 */
export function InvitationTerms({
  linkageTerms,
  expires,
  disclosedPayloadColumns,
  perspective = "review",
  headingOrder = 2,
  headingRef,
}: {
  linkageTerms: LinkageTerms;
  /** The invitation's expiry instant (ISO 8601), if it carries one. */
  expires?: string;
  /** The columns the invitation declared the inviter will send (its
   * `disclosedPayloadColumns`). When present, the "your partner will send" line
   * derives from it -- the wire's own disclosure predicate -- rather than the
   * authored `payload.send`; absent for the inviter's pre-mint "proposing"
   * preview and older tokens, which fall back to `payload.send`. */
  disclosedPayloadColumns?: Array<string>;
  /** Which context this renders in. Changes only the heading and intro copy; the
   * body is identical. */
  perspective?: "review" | "accepted" | "proposing";
  /** Semantic heading level (its visual size is fixed at the h2 scale), so the
   * heading nests correctly under its container -- h2 below the acceptor page's
   * h1, h3 below the inviter section's h2. */
  headingOrder?: 2 | 3;
  // tabIndex + ref so a screen the terms lead can move focus here when they
  // appear, announcing them to assistive tech.
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const summary = summarizeInvitation({
    linkageTerms,
    expires,
    disclosedPayloadColumns,
  });
  // Always-visible egress notice: the count of columns the inviter requests FROM
  // the acceptor (summary.payload.receive) -- the acceptor's own data egress.
  // A count, not the column names: the length is a bounded integer (the column
  // count is capped at decode, MAX_PAYLOAD_ENTRIES), so it carries no partner
  // free text into the always-visible core regardless of what the names contain;
  // the names themselves stay sanitized in Details. The columns the inviter SENDS
  // are data the acceptor receives, not an egress, so they do not trip this
  // notice. Undefined when nothing is requested, so the notice is absent rather
  // than reading "0 columns".
  const receiveCount = summary.payload?.receive.length ?? 0;
  const egressNotice =
    receiveCount > 0
      ? `This invitation requests ${receiveCount} additional data ` +
        `${receiveCount === 1 ? "column" : "columns"} ` +
        `${perspective === "proposing" ? "from your partner" : "from you"}.`
      : undefined;
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Stable id linking the disclosure toggle (aria-controls) to its panel; useId
  // keeps it consistent across SSR and hydration.
  const detailsId = useId();
  // Associates the per-key disclosure list with its "Records are matched on"
  // caption, so assistive tech announces the keys as a named group.
  const matchedOnLabelId = useId();
  return (
    <Stack gap="sm">
      <Title order={headingOrder} size="h2" ref={headingRef} tabIndex={-1}>
        {perspective === "proposing"
          ? "Terms you are proposing"
          : `Invitation from ${summary.invitingParty}`}
      </Title>
      <Text size="sm" c="dimmed">
        {perspective === "proposing"
          ? "Your partner must review and consent to these terms before any data is exchanged."
          : perspective === "accepted"
            ? "These are the terms you consented to."
            : "These are the terms your partner proposes for linking your records."}
      </Text>

      <Stack gap="xs">
        <Term label="Matching method">
          <Text size="sm">
            {summary.algorithm === "psi-c"
              ? "Only the number of records you have in common is revealed, not which records match."
              : "The shared identifiers of records you have in common are revealed to whoever receives the result."}
          </Text>
          {/* psi-c is a disclosure guarantee: flag a proposed count-only setting
              the run does not yet honor, so the line above cannot read as in
              force while the exchange still reveals matched identifiers. */}
          {summary.algorithm === "psi-c" && !summary.psiCApplied && (
            <Text size="xs" c="dimmed">
              Your partner proposes this, but this version of the exchange does
              not yet apply it; the shared identifiers of matched records are
              still revealed.
            </Text>
          )}
        </Term>

        <Stack gap={2}>
          <Text size="sm" fw={600} id={matchedOnLabelId}>
            Records are matched on
          </Text>
          {/* A labelled list of per-key disclosures: each key's collapsed header
              (name + derived field one-liner) is always visible, its rule detail
              one expand down. role=list/listitem (not Mantine List.Item, whose
              inline span body cannot hold the disclosure's flow content) so AT
              announces the set; keyed by index -- the list is static and key names
              are not unique once sanitized. */}
          <Stack gap="xs" role="list" aria-labelledby={matchedOnLabelId}>
            {summary.linkageKeys.map((key, index) => (
              <MatchKeyDisclosure key={index} summary={key} />
            ))}
          </Stack>
        </Stack>

        {/* Viewer-centric, so each party reads its OWN outcome first-person rather
            than inferring it from the inviter's perspective: this is the consent-
            legible form for a one-sided exchange, where the acceptor must know plainly
            whether IT receives a result. The viewer is the inviter under
            "proposing" (its preview) and the acceptor under "review"/"accepted"; the
            acceptor receives iff the inviter shares (and shares iff the inviter
            receives), the mirror the exchange derives. */}
        <Term label="Result sharing">
          {perspective === "proposing" ? (
            <>
              <Text size="sm">
                You will receive the matched result:{" "}
                {yesNo(summary.inviterReceivesOutput)}
              </Text>
              <Text size="sm">
                Your partner will receive the result:{" "}
                {yesNo(summary.inviterSharesResult)}
              </Text>
            </>
          ) : (
            <>
              <Text size="sm">
                You will receive the matched result:{" "}
                {yesNo(summary.inviterSharesResult)}
              </Text>
              <Text size="sm">
                Your partner (the inviter) will receive the result:{" "}
                {yesNo(summary.inviterReceivesOutput)}
              </Text>
            </>
          )}
        </Term>

        {/* Always-visible presence hints, kept OUTSIDE the "Other details"
            disclosure (the same out-of-disclosure pattern the per-key breadth
            markers follow): an extra-payload-egress request and an attached legal
            agreement otherwise have NO surfaced signal that they exist at all --
            both sit only inside the default-collapsed Details, unlike the matching
            breadth, which is always visible in each key's header. This surfaces
            only the PRESENCE (a count, or a fixed-copy flag), never the detail: the
            column list and the agreement text stay one expand down, so the acceptor
            is on notice to open Details before consenting without the dense detail
            being duplicated into the core. */}
        {(egressNotice !== undefined ||
          summary.legalAgreement !== undefined) && (
          <Stack gap={4}>
            {egressNotice !== undefined && (
              <Text size="sm" fw={500}>
                {egressNotice}
              </Text>
            )}
            {summary.legalAgreement !== undefined && (
              <Text size="sm" fw={500}>
                This invitation attaches a legal agreement.
              </Text>
            )}
          </Stack>
        )}
      </Stack>

      {/* A real disclosure: the toggle carries aria-expanded and aria-controls,
          and Mantine's Collapse sets aria-hidden + inert (and display:none) on the
          panel while closed, so the dense detail is hidden from assistive tech and
          the tab order until opened. aria-controls points at the stable wrapper
          below, not the Collapse panel: with respectReducedMotion on, Collapse
          unmounts the closed panel for a reduced-motion user, which would dangle an
          id held on the panel itself; the always-mounted wrapper keeps the
          reference resolvable in every state and under either motion preference
          (collapsed content is hidden from AT when the panel is mounted-but-hidden,
          and absent when it is unmounted). A render test pins this against the
          accessibility tree, so the wrapper is not safe to inline back onto the
          panel. */}
      <UnstyledButton
        onClick={() => setDetailsOpen((open) => !open)}
        aria-expanded={detailsOpen}
        aria-controls={detailsId}
      >
        <Group gap={4}>
          <IconChevronRight
            size={16}
            aria-hidden
            style={{
              transform: detailsOpen ? "rotate(90deg)" : "rotate(0deg)",
              transition: "transform 150ms ease",
            }}
          />
          <Text size="sm" fw={500}>
            Other details
          </Text>
        </Group>
      </UnstyledButton>

      <div id={detailsId}>
        <Collapse expanded={detailsOpen}>
          <Stack gap="sm">
            <Term label="Personal data used">
              <Stack gap="xs">
                {summary.linkageFields.map((field, index) =>
                  field.constraints.length > 0 ? (
                    <Stack key={index} gap={2}>
                      <Text size="sm">{field.label}</Text>
                      {/* Each constraint as its own item rather than a joined
                        string: a partner-controlled allowedCharacters class may
                        contain the separator, which joined text would render as
                        spurious extra clauses. Keyed by index -- order is fixed
                        for a field. */}
                      <List size="xs" withPadding listStyleType="circle">
                        {field.constraints.map((constraint, ci) => (
                          <List.Item key={ci}>
                            <Text span size="xs" c="dimmed">
                              {constraint}
                            </Text>
                          </List.Item>
                        ))}
                      </List>
                    </Stack>
                  ) : (
                    <Text key={index} size="sm">
                      {field.label}
                    </Text>
                  ),
                )}
              </Stack>
            </Term>

            {summary.payload !== undefined && (
              <Term label="Additional data for matched records">
                {/* Viewer-centric, like Result sharing: under "proposing" the
                    inviter reads its OWN send/receive first-person ("You will
                    send"), while the acceptor reads them as the partner's ("Your
                    partner will send"). The columns are the same either way. */}
                {/* Shown whenever the send set is a definite declaration --
                    including the empty set, rendered "(none)" so the strict
                    "receive nothing" lock-in is visible rather than inferred from a
                    missing line (the CLI's displayInvitation shows the same). A
                    lazy send (not declared) is omitted instead. */}
                {summary.payload.sendDeclared && (
                  <Stack gap={2}>
                    <Text size="sm">
                      {perspective === "proposing"
                        ? "You will send:"
                        : "Your partner will send:"}
                    </Text>
                    {summary.payload.send.length > 0 ? (
                      // One column per item rather than a joined string: a
                      // partner-controlled column name may contain the separator,
                      // which joined text would render as spurious extra columns.
                      // Keyed by index -- column order is fixed and a sanitized
                      // name is not unique.
                      <List size="sm" withPadding listStyleType="circle">
                        {summary.payload.send.map((column, index) => (
                          <List.Item key={index}>{column}</List.Item>
                        ))}
                      </List>
                    ) : (
                      <Text size="sm" c="dimmed">
                        (none)
                      </Text>
                    )}
                  </Stack>
                )}
                {summary.payload.receive.length > 0 && (
                  <Stack gap={2}>
                    <Text size="sm">
                      {perspective === "proposing"
                        ? "You request from your partner:"
                        : "Your partner requests from you:"}
                    </Text>
                    <List size="sm" withPadding listStyleType="circle">
                      {summary.payload.receive.map((column, index) => (
                        <List.Item key={index}>{column}</List.Item>
                      ))}
                    </List>
                  </Stack>
                )}
              </Term>
            )}

            {summary.legalAgreement !== undefined && (
              <Term label="Legal agreement">
                <Text size="sm">{summary.legalAgreement.reference}</Text>
                <Text size="sm">{summary.legalAgreement.purpose}</Text>
                <Text size="xs" c="dimmed">
                  Valid through {summary.legalAgreement.expirationDate}
                </Text>
              </Term>
            )}

            <Term label="Duplicate matches">
              <Text size="sm">
                {summary.deduplicate
                  ? "A record may match more than one of the partner's records."
                  : "Each record matches at most one of the partner's records."}
              </Text>
              {/* A proposed looser setting the run does not yet honor: flag it
                rather than let the line above read as the behavior in force. */}
              {summary.deduplicate && !summary.deduplicateApplied && (
                <Text size="xs" c="dimmed">
                  Your partner proposes this, but this version of the exchange
                  does not yet apply it; each record still matches at most one.
                </Text>
              )}
            </Term>
          </Stack>
        </Collapse>
      </div>

      {summary.expires !== undefined && (
        <Text size="xs" c="dimmed">
          {/* Label the time zone: the expiry is one instant, but inviter and
              acceptor may be in different zones, so a bare local wall-clock time
              would read as a different deadline on each end. */}
          This invitation expires{" "}
          {new Date(summary.expires).toLocaleString(undefined, {
            timeZoneName: "short",
          })}
        </Text>
      )}
    </Stack>
  );
}
