import { useEffect, useId, useRef, useState } from "react";

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

import { resolveSigningFingerprint } from "@psi/jobClient/signingIdentityClient";

import {
  CERTIFICATE_EXPORT_NOTICE,
  IDENTITY_REGENERATION_NOTICE,
  RETENTION_NOTE_NOTICE,
  fingerprintRequestProblem,
  receiptsAdvisories,
  receiptsProblems,
  receiptsSummary,
  receiptsWithField,
} from "@psi/receiptsModel";
import styles from "@styles/app.module.css";

import { DisclosureSection } from "../components/DisclosureSection";

import type { ReceiptsDraft, ReceiptsSigningMode } from "@psi/receiptsModel";
import type { JobRendezvousConfig } from "@psi/jobClient/workInputClient";
import type { SigningFingerprintOutcome } from "@psi/jobClient/signingIdentityClient";

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
 * value. Each names the remedy, since every one of them is recoverable. The
 * `refused` message holds the whole CLI exit-64 class, unsplittable once stderr
 * is discarded (`runSigningFingerprint` in `jobs/signingIdentity.ts`); one member
 * is a malformed `psilink.yaml` a partner can write when the mount is also the
 * synced folder, so the copy sends the operator to read that file too. */
function fingerprintFailureMessage(
  outcome: Exclude<SigningFingerprintOutcome, { kind: "ok" }>,
): string {
  switch (outcome.kind) {
    case "refused":
      return (
        "Your signing identity could not be created or read in the folder you " +
        "mounted. Check that the folder is writable, that any signing identity " +
        "already in it is intact, and that any psilink.yaml there is valid " +
        "YAML. If that folder is also the one your partner syncs into, the " +
        "psilink.yaml may be theirs, so read it before changing your own " +
        "setup. A psilink.yaml your partner wrote cannot move where your " +
        "key is written or change whose name it binds, because both are " +
        "passed explicitly here. Fix what you find and try again -- running " +
        "'psilink fingerprint' against the same folder prints the reason."
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
 * whose certificate it trusts, and the retention note filed with this party's
 * own record. Offered as a closed disclosure since an unsigned record fits a
 * first run and a signed receipt is for a partnered deployment that must prove
 * the exchange happened.
 *
 * The critical behavior lives in {@link receiptsModel}, not here; this
 * component owns only the in-flight fingerprint request and its failure
 * message, since those belong to this visit to the card, not to the exchange.
 *
 * Creating the signing identity is an explicit action, not a side effect of the
 * run, since the operator must share their fingerprint before the exchange runs.
 * The button drives the CLI's own `fingerprint` command on the console, which is
 * create-or-reuse, so pressing it twice shows the same value.
 */
export function ReceiptsCard({
  draft,
  identity,
  rendezvous,
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
  /** The console's rendezvous report, or undefined before it resolves (or off a
   * console build). It decides whether the identity-location advisory applies to
   * this deployment: see {@link receiptsAdvisories}. */
  rendezvous: JobRendezvousConfig | undefined;
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
  // The draft as of this render, so a resolved fingerprint merges into whatever
  // the operator has by the time it lands, not the draft captured at the button
  // press: `onChange` replaces the whole draft, and the request spawns a real
  // process on the console, so an edit made while it runs would otherwise be
  // undone by the resolution. The handlers below read this closure instead,
  // which holds the same value without depending on when it ran.
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Bumped on every new request AND on every mode change, so a fingerprint that
  // resolves after the operator left certificate mode is discarded: leaving the
  // mode drops the resolved fingerprint (`receiptsWithField`) precisely so a
  // return re-asks the console, and a late resolution must not put one back.
  // The host-key probe's staleness guard has the same shape (`runProbe` in
  // `SftpAuthoringForm.tsx`).
  const seqRef = useRef(0);
  // Defence in depth for a non-secure origin, where the clipboard API is absent
  // and the value is still selectable by hand. The typings promise it is always
  // there, which is why this check exists by design rather than as redundancy.
  const clipboardAvailable =
    typeof navigator !== "undefined" && Boolean(navigator.clipboard);
  const problems = receiptsProblems(draft, identity);
  const advisories = receiptsAdvisories(draft, rendezvous);
  const warnings = advisories.filter(
    (advisory) => advisory.severity === "warning",
  );
  const notices = advisories.filter((advisory) => advisory.severity === "info");
  const requestProblem = fingerprintRequestProblem(identity);
  const set = <TField extends keyof ReceiptsDraft>(
    field: TField,
    value: ReceiptsDraft[TField],
  ): void => onChange(receiptsWithField(draft, field, value));

  // The request state is about one visit to certificate mode, so leaving the
  // mode ends it: a failure the operator left behind must not re-render as news
  // on their next visit, and a request still in flight is disowned here rather
  // than left to strand a button in a permanent loading state.
  useEffect(() => {
    seqRef.current += 1;
    setResolving(false);
    setFailure(undefined);
  }, [draft.mode]);

  async function resolveFingerprint(): Promise<void> {
    const seq = (seqRef.current += 1);
    setResolving(true);
    setFailure(undefined);
    const outcome = await resolveSigningFingerprint(
      identity.trim(),
      exportCertificate,
    );
    // Discard a superseded result: the mode changed, or a newer request started.
    if (seqRef.current !== seq) return;
    setResolving(false);
    if (outcome.kind !== "ok") {
      setFailure(fingerprintFailureMessage(outcome));
      return;
    }
    setIdentityFileName(outcome.identityFileName);
    setExportedName(outcome.certificateFileName);
    setJustCreated(outcome.created);
    onChange(
      receiptsWithField(
        draftRef.current,
        "ownFingerprint",
        outcome.fingerprint,
      ),
    );
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

        {warnings.length > 0 && (
          <Alert
            color="yellow"
            icon={<IconAlertTriangle aria-hidden />}
            title="Before you start this run"
          >
            <ul>
              {warnings.map((advisory) => (
                <li key={advisory.message}>{advisory.message}</li>
              ))}
            </ul>
          </Alert>
        )}

        {notices.length > 0 && (
          <Alert
            color="blue"
            icon={<IconInfoCircle aria-hidden />}
            title="Worth knowing about these settings"
          >
            <ul>
              {notices.map((advisory) => (
                <li key={advisory.message}>{advisory.message}</li>
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
