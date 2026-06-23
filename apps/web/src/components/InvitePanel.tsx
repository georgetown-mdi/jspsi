import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Anchor,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";

import {
  loadCSVColumns,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
} from "@psilink/core";

import { InvitationFileError, generateInvitation } from "@psi/invitation";
import { invitationLocation } from "@psi/invitationLocation";
import { quickInviteDisclosedColumns } from "@psi/metadataEditing";
import { unnameableColumnsAlert } from "@psi/columnNames";

import { ExchangeView } from "@components/ExchangeView";
import { stashAdvancedHandoff } from "@components/advancedHandoff";

import type { AlertContent } from "@components/FileAcquire";
import type { GeneratedInvitation } from "@psi/invitation";

/** Upper bound on the inviter's name. It flows into the token's linkage terms
 * and so into the encoded invitation and its deep-link URL; bounding it keeps the
 * shared artifact a sensible length rather than letting an arbitrarily long name
 * produce an unwieldy, possibly over-long link. */
const MAX_INVITER_NAME_LENGTH = 200;

/** A generated invitation together with the inviter name that produced it. The
 * invitation carries the file-derived linkage terms and the parsed rows (so the
 * exchange below reuses them without re-parsing), and the secret seeds the
 * rendezvous peer id the inviter listens on. */
export interface InviterSession {
  invitation: GeneratedInvitation;
  inviterName: string;
}

interface InvitePanelProps {
  /** The generated session, lifted to {@link HomePage} so it can swap the resting
   * two-column layout for a full-width exchange view once an invitation exists.
   * `undefined` shows the compose form; a value shows the {@link ExchangeView}. */
  session: InviterSession | undefined;
  /** Store (on Generate) or clear (on a generation failure) the session in the
   * owner. The owner re-renders this panel with the new value, which is what
   * drives the compose-form -> exchange-view transition below. */
  setSession: (session: InviterSession | undefined) => void;
  /** The file chosen in the home page's shared drop, which now sits below both
   * compose panels rather than inside this one. Read-only here: the panel gates
   * Generate on it, derives the disclosure from it, and reads it back at submit;
   * the owner ({@link HomePage}) holds the selection and the drop target. */
  files: Array<File>;
}

