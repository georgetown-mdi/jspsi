import { useId, useState } from "react";

import {
  Badge,
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
 * The always-visible header for one linkage key: its name and -- when the key
 * carries any non-default matching rule -- the "Non-standard matching" badge.
 * This stays OUTSIDE the Details disclosure so a non-standard rule (which changes
 * which records match, and under `psi` which identifiers are disclosed) is never
 * hidden in collapsed content; the per-element transform/swap detail it summarizes
 * lives in {@link MatchKeyDetails} inside the disclosure.
 */
function MatchKeyName({ summary }: { summary: InvitationKeySummary }) {
  return (
    <Group gap="xs">
      <Text size="sm">{summary.name}</Text>
      {summary.hasNonDefaultRule && (
        // role="img" makes the aria-label the badge's accessible name: a Mantine
        // Badge renders as a plain <div>, on which an aria-label alone is
        // unreliably exposed to assistive tech and, where honored, would clash
        // with the visible text.
        <Badge
          size="xs"
          color="yellow"
          variant="light"
          role="img"
          aria-label="Warning: this key uses non-standard matching rules"
        >
          Non-standard matching
        </Badge>
      )}
    </Group>
  );
}

/**
 * The per-element transform/swap detail for one linkage key: its ordered elements
 * (each annotated with the transform or fuzzy comparison that alters its match)
 * and a note for a swap. Rendered inside the Details disclosure beneath the key's
 * always-visible name (see {@link MatchKeyName}).
 *
 * The element/transform/swap rendering below is relocated verbatim from the
 * merged consent-screen MatchKey block (board item 200878066) and is treated as a
 * black box: its internal accessibility (programmatic grouping/provenance,
 * plain-language transform identity, leaf-line list semantics) is item 202228494's
 * territory -- do NOT restructure it here. Only the name+badge header was lifted
 * out, to the always-visible {@link MatchKeyName}.
 */
function MatchKeyDetails({ summary }: { summary: InvitationKeySummary }) {
  // A block, not a <List.Item>: it carries flow content (a nested element list, a
  // swap note), which Mantine's List.Item would place inside an inline <span>,
  // producing invalid markup. The key name repeats here (plain, no badge) so the
  // detail reads in context once the disclosure is open.
  return (
    <Stack gap={2}>
      <Text size="sm">{summary.name}</Text>
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
                  - fuzzy match: {element.fuzzyComparison}
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
                <Text size="xs" c="dimmed">
                  transformed ({transform.function})
                </Text>
                {/* Plain-language description of the function's matching effect.
                    Fixed copy keyed by the recognized function name (not
                    partner-controlled), so it renders verbatim; absent for a
                    function name core does not recognize. */}
                {transform.description !== undefined && (
                  <Text size="xs" c="dimmed" pl="md" fs="italic">
                    {transform.description}
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
 * Renders the inviter's linkage terms decoded from an invitation for review. The
 * dense, matching-rule detail (per-element transforms and swaps, personal-data
 * constraints, payload columns, legal agreement, and dedup notes) sits behind a
 * single default-collapsed "Details" disclosure; the always-visible core is the
 * matching method, the names of the keys records are matched on, result sharing,
 * and -- crucially -- the "Non-standard matching" badge, so a rule that changes
 * which records match is never hidden in collapsed content.
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
  perspective = "review",
  headingOrder = 2,
  headingRef,
}: {
  linkageTerms: LinkageTerms;
  /** The invitation's expiry instant (ISO 8601), if it carries one. */
  expires?: string;
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
  const summary = summarizeInvitation({ linkageTerms, expires });
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Stable id linking the disclosure toggle (aria-controls) to its panel; useId
  // keeps it consistent across SSR and hydration.
  const detailsId = useId();
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

        <Term label="Records are matched on">
          {/* Always visible: just the key names and the non-standard-matching
              badge. The per-element transform/swap detail moves into the Details
              disclosure below (MatchKeyDetails). Keyed by index -- the list is
              static and key names are not unique once sanitized. */}
          <Stack gap="xs">
            {summary.linkageKeys.map((key, index) => (
              <MatchKeyName key={index} summary={key} />
            ))}
          </Stack>
        </Term>

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
      </Stack>

      {/* A real disclosure: the toggle carries aria-expanded and aria-controls,
          and Mantine's Collapse sets aria-hidden + inert (and display:none) on the
          panel while closed, so the dense detail is hidden from assistive tech and
          the tab order until opened. This holds because the app theme leaves
          respectReducedMotion off, so Collapse animates and keeps the panel
          mounted-but-hidden. Turning respectReducedMotion on would make Collapse
          unmount the closed panel for a reduced-motion user, dangling this
          aria-controls -- revisit (e.g. a stable wrapper holding the id) before
          enabling it. */}
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
              transform: detailsOpen ? "rotate(90deg)" : undefined,
              transition: "transform 150ms ease",
            }}
          />
          <Text size="sm" fw={500}>
            Details
          </Text>
        </Group>
      </UnstyledButton>

      <Collapse id={detailsId} expanded={detailsOpen}>
        <Stack gap="sm">
          <Term label="Matching rules">
            {/* A Stack of key blocks, not a Mantine List: each key renders flow
                content (see MatchKeyDetails), which a List.Item would nest
                invalidly. Keyed by index -- the list is static and key names are
                not unique once sanitized. */}
            <Stack gap="sm">
              {summary.linkageKeys.map((key, index) => (
                <MatchKeyDetails key={index} summary={key} />
              ))}
            </Stack>
          </Term>

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
              {summary.payload.send.length > 0 && (
                <Stack gap={2}>
                  <Text size="sm">Your partner will send:</Text>
                  {/* One column per item rather than a joined string: a
                      partner-controlled column name may contain the separator,
                      which joined text would render as spurious extra columns.
                      Keyed by index -- column order is fixed and a sanitized
                      name is not unique. */}
                  <List size="sm" withPadding listStyleType="circle">
                    {summary.payload.send.map((column, index) => (
                      <List.Item key={index}>{column}</List.Item>
                    ))}
                  </List>
                </Stack>
              )}
              {summary.payload.receive.length > 0 && (
                <Stack gap={2}>
                  <Text size="sm">Your partner requests from you:</Text>
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
