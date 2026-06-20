import { useEffect, useMemo, useRef, useState } from "react";

import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Grid,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
  VisuallyHidden,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconArrowDown,
  IconArrowUp,
  IconInfoCircle,
} from "@tabler/icons-react";

import {
  INVITATION_LIFETIME_SECONDS,
  assessLinkageSatisfiability,
} from "@psilink/core";

import {
  buildAdvancedTerms,
  seedAdvancedInvite,
  validateAdvancedInvite,
} from "@psi/advancedInvite";

import { InvitationTerms } from "@components/InvitationTerms";

import type { LinkageTerms } from "@psilink/core";

import type {
  AdvancedInviteDraft,
  AdvancedInviteSeed,
} from "@psi/advancedInvite";

/** Upper bound on the inviter's name, mirroring the quick compose screen's bound
 * (it flows into the token's linkage terms and the deep-link URL). The core schema
 * also bounds it; this keeps the input from accepting an unwieldy value at all. */
const MAX_INVITER_NAME_LENGTH = 200;

/** Selectable invitation lifetimes, all within the core one-year ceiling. The
 * default ({@link INVITATION_LIFETIME_SECONDS}, one hour) is the first option, so
 * an inviter who does not touch this control keeps the quick path's lifetime. */
const LIFETIME_OPTIONS: Array<{ value: string; label: string }> = [
  { value: String(INVITATION_LIFETIME_SECONDS), label: "1 hour (recommended)" },
  { value: String(6 * 3600), label: "6 hours" },
  { value: String(24 * 3600), label: "1 day" },
  { value: String(7 * 24 * 3600), label: "7 days" },
  { value: String(30 * 24 * 3600), label: "30 days" },
  { value: String(365 * 24 * 3600), label: "1 year" },
];

/**
 * The column-aware Advanced-options editor: an edit rail, a live preview rendered
 * by the same {@link InvitationTerms} component the acceptor consent screen uses,
 * and a sticky validation footer. It is seeded from the auto-derived terms for the
 * inviter's columns (never a blank form) and authors only what this iteration
 * supports -- identity, invitation lifetime, an optional legal agreement, and which
 * linkage keys are active and in what order.
 *
 * Output sharing, the matching algorithm, deduplication, fuzzy comparisons, and
 * payload columns are deliberately NOT settable here (see {@link buildAdvancedTerms}):
 * the engine does not yet honor one-sided output or payload transmission
 * end-to-end, so surfacing those as controls would mint an invitation whose
 * headline behavior silently does not happen. They are visible read-only in the
 * preview (it annotates dedup/fuzzy as proposed-not-applied and states the
 * matching method), so nothing is hidden -- only the unselectable controls are
 * absent.
 *
 * Validation runs through {@link validateAdvancedInvite} (the core schema is the
 * single source); Generate is disabled until the draft parses and at least one key
 * is satisfiable by the inviter's columns, with errors shown inline against the
 * offending control.
 */
