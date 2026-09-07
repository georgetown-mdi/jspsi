import { useMemo } from "react";

import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  Radio,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { LinkageStrategySchema } from "@psilink/core";

import { InvitationTerms } from "@components/InvitationTerms";
import { unlinkableFileAlert } from "@components/UnlinkableFileAlert";
import { useOnlineStatus } from "@components/useOnlineStatus";

import {
  IDENTITY_CONTROL_CHAR_PATTERN,
  MAX_IDENTITY_LENGTH,
} from "@jobs/intentSchemas";
import {
  LINKAGE_STRATEGY_LABEL,
  LINKAGE_STRATEGY_OPTION_COPY,
  SINGLE_PASS_DISCLOSURE_BODY,
  SINGLE_PASS_DISCLOSURE_TITLE,
} from "@psi/linkageStrategyChoice";
import { overlongColumnsAlert, sanitizedColumnsAlert } from "@psi/columnNames";

import { OFFLINE_EXCHANGE_REASON } from "@psi/offlineExchangeGate";

import { FileProfileSummary } from "@console/ServerFilePicker";
import styles from "@styles/app.module.css";

import {
  DEFAULT_PREVIEW_IDENTITY,
  DIRECT_LINKAGE_STRATEGY_AGREEMENT_NOTICE,
  previewInferredTerms,
} from "./directExchangeModel";

import type { LinkageStrategy } from "@psilink/core";
import type { ProfiledJobInput } from "@psi/jobClient/workInputClient";

/**
 * The direct-exchange confirm screen: the committed file's identity and shape, the
 * optional identity field, the linkage-strategy choice, the browser-side preview
 * of the terms the file is EXPECTED to produce, the two fixed symmetry notices,
 * and the trust-model affirmation that gates Run.
 *
 * The strategy is authored here rather than on the server step because it is a
 * term rather than a connection setting: it reshapes the very terms previewed
 * below it, and selecting single-pass includes the disclosure note the invitation
 * flow's own authoring control presents.
 *
 * The terms preview is read-only. It is computed from the file's columns exactly as
 * the CLI's zero-setup command infers them ({@link previewInferredTerms}) and shown
 * through {@link InvitationTerms} under the self-terms "proposing" framing -- not a
 * consent capture. The CLI re-infers over the real file at run time, so a file
 * edited between preview and run desyncs from what runs, caught by the runtime
 * two-party terms check; the copy states this rather than asserting the preview as
 * authoritative.
 *
 * The affirmation mirrors the CLI's transport-only-trust warning in a non-alarm
 * tone and gates Run behind a single unchecked-by-default checkbox. The host-key
 * fingerprint confirmation stays in the server-authoring step, where the real
 * defense lives; this affirmation is the trust acknowledgement, not a second pin.
 */
