import { Button, Group, Paper, Stack } from "@mantine/core";

import FileDropzone from "@components/FileDropzone";

import type { PaperProps } from "@mantine/core";

interface FileSelectProps extends PaperProps {
  handleSubmit: () => void;
  files: Array<File>;
  setFiles: (acceptedFiles: Array<File>) => void;
  submitted: boolean;
  /** Label for the submit button. Required (no hardcoded default) so each phase
   * naming this dropzone -- file-acquire today, the compose/review screens next
   * -- states its own action rather than inheriting a stale "Start". */
  submitLabel: string;
  /** Disable the submit button beyond this component's own file/submitted gate,
   * so a caller can hold it until an external precondition is met (the accept
   * review screen keeps it disabled until the consent gate is satisfied). Default
   * `false`; ORed with the always-present file-selected and not-yet-submitted
   * checks. */
  submitDisabled?: boolean;
}

/**
 * A {@link FileDropzone} paired with an action button: the screens where dropping
 * a file and acting on it are one step -- the Advanced-options file picker and the
 * acceptor's file acquire. The home page instead uses {@link FileDropzone} on its
 * own (a single shared drop below both compose panels) with each panel owning its
 * action button, so its drop is not bound to one of the two actions.
 */
export default function FileSelect(props: FileSelectProps) {
  const {
    handleSubmit,
    files,
    setFiles,
    submitted,
    submitLabel,
    submitDisabled = false,
    ...paperProps
  } = props;

  return (
    <Paper {...paperProps}>
      <Stack gap="md">
        <FileDropzone files={files} setFiles={setFiles} disabled={submitted} />
        <Group justify="center" mt="sm">
          <Button
            disabled={files.length === 0 || submitted || submitDisabled}
            onClick={handleSubmit}
          >
            {submitLabel}
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
