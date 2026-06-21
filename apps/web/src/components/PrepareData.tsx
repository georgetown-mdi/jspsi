import { useEffect, useMemo, useRef, useState } from "react";

import {
  Alert,
  Button,
  Group,
  List,
  Modal,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconArrowLeft,
  IconCircleCheck,
} from "@tabler/icons-react";
import { useDisclosure } from "@mantine/hooks";

import {
  assessLinkageSatisfiability,
  getDefaultStandardization,
  inferMetadata,
} from "@psilink/core";

import {
  SEMANTIC_TYPE_LABELS,
  disclosedColumnNames,
  normalizeForEditor,
  setColumnType,
} from "@psi/metadataEditing";

import { InvitationTerms } from "@components/InvitationTerms";
import { MetadataGrid } from "@components/MetadataGrid";

import type { LinkageField, LinkageTerms, Metadata } from "@psilink/core";

import type { AcceptorDataEdits } from "@psi/acceptInvitation";
import type { AlertContent } from "@components/FileAcquire";

/**
 * The acceptor "Prepare your data" editor: the surface that turns the old
 * dead-end pre-flight ("this file cannot be linked") into an entry point. It seeds
 * the operator's per-party metadata from {@link inferMetadata} (normalized so the
 * collapsed disclosure control is faithful -- see {@link normalizeForEditor}),
 * shows a live linkage-satisfiability verdict over the EDITED metadata and
 * standardization, and lets the operator remap columns until the file complies.
 *
 * The verdict and the run consume the SAME `{ metadata, standardization }`: the
 * standardization is derived from the current metadata via
 * {@link getDefaultStandardization} (so the recommended per-type cleaning is
 * always applied to the current column bindings, matching the acceptor's prior
 * inferred behavior), and that exact pair is handed to {@link onLaunch}. So the
 * gate the operator sees and the exchange that runs cannot disagree.
 *
 * Metadata/standardization are LOCAL and per-party: they are never embedded in the
 * token or cross-checked, so editing them changes only this party's match rate and
 * disclosure, never the agreement the consent screen already accepted. The
 * `satisfiableKeyCount === 0` hard block remains -- "Continue" is disabled so a
 * silent-empty exchange is never run -- but the operator fixes the file in place
 * rather than being bounced back to the picker.
 */
