import { useId, useState } from "react";

import {
  Alert,
  Button,
  Checkbox,
  CopyButton,
  Group,
  NativeSelect,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { IconAlertTriangle, IconInfoCircle } from "@tabler/icons-react";

import { resolveSigningFingerprint } from "@psi/signingIdentityClient";

import { DisclosureSection } from "../components/DisclosureSection";

import {
  CERTIFICATE_EXPORT_NOTICE,
  IDENTITY_REGENERATION_NOTICE,
  RETENTION_NOTE_NOTICE,
  fingerprintRequestProblem,
  receiptsAdvisories,
  receiptsProblems,
  receiptsSummary,
  receiptsWithField,
} from "./receiptsModel";
import styles from "./bench.module.css";

import type { ReceiptsDraft, ReceiptsSigningMode } from "./receiptsModel";
import type { SigningFingerprintOutcome } from "@psi/signingIdentityClient";

/** The three modes the configuration format has, in the order the reference lists
 * them. The middle one is offered disabled: core refuses it before an exchange
 * runs, so showing it names the choice without letting the operator author a run
 * that would be refused. */
const MODE_CHOICES: ReadonlyArray<{
  value: ReceiptsSigningMode;
  label: string;
  disabled?: boolean;
}> = [
  { value: "none", label: "No receipt -- the ordinary unsigned record only" },
  {
    value: "session-derived",
    label: "Session-derived check (not built yet)",
    disabled: true,
  },
  {
    value: "certificate",
    label: "Signed receipt both parties and an auditor can check",
  },
];

/** What the operator is told about a fingerprint attempt that did not produce a
 * value. Each names the remedy, since every one of them is recoverable. */
function fingerprintFailureMessage(
  outcome: Exclude<SigningFingerprintOutcome, { kind: "ok" }>,
): string {
  switch (outcome.kind) {
    case "refused":
      return (
        "Your signing identity could not be created or read in the folder you " +
        "mounted. Check that the folder is writable and that any signing " +
        "identity already in it is intact, then try again -- running 'psilink " +
        "fingerprint' against the same folder prints the reason."
      );
    case "invalid":
      return outcome.message;
    case "busy":
      return "Another fingerprint request is still running. Try again in a moment.";
    case "timeout":
      return "Creating the signing identity took too long and was stopped. Try again.";
    case "disabled":
      return "This build does not run exchanges here, so it has no signing identity to create.";
    case "error":
      return "The signing identity could not be created or read. Try again.";
  }
}

/**
 * The console's "Receipts and record keeping" card: whether this exchange
 * produces a third-party-verifiable signed receipt beside its ordinary record,
 * whose certificate it trusts, and the retention note filed with this party's own
 * record. Offered as a closed disclosure beside the other run cards, since an
 * unsigned record is right for a first run and a signed receipt is what an
 * operator reaches for deliberately, for a partnered deployment that must be able
 * to prove the exchange happened.
 *
 * The load-bearing behaviour lives in {@link receiptsModel}, not here: what a
 * draft emits, what the run itself would refuse, and the advisories. This
 * component owns one piece of state of its own -- the in-flight fingerprint
 * request and its failure message -- because it is about this visit to the card
 * rather than about the exchange.
 *
 * Creating the signing identity is an EXPLICIT action here, not a side effect of
 * the run: the operator must be able to share their fingerprint before the
 * exchange, because the partner pins it out-of-band first. The button drives the
 * CLI's own `fingerprint` command on the appliance, which is create-or-reuse, so
 * pressing it twice shows the same value rather than minting a second key.
 */
export function ReceiptsCard({
  draft,
  identity,
  open,
  onToggleOpen,
  onChange,
}: {
  draft: ReceiptsDraft;
  /** This exchange's `linkage_terms.identity` -- the name, organization, and
   * contact a NEW signing identity is bound to, and the value a partner checks
   * the certificate against. Blank until the operator states it, which the
   * fingerprint request then reports rather than binding an empty identity. */
  identity: string;
  open: boolean;
  onToggleOpen: (open: boolean) => void;
  onChange: (draft: ReceiptsDraft) => void;
}) {
  const requestProblemId = useId();
  const [resolving, setResolving] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [exportCertificate, setExportCertificate] = useState(false);
  const [exportedName, setExportedName] = useState<string>();
  const [identityFileName, setIdentityFileName] = useState<string>();
  const [justCreated, setJustCreated] = useState(false);
  // Defence in depth for a non-secure origin, where the clipboard API is absent
  // and the value is still selectable by hand. The typings promise it is always
  // there, which is why the check is deliberate rather than redundant.
  const clipboardAvailable =
    typeof navigator !== "undefined" && Boolean(navigator.clipboard);
  const problems = receiptsProblems(draft);
  const advisories = receiptsAdvisories(draft);
  const requestProblem = fingerprintRequestProblem(identity);
  const set = <TField extends keyof ReceiptsDraft>(
    field: TField,
    value: ReceiptsDraft[TField],
  ): void => onChange(receiptsWithField(draft, field, value));

  async function resolveFingerprint(): Promise<void> {
    setResolving(true);
    setFailure(undefined);
    const outcome = await resolveSigningFingerprint(
      identity.trim(),
      exportCertificate,
    );
    setResolving(false);
    if (outcome.kind !== "ok") {
      setFailure(fingerprintFailureMessage(outcome));
      return;
    }
    setIdentityFileName(outcome.identityFileName);
    setExportedName(outcome.certificateFileName);
    setJustCreated(outcome.created);
    set("ownFingerprint", outcome.fingerprint);
  }

  return (
    <DisclosureSection
      label="Receipts and record keeping"
      summary={receiptsSummary(draft)}
      open={open}
      onToggle={onToggleOpen}
      headingOrder={2}
    >
      <Stack gap="md" mt="sm">
        <Text size="sm" c="dimmed">
          Every exchange writes an unsigned record of what it did, for your own
          files. A signed receipt is the stronger artifact: both parties sign
          the same terms and data-flow facts, so a third party can later check
          that this exchange happened on these terms without either of you
          vouching for it. Set it up when your partnership needs that proof.
        </Text>

        <NativeSelect
          label="What this exchange produces"
          description="A signed receipt needs a one-time setup on both sides: each party creates a signing identity and pins the other's fingerprint."
          value={draft.mode}
          data={MODE_CHOICES.map((choice) => ({
            value: choice.value,
            label: choice.label,
            ...(choice.disabled === true ? { disabled: true } : {}),
          }))}
          onChange={(event) =>
            set("mode", event.currentTarget.value as ReceiptsSigningMode)
          }
        />

        {draft.mode === "certificate" && (
          <>
            <Stack gap="xs">
              <Text size="sm" fw={600}>
                Your fingerprint, to share with your partner
              </Text>
              <Text size="xs" c="dimmed">
                This creates your signing identity if you do not have one yet,
                and shows the same fingerprint every time after that.
              </Text>
              <Checkbox
                checked={exportCertificate}
                onChange={(event) =>
                  setExportCertificate(event.currentTarget.checked)
                }
                label="Also write out my public certificate"
                description={CERTIFICATE_EXPORT_NOTICE}
              />
              <div>
                <Button
                  size="xs"
                  loading={resolving}
                  disabled={requestProblem !== undefined}
                  aria-describedby={
                    requestProblem === undefined ? undefined : requestProblemId
                  }
                  onClick={() => void resolveFingerprint()}
                >
                  {draft.ownFingerprint === undefined
                    ? "Create or show my fingerprint"
                    : "Show it again"}
                </Button>
              </div>
              {requestProblem !== undefined && (
                <Text id={requestProblemId} size="xs" c="dimmed">
                  {requestProblem}
                </Text>
              )}
              {draft.ownFingerprint !== undefined && (
                <>
                  <Group gap="xs" wrap="nowrap" align="center">
                    <Text
                      size="sm"
                      className={styles.mono}
                      aria-label="Your certificate fingerprint"
                    >
                      {draft.ownFingerprint}
                    </Text>
                    {clipboardAvailable ? (
                      <CopyButton value={draft.ownFingerprint} timeout={1500}>
                        {({ copied, copy }) => (
                          <Button
                            variant="default"
                            size="compact-xs"
                            onClick={copy}
                            aria-label={
                              copied
                                ? "Your fingerprint copied"
                                : "Copy your fingerprint"
                            }
                          >
                            {copied ? "Copied" : "Copy"}
                          </Button>
                        )}
                      </CopyButton>
                    ) : null}
                  </Group>
                  <Text size="xs" c="dimmed" role="status">
                    {justCreated
                      ? "Your signing identity was created"
                      : "Your signing identity was already set up"}
                    {identityFileName !== undefined
                      ? ` (${identityFileName} in your mounted folder)`
                      : ""}
                    . Send this fingerprint over a channel you trust -- not the
                    same message as the invitation.
                    {exportedName !== undefined
                      ? ` Your public certificate is in ${exportedName}.`
                      : ""}
                  </Text>
                </>
              )}
              {failure !== undefined && (
                <Text role="alert" c="red" size="sm">
                  {failure}
                </Text>
              )}
            </Stack>

            <TextInput
              label="Your partner's fingerprint"
              description="Paste the 43-character value your partner sends you. Their certificate is trusted only if it matches."
              placeholder="43 characters"
              value={draft.partnerFingerprint}
              onChange={(event) =>
                set("partnerFingerprint", event.currentTarget.value)
              }
            />

            <Alert
              color="gray"
              icon={<IconInfoCircle aria-hidden />}
              title="About your signing identity"
            >
              {IDENTITY_REGENERATION_NOTICE}
            </Alert>
          </>
        )}

        <Textarea
          label="Retention note for your own record"
          description={RETENTION_NOTE_NOTICE}
          placeholder="Filed in the association database; kept six years under the records schedule, then purged."
          autosize
          minRows={2}
          maxRows={5}
          value={draft.retentionDisposition}
          onChange={(event) =>
            set("retentionDisposition", event.currentTarget.value)
          }
        />

        {advisories.length > 0 && (
          <Alert
            color="blue"
            icon={<IconInfoCircle aria-hidden />}
            title="Worth knowing about these settings"
          >
            <ul>
              {advisories.map((advisory) => (
                <li key={advisory}>{advisory}</li>
              ))}
            </ul>
          </Alert>
        )}

        {problems.length > 0 && (
          <Alert
            color="red"
            icon={<IconAlertTriangle aria-hidden />}
            title="These settings cannot be used"
          >
            <ul>
              {problems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Alert>
        )}
      </Stack>
    </DisclosureSection>
  );
}