export function InvitePanel({ session, setSession, files }: InvitePanelProps) {
  const navigate = useNavigate();
  const [error, setError] = useState<AlertContent>();
  // The selected file is read back inside the form's onSubmit -- a callback created
  // once that would otherwise close over a stale `files` value. A ref synced to the
  // latest prop on every render keeps that read current. (Generate is gated on a
  // file being present, so the read below normally finds one; the guard is
  // defensive.)
  const filesRef = useRef<Array<File>>(files);
  filesRef.current = files;
  // The columns the quick path will send to the partner, surfaced as an awareness
  // statement before the operator generates. `undefined` while no file is chosen
  // or its header read is still in flight; an empty array means the quick path
  // would send nothing. Derived from the SAME predicate the wire uses (see
  // quickInviteDisclosedColumns), so it cannot drift from what is actually
  // transmitted.
  const [disclosedColumns, setDisclosedColumns] = useState<Array<string>>();

  // Read the chosen file's header (only the header -- see loadCSVColumns) and
  // compute the quick-path disclosure each time the selection changes. Best-effort
  // awareness: a read error is swallowed here (the statement just stays hidden);
  // the authoritative full parse and its surfaced error happen at generate. The
  // cleanup flag drops a stale or post-unmount result -- selecting a new file (or
  // navigating to Advanced) supersedes an in-flight read of the previous one.
  useEffect(() => {
    if (files.length === 0) {
      setDisclosedColumns(undefined);
      return;
    }
    const file = files[0];
    let cancelled = false;
    setDisclosedColumns(undefined);
    void loadCSVColumns(file)
      .then((columns) => {
        if (!cancelled)
          setDisclosedColumns(quickInviteDisclosedColumns(columns));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [files]);

  const form = useForm({
    defaultValues: { inviterName: "" },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const inviterName = value.inviterName.trim();
      // The Generate button is disabled until a file is selected, but pressing
      // Enter in the name field can still submit; surface the missing file rather
      // than silently doing nothing, so a keyboard user is not left guessing.
      if (filesRef.current.length === 0) {
        setError({
          title: "Choose a data file",
          message:
            "Choose your CSV file in the drop below before generating the " +
            "invitation -- its columns set the invitation's matching rules.",
        });
        return;
      }
      const file = filesRef.current[0];
      try {
        // A fresh secret each time, so generating again supersedes any prior
        // unsent invitation -- a new secret means a new derived rendezvous id,
        // and one invitation is not expected to back more than one exchange. The
        // terms are derived from this file and embedded; the exchange below reuses
        // the returned terms and parsed rows.
        const invitation = await generateInvitation({
          inviterName,
          file,
          location: invitationLocation(),
        });
        setSession({ invitation, inviterName });
      } catch (e) {
        setSession(undefined);
        if (e instanceof InvitationFileError) {
          // User-actionable: the inviter can choose another file. No token was
          // minted (the failure is thrown before the secret is generated).
          if (e.failure.kind === "unreadable") {
            // Mirror FileAcquire's read-failure surface: sanitizeErrorForDisplay
            // escapes the error and separates a multi-cause chain onto its own
            // lines (rendered with whiteSpace: pre-line below).
            setError({
              title: "Could not read your file",
              message: sanitizeErrorForDisplay(e.failure.cause),
            });
          } else if (e.failure.kind === "unnameable") {
            // An unnamed-column header: name the offending positions and tell the
            // operator to fix the header, the same shared wording the Advanced
            // editor and the acceptor's file acquire use (positions are not
            // operator content, so they are shown directly).
            setError(unnameableColumnsAlert(e.failure.positions));
          } else {
            // Zero satisfiable keys: name the field types the file lacks, the
            // same wording the acceptor's zero-coverage block uses. The default
            // field names/types are not partner-controlled, but sanitize anyway
            // for parity with that path. The detail is omitted when no default
            // field is named (it should always be present here).
            const detail =
              e.failure.unsatisfied.length > 0
                ? " (missing: " +
                  e.failure.unsatisfied
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
                "matches would be possible. Choose a file that includes columns " +
                "for the required field types (for example name, date of birth, " +
                "or SSN).",
            });
          }
        } else {
          // An internal, non-user-actionable error (a schema ZodError, an SSR
          // misuse). Show a fixed message rather than the raw error: a raw
          // ZodError dump is unhelpful, and not echoing error internals into a
          // secret-bearing flow keeps a future Zod version that embeds a failing
          // field's value out of the UI. Log only the error type.
          console.error(
            "invitation generation failed:",
            e instanceof Error ? e.name : typeof e,
          );
          setError({
            title: "Could not generate invitation",
            message: "Could not generate the invitation. Please try again.",
          });
        }
      }
    },
  });

  // Open the column-aware editor, handing off the already-chosen file and name in
  // memory (a File cannot ride the URL) so the editor opens seeded without a
  // re-drop. The lone "Advanced Options" link lives inside the disclosure, which
  // renders only after a file's header has been read, so a file is always present
  // when this fires; guard defensively rather than hand off an undefined file.
  const openAdvanced = () => {
    if (filesRef.current.length === 0) return;
    stashAdvancedHandoff({
      file: filesRef.current[0],
      name: form.state.values.inviterName.trim(),
    });
    void navigate({ to: "/advanced" });
  };

  return (
    <Paper>
      <Title order={2}>Invite someone to join you in a data exchange</Title>
      {session === undefined ? (
        <Stack mt="md">
          <Text size="sm" c="dimmed">
            Add your name, then choose your data file below. We read the file in
            your browser to set the invitation&apos;s matching rules; it is
            never uploaded.
          </Text>
          <form.Field
            name="inviterName"
            validators={{
              onChange: ({ value }) =>
                !value.trim() ? "Your name is required" : undefined,
            }}
            children={({ state, handleChange, handleBlur }) => (
              <TextInput
                value={state.value}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={handleBlur}
                onKeyDown={(e) => {
                  // The compose screen has no <form> element, so restore
                  // Enter-to-submit on the name field by hand. Skip Enter
                  // mid-IME-composition, which only commits the candidate text. The
                  // submit no-ops without a file (the handler guards on one, and
                  // surfaces the "choose a file" message), matching the disabled
                  // Generate button.
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void form.handleSubmit();
                  }
                }}
                error={
                  // Show the required-name error once the user has left the field
                  // (isBlurred) or attempted a submit (submissionAttempts) -- not
                  // on every keystroke. The submit case matters for a
                  // whitespace-only name: it passes the native `required` check
                  // (non-empty) but fails this validator, so without the submit
                  // guard the error would never appear and the click would do
                  // nothing visible.
                  (state.meta.isBlurred || form.state.submissionAttempts > 0) &&
                  state.meta.errors.length > 0
                    ? state.meta.errors.join(", ")
                    : undefined
                }
                // Announce the error when it appears (Mantine's error node is
                // otherwise a silent <p>); the input already gets aria-invalid
                // and aria-describedby automatically.
                errorProps={{ role: "alert" }}
                maxLength={MAX_INVITER_NAME_LENGTH}
                withAsterisk
                required
                label="Your name"
                description="Recorded in the invitation's linkage terms so your partner can identify you"
                placeholder="Your name"
              />
            )}
          />
          {/* Awareness surface, sitting directly above Generate so it is the last
              thing read before the operator commits -- a consent receipt for what
              leaves the machine, not a settings panel. Wrapped in a standing polite
              live region so its asynchronous appearance after a file is chosen is
              announced; aria-atomic so the heading, sentence, chips, and link read
              as one unit. It appears once a file's header has been read (whether or
              not the quick path sends anything), so the single "Advanced Options"
              link is reachable exactly when a file is chosen -- replacing the old
              standing link and its duplicate inside the statement. The disclosed set
              derives from the same predicate the wire uses, so it cannot over- or
              under-state what leaves the machine; column names are the operator's
              own but sanitized for display. */}
          <div role="status" aria-live="polite" aria-atomic="true">
            {disclosedColumns !== undefined && (
              <Paper withBorder p="md">
                <Text size="sm" fw={600} mb={4}>
                  What you will send
                </Text>
                {disclosedColumns.length > 0 ? (
                  <>
                    <Text size="sm">
                      For each row in your file that matches, your partner
                      receives{" "}
                      {disclosedColumns.length === 1
                        ? "this column"
                        : `these ${disclosedColumns.length} columns`}
                      :
                    </Text>
                    {/* Informational chips, not controls: a non-interactive Badge
                        list (no onClick, no Chip/Pill toggle or remove affordance),
                        marked up as a list so assistive tech reads "N columns" and
                        each name as a list item. Changing what is sent happens in
                        Advanced, never by editing a chip. tt="none" keeps the
                        operator's column names verbatim rather than upper-casing
                        them into system-looking tokens. */}
                    <Group
                      gap="xs"
                      mt="xs"
                      role="list"
                      aria-label="Columns sent to your partner"
                    >
                      {disclosedColumns.map((name) => (
                        <Badge
                          key={name}
                          role="listitem"
                          variant="light"
                          color="gray"
                          tt="none"
                          radius="sm"
                          size="md"
                          style={{ cursor: "default" }}
                        >
                          {sanitizeForDisplay(name)}
                        </Badge>
                      ))}
                    </Group>
                    <Text size="xs" c="dimmed" mt="xs">
                      Your partner never receives the values in your
                      non-matching rows.
                    </Text>
                  </>
                ) : (
                  <Text size="sm">
                    No column values will be sent to your partner. Your
                    file&apos;s columns are used only to find matches.
                  </Text>
                )}
                <Anchor
                  component="button"
                  type="button"
                  ta="left"
                  mt="xs"
                  style={{ width: "fit-content" }}
                  onClick={openAdvanced}
                >
                  Advanced Options
                </Anchor>
              </Paper>
            )}
          </div>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <Group justify="center" mt="sm">
                <Button
                  disabled={files.length === 0 || isSubmitting}
                  onClick={() => void form.handleSubmit()}
                >
                  Generate invitation
                </Button>
              </Group>
            )}
          </form.Subscribe>
          {error && (
            <Alert
              color="red"
              // Severity icon so the error is not signalled by color alone (WCAG
              // 1.4.1); aria-hidden since the title text already names it.
              icon={<IconAlertCircle aria-hidden />}
              title={error.title}
              // pre-line so the read-failure message's per-cause newlines (from
              // sanitizeErrorForDisplay) render one cause per line; the other
              // messages carry no newlines.
              style={{ whiteSpace: "pre-line" }}
            >
              {error.message}
            </Alert>
          )}
        </Stack>
      ) : (
        <Stack mt="md">
          {/* The exchange screen owns the share block (link/code + expiry) and the
              terms summary now; it runs on the file/terms captured at compose
              time: the embedded linkage terms (reused verbatim so the acceptor
              adopts the same set) and the parsed rows (no re-parse, no second file
              prompt), with the share artifacts surfaced for copying while it waits
              for the partner. */}
          <ExchangeView
            key={session.invitation.sharedSecret}
            role="inviter"
            partyName={session.inviterName}
            sharedSecret={session.invitation.sharedSecret}
            expires={session.invitation.expires}
            linkageTerms={session.invitation.linkageTerms}
            share={{
              deepLink: session.invitation.deepLink,
              encoded: session.invitation.encoded,
            }}
            acquired={{
              rawRows: session.invitation.rawRows,
              columns: session.invitation.columns,
            }}
          />
        </Stack>
      )}
    </Paper>
  );
}
