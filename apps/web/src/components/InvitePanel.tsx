import { useEffect, useRef, useState } from "react";

import {
  ActionIcon,
  Alert,
  Anchor,
  Code,
  CopyButton,
  Divider,
  Group,
  Paper,
  Stack,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { IconCheck, IconCopy } from "@tabler/icons-react";
import { useForm } from "@tanstack/react-form";

import { sanitizeErrorForDisplay, sanitizeForDisplay } from "@psilink/core";

import { InvitationFileError, generateInvitation } from "@psi/invitation";

import { ExchangeView } from "@components/ExchangeView";
import FileSelect from "@components/FileSelect";

import type { GeneratedInvitation, InvitationLocation } from "@psi/invitation";
import type { AlertContent } from "@components/FileAcquire";

/** Upper bound on the inviter's name. It flows into the token's linkage terms
 * and so into the encoded invitation and its deep-link URL; bounding it keeps the
 * shared artifact a sensible length rather than letting an arbitrarily long name
 * produce an unwieldy, possibly over-long link. */
const MAX_INVITER_NAME_LENGTH = 200;

/** This page's location, in the shape {@link generateInvitation} consumes. It
 * reads `window`, so it must be called from a client-side path; it throws rather
 * than return a wrong value if ever reached during SSR, since there is no
 * sensible server-side location. The sole caller is the submit handler, an event
 * that cannot fire during render. */
function invitationLocation(): InvitationLocation {
  if (typeof window === "undefined")
    throw new Error("invitationLocation must be called in the browser");
  return {
    origin: window.location.origin,
    hostname: window.location.hostname,
    port: window.location.port,
  };
}

/** A labelled, copy-to-clipboard view of one shareable artifact. It is only ever
 * rendered on the client -- behind the `session` state guard at its call site,
 * which starts `undefined` and is set only in an event handler, so CopyRow is
 * absent from the server render and never participates in hydration. The
 * `typeof navigator` check is defence-in-depth (and hides the button on
 * non-secure origins, where `navigator.clipboard` is undefined), not the SSR
 * safety mechanism -- that is the call-site guard. */
function CopyRow({
  label,
  description,
  value,
}: {
  label: string;
  description: string;
  value: string;
}) {
  return (
    <Stack gap={2}>
      <Text size="sm" fw={500}>
        {label}
      </Text>
      <Text size="xs" c="dimmed">
        {description}
      </Text>
      <Group gap="xs" wrap="nowrap" align="flex-start">
        <Code block style={{ flex: 1, overflowWrap: "anywhere" }}>
          {value}
        </Code>
        {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          typeof navigator !== "undefined" && navigator.clipboard ? (
            <CopyButton value={value} timeout={1000}>
              {({ copied, copy }) => (
                <Tooltip
                  label={copied ? "Copied" : "Copy to clipboard"}
                  // Open on keyboard focus too, not hover only, so keyboard
                  // users get the same affordance.
                  events={{ hover: true, focus: true, touch: true }}
                >
                  <ActionIcon
                    onClick={copy}
                    variant={copied ? "light" : "filled"}
                    // Name reflects the copied state so a screen reader announces
                    // the success (the icon/tooltip change alone is not conveyed
                    // to assistive tech).
                    aria-label={
                      copied ? `${label} copied` : `Copy ${label.toLowerCase()}`
                    }
                  >
                    {copied ? <IconCheck size={18} /> : <IconCopy size={18} />}
                  </ActionIcon>
                </Tooltip>
              )}
            </CopyButton>
          ) : null
        }
      </Group>
    </Stack>
  );
}

/** A generated invitation together with the inviter name that produced it. The
 * invitation carries the file-derived linkage terms and the parsed rows (so the
 * exchange below reuses them without re-parsing), and the secret seeds the
 * rendezvous peer id the inviter listens on. */
interface InviterSession {
  invitation: GeneratedInvitation;
  inviterName: string;
}

export function InvitePanel() {
  const [session, setSession] = useState<InviterSession>();
  const [error, setError] = useState<AlertContent>();
  const [files, setFiles] = useState<Array<File>>([]);
  // The selected file is read back inside the form's onSubmit, which runs in a
  // callback that may close over a stale `files` value; a ref always reflects the
  // latest selection. (The submit button is gated on a file being present, so the
  // read below normally finds one; the guard is defensive.)
  const filesRef = useRef<Array<File>>([]);
  const selectFiles = (next: Array<File>) => {
    filesRef.current = next;
    setFiles(next);
  };

  // Move focus to the result heading once an invitation is generated, so a
  // screen-reader / keyboard user is taken to the output rather than left on the
  // button with the new region announced only if they happen to explore for it.
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (session) resultHeadingRef.current?.focus();
  }, [session]);

  const form = useForm({
    defaultValues: { inviterName: "" },
    onSubmit: async ({ value }) => {
      setError(undefined);
      const inviterName = value.inviterName.trim();
      // Defensive: the Generate button is disabled until a file is selected, so
      // there is normally one here. Bail rather than mint a fileless invitation.
      if (filesRef.current.length === 0) return;
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

  return (
    <Paper>
      <Title order={2}>Invite someone to join you in a data exchange</Title>
      {session === undefined ? (
        <Stack mt="md">
          <Text size="sm" c="dimmed">
            Choose your data file and add your name. We read the file in your
            browser to set the invitation&apos;s matching rules; it is never
            uploaded.
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
                  // The compose screen has no <form> element (so FileSelect's
                  // submit button, which defaults to type=submit, cannot double-
                  // fire), so restore Enter-to-submit on the name field by hand.
                  // Skip Enter mid-IME-composition, which only commits the
                  // candidate text. The submit no-ops without a file (the handler
                  // guards on one), matching the disabled Generate button.
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
          <Anchor
            component="button"
            type="button"
            // Disabled for now (the configuration GUI is a later roadmap item),
            // but a real focusable control rather than inert text: aria-disabled
            // (not the native `disabled` attribute, which would drop it from the
            // tab order) keeps it reachable and announced disabled, and the click
            // is suppressed so it does nothing until that feature lands.
            aria-disabled="true"
            c="dimmed"
            ta="left"
            style={{ width: "fit-content", cursor: "not-allowed" }}
            onClick={(e) => e.preventDefault()}
          >
            Advanced options
          </Anchor>
          <form.Subscribe selector={(s) => s.isSubmitting}>
            {(isSubmitting) => (
              <FileSelect
                submitLabel="Generate invitation"
                handleSubmit={() => void form.handleSubmit()}
                submitted={isSubmitting}
                files={files}
                setFiles={selectFiles}
              />
            )}
          </form.Subscribe>
          {error && (
            <Alert
              color="red"
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
          <Title order={3} ref={resultHeadingRef} tabIndex={-1}>
            Share this invitation
          </Title>
          <Text size="sm" c="dimmed">
            Send one of these to your partner over a trusted channel (for
            example, secure email). It carries a one-time secret, so treat it as
            confidential and do not post it publicly.
          </Text>
          <CopyRow
            label="Invitation link"
            description="Opens the accept page with the invitation prefilled"
            value={session.invitation.deepLink}
          />
          <CopyRow
            label="Invitation code"
            description="Paste into the accept form if the link cannot be used"
            value={session.invitation.encoded}
          />

          <Divider
            my="sm"
            label="Then run the exchange"
            labelPosition="center"
          />
          <Text size="sm" c="dimmed">
            Your browser is waiting for your partner to accept the invitation
            and connect, using the file you already chose. Keep this tab open.
          </Text>
          {/* The exchange runs on the file/terms captured at compose time: the
              embedded linkage terms (reused verbatim so the acceptor adopts the
              same set) and the parsed rows (no re-parse, no second file prompt). */}
          <ExchangeView
            key={session.invitation.sharedSecret}
            role="inviter"
            partyName={session.inviterName}
            sharedSecret={session.invitation.sharedSecret}
            expires={session.invitation.expires}
            linkageTerms={session.invitation.linkageTerms}
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