export function DirectConfirmSection({
  profile,
  identity,
  onIdentity,
  linkageStrategy,
  onLinkageStrategy,
  affirmed,
  onAffirm,
  onRun,
  onBack,
  running,
}: {
  profile: ProfiledJobInput;
  /** The optional operator identity, threaded to the run's `--identity`. */
  identity: string;
  onIdentity: (value: string) => void;
  /** The strategy the keys run under, threaded to the run's
   * `--linkage-strategy` and applied over the previewed terms. */
  linkageStrategy: LinkageStrategy;
  onLinkageStrategy: (strategy: LinkageStrategy) => void;
  /** Whether the trust affirmation is checked -- the Run gate. */
  affirmed: boolean;
  onAffirm: (checked: boolean) => void;
  onRun: () => void;
  onBack: () => void;
  /** Whether a run has already started (disables Run so a second press cannot
   * race the first). */
  running: boolean;
}) {
  // The preview depends on the columns and the chosen strategy, not the identity:
  // the inferred keys, fields, and disclosed set are column-derived, and the
  // identity is not shown in the "proposing" framing (it only attributes the
  // disclosure record and rides the run). Memoized on the profile (stable per
  // committed file) so a keystroke in the identity field does not rebuild the terms
  // panel and reset its collapsed sections.
  const preview = useMemo(
    () =>
      previewInferredTerms(
        profile.columns,
        DEFAULT_PREVIEW_IDENTITY,
        linkageStrategy,
      ),
    [profile, linkageStrategy],
  );

  // A direct run is a live two-party session against the agreed server, dialled
  // by the console sharing this machine, so a device reporting no network
  // cannot conduct it. Naming that here beats pressing Run into an opaque
  // connection failure. Only the offline direction is gated -- being online is no
  // promise the partner is there (see @utils/networkStatus).
  const online = useOnlineStatus();

  const unlinkable =
    preview.refusal === undefined
      ? undefined
      : unlinkableFileAlert(preview.refusal);

  // A column this file sends whose name is too long to transmit. The console would
  // refuse the run at data preparation, so it is refused here where the operator can
  // still act on it, in the same words the invitation seats use. This spine has no
  // disclosure control -- every non-linkage column is sent -- so the remedy it
  // offers is a shorter header; the copy below already points at the invitation
  // flow for choosing which columns are shared.
  const overlongAlert =
    preview.overlongDisclosedColumns.length > 0
      ? overlongColumnsAlert(preview.overlongDisclosedColumns)
      : undefined;

  // What the parse removed from this file's header, stated on the screen the
  // operator confirms the run from: the names below are the stripped ones, and
  // this spine has no earlier surface that outlives the file step.
  const sanitizedNotice =
    profile.bidiStrippedColumns.length > 0
      ? sanitizedColumnsAlert(profile.bidiStrippedColumns)
      : undefined;

  // Client-side guard mirroring the intent schema's identity contract, validated
  // on the value the run actually sends (the trimmed label; a blank field omits
  // identity and the run names no party, so it is not an error). Naming the fault
  // at the field keeps a label the schema refuses -- a leading dash, an over-long
  // value, or a control character -- from reaching the server as an opaque 400
  // that failureFor would misattribute to the file or SFTP destination -- the
  // shared contract's own rules, which this guard cannot loosen.
  const trimmedIdentity = identity.trim();
  const identityError =
    trimmedIdentity.length === 0
      ? undefined
      : trimmedIdentity.startsWith("-")
        ? "Identity cannot begin with a dash"
        : trimmedIdentity.length > MAX_IDENTITY_LENGTH
          ? `Identity cannot exceed ${MAX_IDENTITY_LENGTH} characters`
          : IDENTITY_CONTROL_CHAR_PATTERN.test(trimmedIdentity)
            ? "Identity cannot contain control characters (a line break or a tab, for instance)"
            : undefined;

  return (
    <Stack gap="lg">
      <div>
        <h1 tabIndex={-1}>Confirm and run</h1>
        <Text size="sm" c="dimmed">
          psilink read your file and inferred the terms below -- what your file
          is expected to contribute. The exchange re-reads the file when it
          runs, so if you edit it after this preview the run uses the edited
          file (a mismatch stops the exchange before any records are compared).
        </Text>
      </div>

      <section aria-label="Your file">
        <h2>Your file</h2>
        <FileProfileSummary profile={profile} />
      </section>

      <TextInput
        label="Your identity (optional)"
        description="The name your partner sees, and what names you in the disclosure record. Omitted if blank -- your partner and the record then show that no name was given."
        value={identity}
        onChange={(event) => onIdentity(event.currentTarget.value)}
        error={identityError}
      />

      <Stack gap="sm">
        <Radio.Group
          label={LINKAGE_STRATEGY_LABEL}
          description={DIRECT_LINKAGE_STRATEGY_AGREEMENT_NOTICE}
          value={linkageStrategy}
          // Parsed rather than trusted so a Radio value literal drifting from the
          // enum throws loudly instead of typechecking clean.
          onChange={(value) =>
            onLinkageStrategy(LinkageStrategySchema.parse(value))
          }
        >
          <Radio
            value="cascade"
            label={LINKAGE_STRATEGY_OPTION_COPY.cascade.label}
            description={LINKAGE_STRATEGY_OPTION_COPY.cascade.description}
            mt="xs"
          />
          <Radio
            value="single-pass"
            label={LINKAGE_STRATEGY_OPTION_COPY["single-pass"].label}
            description={
              LINKAGE_STRATEGY_OPTION_COPY["single-pass"].description
            }
            mt="xs"
          />
        </Radio.Group>
        {linkageStrategy === "single-pass" && (
          <Alert
            color="yellow"
            title={SINGLE_PASS_DISCLOSURE_TITLE}
            // Pinned so the consent-critical warning is announced on selection
            // even if Mantine's default role changes.
            role="alert"
          >
            {SINGLE_PASS_DISCLOSURE_BODY}
          </Alert>
        )}
      </Stack>

      {overlongAlert !== undefined && (
        <Alert
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title={overlongAlert.title}
        >
          {overlongAlert.message}
        </Alert>
      )}

      {sanitizedNotice !== undefined && (
        <Alert
          color="yellow"
          icon={<IconAlertCircle aria-hidden />}
          title={sanitizedNotice.title}
        >
          {sanitizedNotice.message}
        </Alert>
      )}

      <section aria-label="Inferred terms">
        {unlinkable === undefined ? (
          <InvitationTerms
            linkageTerms={preview.linkageTerms}
            perspective="proposing"
            headingOrder={2}
            framing={{
              heading: "Terms your file produces",
              intro:
                "These are the terms psilink inferred from your own file. " +
                "There is no invitation for your partner to review or consent to.",
            }}
          />
        ) : (
          <Alert
            color="red"
            icon={<IconAlertCircle aria-hidden />}
            title={unlinkable.title}
          >
            {unlinkable.message}
          </Alert>
        )}
      </section>

      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          Terms are read from your file automatically. To choose which columns
          match or are shared, use the{" "}
          <Anchor component={Link} to="/exchange" inherit>
            invitation flow
          </Anchor>{" "}
          instead.
        </Text>
        <Text size="sm" c="dimmed">
          Your partner runs the same step against their own file. Neither file
          is sent to the other. If the two files produce different terms, the
          exchange stops before any records are compared.
        </Text>
      </Stack>

      <div className={styles.callout}>
        <Text size="sm">
          This run writes a disclosure record of exactly what your file
          contributed, which you download and keep.
        </Text>
        <Checkbox
          mt="sm"
          checked={affirmed}
          onChange={(event) => onAffirm(event.currentTarget.checked)}
          label={
            "I trust the server my partner and I agreed on, and I trust my " +
            "partner. This exchange is protected only by the connection to that " +
            "server -- it uses no shared secret and no separate encryption, so " +
            "the server's administrator is trusted with the traffic."
          }
        />
        <Text size="sm" c="dimmed" mt="sm">
          Want protection that does not depend on the server?{" "}
          <Anchor component={Link} to="/exchange" inherit>
            Set up an exchange with an invitation
          </Anchor>{" "}
          instead.
        </Text>
      </div>

      <Stack gap="sm">
        <Group>
          <Button
            onClick={onRun}
            disabled={
              !affirmed ||
              unlinkable !== undefined ||
              overlongAlert !== undefined ||
              running ||
              identityError !== undefined ||
              !online
            }
          >
            Run the exchange
          </Button>
          <Button variant="default" onClick={onBack}>
            Back
          </Button>
        </Group>
        {!online && (
          <Text size="sm" c="dimmed">
            {OFFLINE_EXCHANGE_REASON}
          </Text>
        )}
      </Stack>
    </Stack>
  );
}
