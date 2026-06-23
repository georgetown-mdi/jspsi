import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Center,
  Loader,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import {
  assessLinkageSatisfiability,
  getDefaultLinkageTerms,
  loadCSVFile,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
} from "@psilink/core";

import { InvitationFileError, generateInvitation } from "@psi/invitation";
import { emptyColumnPositions, unnameableColumnsAlert } from "@psi/columnNames";
import { invitationLocation } from "@psi/invitationLocation";
import { seedAdvancedInvite } from "@psi/advancedInvite";

import {
  clearAdvancedHandoff,
  peekAdvancedHandoff,
} from "@components/advancedHandoff";
import { EXCHANGE_READING_WIDTH } from "@components/contentWidth";
import { ExchangeView } from "@components/ExchangeView";
import FileSelect from "@components/FileSelect";
import { LinkageTermsEditor } from "@components/LinkageTermsEditor";

import type { LinkageTerms, Metadata, Standardization } from "@psilink/core";

import type { AdvancedInviteSeed } from "@psi/advancedInvite";
import type { AlertContent } from "@components/FileAcquire";
import type { GeneratedInvitation } from "@psi/invitation";

/**
 * The Advanced-options invite flow's container (the `/advanced` route's
 * component). It acquires the inviter's CSV -- either handed over from the compose
 * screen's "Advanced options" click or chosen here on a cold load -- parses it in
 * full (see {@link loadCSVFile}), seeds the {@link LinkageTermsEditor} from its
 * columns, and on Generate mints the invitation from
 * the authored terms and transitions in place to the shared {@link ExchangeView},
 * mirroring the quick compose screen's session -> exchange handoff.
 *
 * The CSV is parsed in full on entry to the editor (not just its headers): the
 * data-prep workbench's before/after preview runs the authored cleaning over a
 * sample of the parsed rows, so the edit session holds them. Generate re-parses the
 * same in-memory file through `generateInvitation` (its parse boundary stays the
 * authority for the unreadable/unlinkable gates). A cold load (deep link or reload)
 * cannot recover a previously chosen file -- the browser does not allow it -- so it
 * falls back to the file picker here.
 */
type Phase =
  | { status: "acquire" }
  | { status: "loading" }
  | {
      status: "editing";
      seed: AdvancedInviteSeed;
      identity: string;
      file: File;
      /** The parsed rows, for the workbench's before/after preview. */
      rawRows: Array<Record<string, string>>;
    }
  | {
      status: "exchange";
      invitation: GeneratedInvitation;
      inviterName: string;
    };

