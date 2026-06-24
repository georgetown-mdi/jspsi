import { useForm } from "@tanstack/react-form";
import { useNavigate } from "@tanstack/react-router";

import { Button, Center, Paper, Stack, Textarea, Title } from "@mantine/core";

import {
  clearAcceptHandoff,
  stashAcceptHandoff,
} from "@components/acceptHandoff";

/**
 * Peel the encoded invitation token out of what the user pasted. A deep-link URL
 * carries the token in its fragment (`<origin>/accept#<token>`), so everything
 * after the first `#` is the token; a bare code has no `#` and is used as-is.
 * Taking the fragment keeps the confidential token out of any query string, the
 * same reason the inviter places it in the fragment.
 */
function tokenFromInput(input: string): string {
  const trimmed = input.trim();
  const hash = trimmed.indexOf("#");
  return hash === -1 ? trimmed : trimmed.slice(hash + 1);
}

interface AcceptFormProps {
  /** The file chosen in the home page's shared drop. The accept path does not
   * require it -- "Review invitation" works without one -- but if it is present we
   * carry it to the consent screen (via {@link stashAcceptHandoff}) so the user
   * need not re-drop the same file. The handle is only stashed, never parsed: the
   * accept screen still parses behind its consent gate. */
  files: Array<File>;
}

/**
 * Homepage accept form: takes either a bare encoded invitation or a pasted
 * deep-link URL and routes to the `/accept` consent page with the token in the
 * URL fragment -- the same destination the inviter's deep-link points at. The
 * decode, terms review, expiry enforcement, and rendezvous all live on `/accept`.
 *
 * "Review invitation" is disabled until the field holds a usable token, so the
 * action is offered only once there is something to review; the file drop below
 * does NOT gate it (a file is optional for accepting).
 */
export default function AcceptForm({ files }: AcceptFormProps) {
  const navigate = useNavigate();

  const form = useForm({
    defaultValues: { invitation: "" },
    onSubmit: ({ value }) => {
      const token = tokenFromInput(value.invitation);
      if (!token) return;
      // Carry the home-page file selection (if any) to the consent screen, or
      // clear any stale stash so the accept screen falls back to its own picker.
      // Only a File handle moves; the parse stays gated behind consent there.
      if (files.length > 0) stashAcceptHandoff(files[0]);
      else clearAcceptHandoff();
      // The token rides in the fragment, never a search param, so this
      // confidential value is not sent to the server (matching the inviter's
      // deep-link). `/accept` reads it from `window.location.hash`.
      void navigate({ to: "/accept", hash: token });
    },
  });

  return (
    <Paper>
      <Title order={2}>Accept an invitation you were sent</Title>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void form.handleSubmit();
        }}
      >
        <Stack>
          <form.Field
            name="invitation"
            validators={{
              onChange: ({ value }) =>
                !tokenFromInput(value)
                  ? "An invitation is required"
                  : undefined,
            }}
            children={({ state, handleChange, handleBlur }) => (
              <Textarea
                value={state.value}
                onChange={(e) => handleChange(e.target.value)}
                onBlur={handleBlur}
                error={
                  (state.meta.isBlurred || form.state.submissionAttempts > 0) &&
                  state.meta.errors.length > 0
                    ? state.meta.errors.join(", ")
                    : undefined
                }
                errorProps={{ role: "alert" }}
                withAsterisk
                required
                // Taller resting box than the lone link/code strictly needs:
                // beside the equal-width invite panel (the far taller, file-bearing
                // flow) a 2-row paste box looked stunted, so give it more vertical
                // presence. Still autosizes to grow past this for a long pasted URL.
                autosize
                minRows={6}
                label="Invitation link or code"
                description="Paste the link or code your partner sent you"
                placeholder="https://...#... or the bare code"
              />
            )}
          />
          <Center>
            {/* Disabled until the field holds a usable token, so the action is
                offered only when there is an invitation to review. Subscribes to
                the field rather than gating on the validator's error string so an
                untouched (never-blurred) field still disables the button. */}
            <form.Subscribe
              selector={(s) => tokenFromInput(s.values.invitation)}
            >
              {(token) => (
                <Button type="submit" disabled={!token}>
                  Review invitation
                </Button>
              )}
            </form.Subscribe>
          </Center>
        </Stack>
      </form>
    </Paper>
  );
}
