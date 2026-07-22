import { useMemo } from "react";

import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  Group,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { InvitationTerms } from "@components/InvitationTerms";
import { unlinkableFileAlert } from "@components/UnlinkableFileAlert";

import {
  DEFAULT_PREVIEW_IDENTITY,
  previewInferredTerms,
} from "./directExchangeModel";
import { FileProfileSummary } from "./ServerFilePicker";
import styles from "./bench.module.css";

import type { ProfiledJobInput } from "@psi/workInputClient";

/**
 * The direct-exchange confirm screen: the committed file's identity and shape, the
 * optional identity field, the browser-side preview of the terms the file is
 * EXPECTED to produce, the two fixed symmetry notices, and the trust-model
 * affirmation that gates Run.
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
  /** Whether the trust affirmation is checked -- the Run gate. */
  affirmed: boolean;
  onAffirm: (checked: boolean) => void;
  onRun: () => void;
  onBack: () => void;
  /** Whether a run has already started (disables Run so a second press cannot
   * race the first). */
  running: boolean;
}) {
  // The preview depends only on the columns, not the identity: the inferred keys,
  // fields, and disclosed set are column-derived, and the identity is not shown in
  // the "proposing" framing (it only attributes the disclosure record and rides the
  // run). Memoized on the profile (stable per committed file) so a keystroke in the
  // identity field does not rebuild the terms panel and reset its collapsed sections.
  const preview = useMemo(
    () => previewInferredTerms(profile.columns, DEFAULT_PREVIEW_IDENTITY),
    [profile],
  );

  const linkable = preview.satisfiableKeyCount > 0;
  const unlinkable = unlinkableFileAlert(preview.unsatisfied);

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
        description="Names you in the disclosure record and rides the exchange. Leave blank to run as this appliance's user."
        value={identity}
        onChange={(event) => onIdentity(event.currentTarget.value)}
      />

      <section aria-label="Inferred terms">
        {linkable ? (
          <InvitationTerms
            linkageTerms={preview.linkageTerms}
            perspective="proposing"
            headingOrder={2}
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
            Set up a recurring exchange with an invitation
          </Anchor>{" "}
          instead.
        </Text>
      </div>

      <Group>
        <Button onClick={onRun} disabled={!affirmed || !linkable || running}>
          Run the exchange
        </Button>
        <Button variant="default" onClick={onBack}>
          Back
        </Button>
      </Group>
    </Stack>
  );
}