export function AdvancedInvite() {
  // Read the compose-screen hand-off once (pure peek, StrictMode-safe). When
  // present, start straight on the header read rather than flashing the picker.
  const [handoff] = useState(peekAdvancedHandoff);
  const [phase, setPhase] = useState<Phase>(
    handoff ? { status: "loading" } : { status: "acquire" },
  );
  const [error, setError] = useState<AlertContent>();
  const [generating, setGenerating] = useState(false);
  const [files, setFiles] = useState<Array<File>>([]);

  // Guards setState against a teardown mid-read/mid-generate (both are short async
  // hops with no abort signal of their own).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Read the file's headers, run the same zero-satisfiable-keys pre-flight the
  // quick path applies, and enter the editor seeded from the columns. Blocks an
  // unlinkable or unreadable file before the editor, mirroring InvitePanel.
  const enterEditor = async (file: File, name: string) => {
    setError(undefined);
    setPhase({ status: "loading" });
    let columns: Array<string>;
    let rawRows: Array<Record<string, string>>;
    try {
      const csv = await loadCSVFile(file);
      rawRows = csv.data as Array<Record<string, string>>;
      columns = csv.meta.fields ?? [];
    } catch (cause) {
      if (!mountedRef.current) return;
      clearAdvancedHandoff();
      setError({
        title: "Could not read your file",
        message: sanitizeErrorForDisplay(cause),
      });
      setPhase({ status: "acquire" });
      return;
    }
    if (!mountedRef.current) return;

    // The warm hand-off (if any) is now consumed: from here the file lives in the
    // editing phase, not the module stash. Clear the stash so a later back/forward
    // navigation to /advanced -- which does not pass through the compose screen's
    // Advanced click -- falls back to the picker rather than re-seeding from this
    // now-stale file. Safe under React StrictMode: this runs only after
    // loadCSVFile resolves, i.e. after the double-invoked render initializer and
    // the setup/cleanup/setup effect cycle have already read the hand-off
    // synchronously, so neither mount loses it.
    clearAdvancedHandoff();

    // Refuse an unnamed-column header before seeding: seedAdvancedInvite and the
    // satisfiability check below both infer metadata from these columns, which
    // rejects an empty name by throwing. An empty header cannot be fixed in the
    // editor, so reject it here with the shared clear error and drop back to the
    // picker, mirroring the unlinkable block below.
    const emptyPositions = emptyColumnPositions(columns);
    if (emptyPositions.length > 0) {
      setError(unnameableColumnsAlert(emptyPositions));
      setPhase({ status: "acquire" });
      return;
    }

    // Assess against the FULL default terms (every default field declared) so the
    // block can name the field types the file lacks -- the same gate and wording
    // generateInvitation and the acceptor pre-flight use.
    const { unsatisfied, satisfiableKeyCount } = assessLinkageSatisfiability(
      columns,
      getDefaultLinkageTerms(name),
    );
    if (satisfiableKeyCount === 0) {
      const detail =
        unsatisfied.length > 0
          ? " (missing: " +
            unsatisfied
              .map(
                (f) =>
                  `${sanitizeForDisplay(f.name)} (${sanitizeForDisplay(f.type)})`,
              )
              .join(", ") +
            ")"
          : "";
      setError({
        title: "This file cannot be linked",
        message:
          `Your CSV cannot satisfy any default linkage key${detail}. No ` +
          "matches would be possible. Choose a file that includes columns for " +
          "the required field types (for example name, date of birth, or SSN).",
      });
      setPhase({ status: "acquire" });
      return;
    }

    const { seed } = seedAdvancedInvite(name, columns, rawRows);
    setPhase({ status: "editing", seed, identity: name, file, rawRows });
  };

  // On mount, consume a warm hand-off if one is present. Latched so it runs once
  // even though React StrictMode invokes this effect twice (setup/cleanup/setup):
  // a second enterEditor would re-read the same file's headers for nothing. The ref
  // persists across the StrictMode remount (same instance), so the second setup
  // no-ops.
  const warmStartedRef = useRef(false);
  useEffect(() => {
    if (warmStartedRef.current || !handoff) return;
    warmStartedRef.current = true;
    void enterEditor(handoff.file, handoff.name);
  }, []);

  const handleFileSubmit = () => {
    if (files.length === 0) return;
    void enterEditor(files[0], "");
  };

  const handleGenerate = async (
    terms: LinkageTerms,
    lifetimeSeconds: number,
    metadata: Metadata,
    standardization: Standardization,
  ) => {
    if (phase.status !== "editing") return;
    setError(undefined);
    setGenerating(true);
    try {
      const invitation = await generateInvitation({
        inviterName: terms.identity,
        file: phase.file,
        location: invitationLocation(),
        linkageTerms: terms,
        lifetimeSeconds,
        metadata,
        standardization,
      });
      if (!mountedRef.current) return;
      // Reset before the transition: the editing UI unmounts here so the flag is
      // not observable today, but leaving it stuck `true` would mislead any future
      // path that re-enters editing without a remount.
      setGenerating(false);
      setPhase({
        status: "exchange",
        invitation,
        inviterName: terms.identity,
      });
    } catch (e) {
      if (!mountedRef.current) return;
      setGenerating(false);
      if (e instanceof InvitationFileError) {
        // The editor pre-validated, so this is defensive: a body that fails the
        // full parse, or a satisfiability edge the header pass missed. Reset to
        // recommended would re-derive from the same unusable file, so drop back to
        // the picker -- where "choose another file" is an action the UI offers
        // (the editing phase has no picker).
        setFiles([]);
        setPhase({ status: "acquire" });
        // An unnamed-column file is caught by enterEditor before the editor opens,
        // so reaching here with one means the file changed under us; still surface
        // the specific column positions (matching the quick path) rather than the
        // generic message used for the unreadable/unlinkable kinds.
        setError(
          e.failure.kind === "unnameable"
            ? unnameableColumnsAlert(e.failure.positions)
            : {
                title: "Could not generate invitation",
                message:
                  "Your file could not back this invitation. Choose another " +
                  "file and try again.",
              },
        );
      } else {
        // Internal fault (a schema/encoding error). Keep error internals out of
        // a secret-bearing flow; log only the type. Mirrors InvitePanel.
        console.error(
          "advanced invitation generation failed:",
          e instanceof Error ? e.name : typeof e,
        );
        setError({
          title: "Could not generate invitation",
          message: "Could not generate the invitation. Please try again.",
        });
      }
    }
  };

  return (
    <Paper
      // The acquire, loading, and exchange screens are single entry/reading columns,
      // so the panel self-constrains to EXCHANGE_READING_WIDTH (centered) rather than
      // filling the route's wide container -- matching the home and accept exchange
      // screens. The terms editor (editing) is a genuine wide editor and keeps the
      // full route width, mirroring the accept route's "Prepare your data" phase.
      style={
        phase.status === "editing"
          ? undefined
          : { width: EXCHANGE_READING_WIDTH, marginInline: "auto" }
      }
    >
      <Title order={1}>Invite someone to a data exchange</Title>

      {phase.status === "acquire" && (
        <Stack mt="md">
          <Text size="sm" c="dimmed">
            Choose your data file to begin. Its columns set which matching rules
            you can use. We read it in your browser to build the invitation; it
            is never uploaded.
          </Text>
          <FileSelect
            submitLabel="Continue to options"
            handleSubmit={handleFileSubmit}
            submitted={false}
            files={files}
            setFiles={setFiles}
          />
          {error && (
            <Alert
              color="red"
              icon={<IconAlertCircle aria-hidden />}
              title={error.title}
              style={{ whiteSpace: "pre-line" }}
            >
              {error.message}
            </Alert>
          )}
        </Stack>
      )}

      {phase.status === "loading" && (
        <Center mt="md">
          <Loader size="sm" />
        </Center>
      )}

      {phase.status === "editing" && (
        <Stack mt="md">
          {/* Key on the seed's columns so a future path that swaps the editing
              seed in place (rather than remounting, the only way today) gets a
              fresh editor -- resetting the draft AND the editor's per-session
              expert state (keysAuthored, expertMode). Mirrors the key on the
              invitation view below and the reset comment in handleGenerate. */}
          <LinkageTermsEditor
            key={phase.seed.columns.join(" ")}
            seed={phase.seed}
            initialIdentity={phase.identity}
            rawRows={phase.rawRows}
            onGenerate={(terms, lifetimeSeconds, metadata, standardization) =>
              void handleGenerate(
                terms,
                lifetimeSeconds,
                metadata,
                standardization,
              )
            }
            generating={generating}
          />
          {error && (
            <Alert
              color="red"
              icon={<IconAlertCircle aria-hidden />}
              title={error.title}
              style={{ whiteSpace: "pre-line" }}
            >
              {error.message}
            </Alert>
          )}
        </Stack>
      )}

      {phase.status === "exchange" && (
        <Stack mt="md">
          <Title order={2}>Your invitation is ready</Title>
          <ExchangeView
            key={phase.invitation.sharedSecret}
            role="inviter"
            partyName={phase.inviterName}
            sharedSecret={phase.invitation.sharedSecret}
            expires={phase.invitation.expires}
            linkageTerms={phase.invitation.linkageTerms}
            metadata={phase.invitation.metadata}
            standardization={phase.invitation.standardization}
            share={{
              deepLink: phase.invitation.deepLink,
              encoded: phase.invitation.encoded,
            }}
            acquired={{
              rawRows: phase.invitation.rawRows,
              columns: phase.invitation.columns,
            }}
          />
        </Stack>
      )}
    </Paper>
  );
}