export function PrepareData({
  linkageTerms,
  columns,
  onLaunch,
  onBack,
}: {
  /** The adopted (agreed) linkage terms the operator is matching against, shown
   * read-only via {@link InvitationTerms}. */
  linkageTerms: LinkageTerms;
  /** The acceptor's own CSV column names, from the parsed file. */
  columns: Array<string>;
  /** Commit the prepared data and move to the exchange: the edited metadata and
   * standardization, plus an optional partial-coverage advisory to surface through
   * the run. */
  onLaunch: (edits: AcceptorDataEdits, warning?: AlertContent) => void;
  /** Return to the review screen to pick a different file. Consent is preserved
   * (it lives on the container), and this editor unmounts on the way back, so
   * re-acquiring a different file remounts it and reseeds the metadata. */
  onBack: () => void;
}) {
  // Focus the heading on mount so a keyboard/screen-reader user who pressed
  // "Accept and continue" lands on this editor rather than the unmounted button.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  // Seeded once from the file's columns; the operator owns the state from here (no
  // silent re-inference), and Reset returns to exactly this.
  const initialMetadata = useMemo(
    () => normalizeForEditor(inferMetadata(columns)),
    [columns],
  );
  const [metadata, setMetadata] = useState<Metadata>(initialMetadata);

  // Standardization is derived from the current metadata: the recommended per-type
  // cleaning for whatever columns each field is currently bound to. Deriving it
  // (rather than holding stale steps) keeps the verdict honest after a remap and
  // preserves the acceptor's prior behavior, where cleaning was inferred from the
  // adopted terms. The same object feeds the verdict and onLaunch.
  const standardization = useMemo(
    () => getDefaultStandardization(metadata, linkageTerms),
    [metadata, linkageTerms],
  );

  const verdict = useMemo(
    () =>
      assessLinkageSatisfiability(
        columns,
        linkageTerms,
        standardization,
        metadata,
      ),
    [columns, linkageTerms, standardization, metadata],
  );

  const totalKeys = linkageTerms.linkageKeys.length;
  const satisfiable = verdict.satisfiableKeyCount;
  const blocked = satisfiable === 0;
  const partial = satisfiable > 0 && satisfiable < totalKeys;
  const disclosed = disclosedColumnNames(metadata);

  // The field types the file cannot currently produce, de-duplicated by type for
  // the fix UI (several fields can share a type). `LinkageField["type"]` is a
  // closed semantic-type enum, so its label is safe; the partner-controlled field
  // NAME is never shown here.
  const unsatisfiedTypes = useMemo(() => {
    const seen = new Map<LinkageField["type"], string>();
    for (const field of verdict.unsatisfied)
      seen.set(field.type, SEMANTIC_TYPE_LABELS[field.type]);
    return [...seen.entries()].map(([type, label]) => ({ type, label }));
  }, [verdict.unsatisfied]);

  const [confirmOpen, { open: openConfirm, close: closeConfirm }] =
    useDisclosure(false);

  // Remap: bind a field type to a chosen column by setting that column's semantic
  // type. The derived standardization regenerates the recommended cleaning for the
  // new binding, so a remap both makes the field satisfiable and cleans it.
  const remap = (type: LinkageField["type"], columnName: string) =>
    setMetadata((prev) => setColumnType(prev, columnName, type));

  const launch = () => {
    closeConfirm();
    const warning: AlertContent | undefined = partial
      ? {
          title: "Partial coverage",
          message:
            `Only ${satisfiable} of ${totalKeys} linkage keys can match with ` +
            "this file. Keys that need the missing fields will be inactive; the " +
            "others will proceed normally.",
        }
      : undefined;
    onLaunch({ metadata, standardization }, warning);
  };

  return (
    <Stack>
      <Group>
        <Button
          variant="subtle"
          onClick={onBack}
          leftSection={<IconArrowLeft size={16} aria-hidden />}
        >
          Choose a different file
        </Button>
      </Group>
      <Title order={2} ref={headingRef} tabIndex={-1}>
        Prepare your data
      </Title>
      <Text size="sm" c="dimmed">
        Tell us what each column in your file is and what should be done with
        it, then check that your data can match the agreed terms. Nothing here
        is sent to your partner except the columns you mark as shared; these
        settings stay on your device.
      </Text>

      <Paper withBorder p="md">
        <Text size="sm" fw={600} mb="xs">
          The terms you are matching against
        </Text>
        <InvitationTerms
          linkageTerms={linkageTerms}
          perspective="accepted"
          headingOrder={3}
        />
      </Paper>

      {blocked ? (
        <Alert
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title="This file cannot match yet"
        >
          None of the agreed linkage keys can be satisfied by your columns, so
          no matches are possible. Set the columns below to the missing field
          types, then this will clear.
        </Alert>
      ) : partial ? (
        <Alert
          color="yellow"
          icon={<IconAlertTriangle aria-hidden />}
          title={`${satisfiable} of ${totalKeys} keys can match`}
          role="status"
        >
          Some linkage keys cannot be satisfied by your columns and will be
          inactive for this exchange. The other keys will proceed normally. You
          can map more columns below to enable additional keys.
        </Alert>
      ) : (
        <Alert
          color="green"
          icon={<IconCircleCheck aria-hidden />}
          title={`All ${totalKeys} keys can match`}
          role="status"
        >
          Your columns can satisfy every agreed linkage key.
        </Alert>
      )}

      {unsatisfiedTypes.length > 0 && (
        <Paper withBorder p="md">
          <Text size="sm" fw={600} mb="xs">
            Map a column to each missing field
          </Text>
          <Stack gap="sm">
            {unsatisfiedTypes.map(({ type, label }) => (
              <Select
                key={type}
                label={label}
                description={`No column is set to ${label.toLowerCase()} yet`}
                placeholder="Choose a column"
                data={columns}
                value={null}
                onChange={(columnName) =>
                  columnName !== null && remap(type, columnName)
                }
              />
            ))}
          </Stack>
        </Paper>
      )}

      <MetadataGrid
        metadata={metadata}
        onChange={setMetadata}
        caption="Your columns, their types, and how each is used"
      />

      <Group justify="space-between">
        <Button variant="default" onClick={() => setMetadata(initialMetadata)}>
          Reset to recommended
        </Button>
        <Button onClick={openConfirm} disabled={blocked}>
          Continue to exchange
        </Button>
      </Group>

      <Modal
        opened={confirmOpen}
        onClose={closeConfirm}
        title="Confirm what you will send"
        centered
      >
        <Stack>
          {disclosed.length === 0 ? (
            <Text size="sm">
              You will <strong>not</strong> send any columns to your partner.
              Only the linkage result (which of your rows matched) is produced.
            </Text>
          ) : (
            <>
              <Text size="sm">
                For each matched row, you will send these columns to your
                partner:
              </Text>
              <List size="sm">
                {disclosed.map((name) => (
                  <List.Item key={name}>{name}</List.Item>
                ))}
              </List>
            </>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={closeConfirm}>
              Go back
            </Button>
            <Button onClick={launch}>Confirm and continue</Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  );
}