export function LinkageTermsEditor({
  seed,
  initialIdentity,
  onGenerate,
  generating = false,
}: {
  /** The starting point: the auto-derived terms for the inviter's columns, plus
   * the columns (for the live satisfiability check). */
  seed: AdvancedInviteSeed;
  /** The name to prefill the identity field with (carried from the compose
   * screen). Falls back to the seed terms' identity. */
  initialIdentity?: string;
  /** Called with the validated terms and chosen lifetime when the inviter presses
   * Generate. The terms are embedded verbatim by `generateInvitation`. */
  onGenerate: (terms: LinkageTerms, lifetimeSeconds: number) => void;
  /** Holds Generate disabled while an invitation is being generated. */
  generating?: boolean;
}) {
  // The draft is seeded once from the seed; "Reset to recommended" re-seeds it.
  const freshDraft = (): AdvancedInviteDraft => {
    const seeded = seedAdvancedInvite(
      initialIdentity ?? seed.terms.identity,
      seed.columns,
    ).draft;
    return seeded;
  };
  const [draft, setDraft] = useState<AdvancedInviteDraft>(freshDraft);

  // A polite live region for validation and reorder announcements, kept in a
  // stable wrapper so assistive tech announces updates (the Status component uses
  // the same idiom). Reorder sets a specific message; it is cleared by the next
  // interaction so it does not linger.
  const [announcement, setAnnouncement] = useState("");

  // Focus the editor heading once on mount so a keyboard/screen-reader user who
  // arrived from the compose screen lands on the editor, not the unmounted link.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const validation = useMemo(
    () => validateAdvancedInvite(draft, seed),
    [draft, seed],
  );
  const previewTerms = useMemo(
    () => buildAdvancedTerms(draft, seed),
    [draft, seed],
  );

  // Per-key satisfiability, derived once from the seed (its keys are pre-filtered
  // to those the columns can satisfy, so these are all satisfiable today; the
  // indicator still confirms it per key and stays correct if a key referencing an
  // unproducible field is ever added). A field is producible when it is declared
  // and not in the unsatisfied set.
  const producibleFieldNames = useMemo(() => {
    const { unsatisfied } = assessLinkageSatisfiability(
      seed.columns,
      seed.terms,
    );
    const unsatisfiedNames = new Set(unsatisfied.map((f) => f.name));
    return new Set(
      seed.terms.linkageFields
        .map((f) => f.name)
        .filter((name) => !unsatisfiedNames.has(name)),
    );
  }, [seed]);
  const keyIsSatisfiable = (index: number): boolean =>
    draft.keys[index].key.elements.every((el) =>
      producibleFieldNames.has(el.field),
    );

  const updateDraft = (next: Partial<AdvancedInviteDraft>) => {
    setAnnouncement("");
    setDraft((prev) => ({ ...prev, ...next }));
  };

  const toggleKey = (index: number, enabled: boolean) => {
    updateDraft({
      keys: draft.keys.map((entry, i) =>
        i === index ? { ...entry, enabled } : entry,
      ),
    });
  };

  const moveKey = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= draft.keys.length) return;
    const keys = [...draft.keys];
    [keys[index], keys[target]] = [keys[target], keys[index]];
    setDraft((prev) => ({ ...prev, keys }));
    setAnnouncement(
      `Moved ${keys[target].key.name} to position ${target + 1} of ${keys.length}. ` +
        "Keys earlier in the list match first.",
    );
  };

  const setLegalEnabled = (enabled: boolean) => {
    updateDraft({
      legalAgreement: enabled
        ? { reference: "", purpose: "", expirationDate: "" }
        : undefined,
    });
  };
  const updateLegal = (
    next: Partial<NonNullable<AdvancedInviteDraft["legalAgreement"]>>,
  ) => {
    // Merge inside the functional updater (reading `prev`, not the render
    // closure), so two legal-field updates in one batch cannot clobber each
    // other -- matching updateDraft's own batching protection. No-op when the
    // block is closed (legalAgreement undefined, only reachable if a field update
    // were batched after a disclosure-toggle off): spreading undefined would
    // silently build a partial block rather than throw, so guard it instead.
    setAnnouncement("");
    setDraft((prev) =>
      prev.legalAgreement === undefined
        ? prev
        : { ...prev, legalAgreement: { ...prev.legalAgreement, ...next } },
    );
  };

  const handleReset = () => {
    setDraft(freshDraft());
    setAnnouncement("Reset to the recommended settings.");
  };

  const handleGenerate = () => {
    if (!validation.canGenerate || validation.terms === undefined) return;
    onGenerate(validation.terms, draft.lifetimeSeconds);
  };

  // Focus the first legal-agreement field when the block is disclosed, so a
  // keyboard user is taken into it rather than left on the checkbox.
  const legalRefInput = useRef<HTMLInputElement>(null);
  const legalOpen = draft.legalAgreement !== undefined;
  const wasLegalOpen = useRef(legalOpen);
  useEffect(() => {
    if (legalOpen && !wasLegalOpen.current) legalRefInput.current?.focus();
    wasLegalOpen.current = legalOpen;
  }, [legalOpen]);

  const { errors } = validation;

  return (
    <Stack>
      <Grid gap="xl" align="flex-start">
        {/* Edit rail */}
        <Grid.Col span={{ base: 12, md: 7 }}>
          <Stack component="section" aria-label="Invitation settings" gap="lg">
            <Title order={2} size="h2" ref={headingRef} tabIndex={-1}>
              Customize your invitation
            </Title>
            <Text size="sm" c="dimmed">
              These settings are filled in from your file. Review and adjust
              them, then generate the invitation. Choose Reset to recommended to
              return to the defaults at any time.
            </Text>

            <TextInput
              value={draft.identity}
              onChange={(e) => updateDraft({ identity: e.target.value })}
              maxLength={MAX_INVITER_NAME_LENGTH}
              withAsterisk
              required
              label="Your name"
              description="Recorded in the invitation's linkage terms so your partner can identify you"
              placeholder="Your name"
              error={errors.identity}
              errorProps={{ role: "alert" }}
            />

            <Select
              label="Invitation lifetime"
              description="How long this invitation can be accepted before it expires"
              data={LIFETIME_OPTIONS}
              value={String(draft.lifetimeSeconds)}
              allowDeselect={false}
              onChange={(value) =>
                value !== null &&
                updateDraft({ lifetimeSeconds: Number(value) })
              }
              error={errors.lifetime}
              errorProps={{ role: "alert" }}
            />

            <Stack gap="xs">
              <Text size="sm" fw={600}>
                Records are matched on
              </Text>
              <Text size="xs" c="dimmed" id="key-order-help">
                Each enabled key is tried in order; earlier keys match first, so
                order the most precise keys first. Turn off a key to exclude it.
              </Text>
              {errors.keys && (
                <Text size="xs" c="red" role="alert">
                  {errors.keys}
                </Text>
              )}
              <Stack
                gap="xs"
                component="ul"
                aria-describedby="key-order-help"
                style={{ listStyle: "none", padding: 0, margin: 0 }}
              >
                {draft.keys.map((entry, index) => {
                  const satisfiable = keyIsSatisfiable(index);
                  return (
                    <Paper
                      key={entry.key.name}
                      withBorder
                      p="xs"
                      component="li"
                    >
                      <Group justify="space-between" wrap="nowrap">
                        <Checkbox
                          checked={entry.enabled}
                          onChange={(e) =>
                            toggleKey(index, e.currentTarget.checked)
                          }
                          label={
                            <Group gap="xs" wrap="nowrap">
                              <Text size="sm">{entry.key.name}</Text>
                              <Badge
                                size="xs"
                                variant="light"
                                color={satisfiable ? "green" : "red"}
                                role="img"
                                aria-label={
                                  satisfiable
                                    ? "Your columns can satisfy this key"
                                    : "Your columns cannot satisfy this key"
                                }
                              >
                                {satisfiable
                                  ? "satisfiable"
                                  : "not satisfiable"}
                              </Badge>
                            </Group>
                          }
                        />
                        <Group gap={4} wrap="nowrap">
                          <ActionIcon
                            variant="subtle"
                            disabled={index === 0}
                            onClick={() => moveKey(index, -1)}
                            aria-label={`Move ${entry.key.name} earlier`}
                          >
                            <IconArrowUp size={16} />
                          </ActionIcon>
                          <ActionIcon
                            variant="subtle"
                            disabled={index === draft.keys.length - 1}
                            onClick={() => moveKey(index, 1)}
                            aria-label={`Move ${entry.key.name} later`}
                          >
                            <IconArrowDown size={16} />
                          </ActionIcon>
                        </Group>
                      </Group>
                    </Paper>
                  );
                })}
              </Stack>
            </Stack>

            <Divider />

            <Stack gap="xs">
              <Checkbox
                checked={legalOpen}
                onChange={(e) => setLegalEnabled(e.currentTarget.checked)}
                label="Attach a legal agreement"
                description="Reference, purpose, and expiry your partner must enter identically"
              />
              {/* The `!== undefined` is load-bearing for type narrowing (it is
                  what lets the fields below read draft.legalAgreement.*), not a
                  duplicate of legalOpen. */}
              {draft.legalAgreement !== undefined && (
                <Stack gap="sm" pl="md">
                  <Alert
                    variant="light"
                    color="blue"
                    icon={<IconInfoCircle aria-hidden />}
                  >
                    Your partner must enter the reference, purpose, and
                    expiration date exactly as written here, or the exchange
                    will be refused.
                  </Alert>
                  <TextInput
                    ref={legalRefInput}
                    value={draft.legalAgreement.reference}
                    onChange={(e) => updateLegal({ reference: e.target.value })}
                    label="Agreement reference"
                    placeholder="MOU-2025-0042"
                    error={errors.legalReference}
                    errorProps={{ role: "alert" }}
                  />
                  <TextInput
                    value={draft.legalAgreement.purpose}
                    onChange={(e) => updateLegal({ purpose: e.target.value })}
                    label="Purpose of the disclosure"
                    placeholder="Program evaluation"
                    error={errors.legalPurpose}
                    errorProps={{ role: "alert" }}
                  />
                  <TextInput
                    type="date"
                    value={draft.legalAgreement.expirationDate}
                    onChange={(e) =>
                      updateLegal({ expirationDate: e.target.value })
                    }
                    label="Expiration date"
                    error={errors.legalExpiration}
                    errorProps={{ role: "alert" }}
                  />
                </Stack>
              )}
            </Stack>

            <Alert
              variant="light"
              color="gray"
              icon={<IconInfoCircle aria-hidden />}
              title="Fixed in this version"
            >
              Both you and your partner receive the matched result, matched
              identifiers are revealed (not just a count), each record matches
              at most one of your partner&apos;s, and no extra data columns are
              shared. These are not adjustable yet; the preview shows exactly
              what your partner will see.
            </Alert>
          </Stack>
        </Grid.Col>

        {/* Live preview */}
        <Grid.Col span={{ base: 12, md: 5 }}>
          <Stack
            component="section"
            aria-label="Live preview of your invitation"
            gap="sm"
          >
            <Paper withBorder p="md">
              <InvitationTerms
                linkageTerms={previewTerms}
                perspective="proposing"
                headingOrder={3}
              />
            </Paper>
          </Stack>
        </Grid.Col>
      </Grid>

      {/* Sticky validation footer */}
      <Box
        style={{
          position: "sticky",
          bottom: 0,
          background: "var(--mantine-color-body)",
          borderTop: "1px solid var(--mantine-color-default-border)",
          paddingTop: "var(--mantine-spacing-sm)",
          paddingBottom: "var(--mantine-spacing-sm)",
          zIndex: 1,
        }}
      >
        <Group justify="space-between">
          <Group gap="xs">
            {validation.canGenerate ? (
              <Text size="sm" c="dimmed">
                Ready to generate.
              </Text>
            ) : (
              <Text size="sm" c="red">
                <IconAlertCircle
                  size={16}
                  aria-hidden
                  style={{ verticalAlign: "text-bottom", marginRight: 4 }}
                />
                Resolve the highlighted items to continue.
              </Text>
            )}
          </Group>
          <Group gap="sm">
            <Button variant="default" onClick={handleReset}>
              Reset to recommended
            </Button>
            <Button
              onClick={handleGenerate}
              disabled={!validation.canGenerate || generating}
              loading={generating}
            >
              Generate invitation
            </Button>
          </Group>
        </Group>
      </Box>

      {/* Polite live region for validation/reorder announcements. */}
      <VisuallyHidden role="status" aria-live="polite">
        {announcement}
      </VisuallyHidden>
    </Stack>
  );
}
