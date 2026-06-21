import { useState } from "react";

import { Button, Group, List, Paper, Stack, Text } from "@mantine/core";
import { Dropzone, MIME_TYPES } from "@mantine/dropzone";
import {
  IconFile,
  IconFileDatabase,
  IconUpload,
  IconX,
} from "@tabler/icons-react";

import log from "loglevel";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import type { FileRejection } from "@mantine/dropzone";
import type { PaperProps } from "@mantine/core";

// Whole megabytes, derived from the cap so the displayed limit and the
// over-size message can never drift from the value the dropzone enforces.
const MAX_CSV_FILE_MB = MAX_CSV_FILE_BYTES / 1024 ** 2;

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

  // A user-visible reason the last drop was refused (over the size cap, or an
  // unsupported type). The dropzone enforces `maxSize` itself -- an over-cap file
  // never reaches the parser -- but on its own it only flashes a reject icon, so
  // surface why here. Cleared on the next accepted drop.
  const [rejectionMessage, setRejectionMessage] = useState<string | undefined>(
    undefined,
  );

  const handleDrop = (acceptedFiles: Array<File>) => {
    setRejectionMessage(undefined);
    setFiles(acceptedFiles);
  };

  const handleReject = (rejectedFiles: Array<FileRejection>) => {
    log.warn("rejected file(s):", rejectedFiles);
    const tooLarge = rejectedFiles.some((rejection) =>
      rejection.errors.some((error) => error.code === "file-too-large"),
    );
    setRejectionMessage(
      tooLarge
        ? `That file is larger than the ${MAX_CSV_FILE_MB} MB maximum. Choose a smaller CSV.`
        : "That file type is not supported. Choose a CSV file.",
    );
  };

  return (
    <Paper {...paperProps}>
      <Stack gap="md">
        <Dropzone
          onDrop={handleDrop}
          onReject={handleReject}
          maxSize={MAX_CSV_FILE_BYTES} // see csvIntake.ts for the bound
          accept={[
            "text/plain",
            MIME_TYPES.csv,
            "application/vnd.ms-excel",
            // MIME_TYPES.xls,
            // MIME_TYPES.xlsx,
            // 'application/vnd.apache.parquet'
          ]}
          {...(submitted
            ? {
                disabled: true,
                style: {
                  cursor: "not-allowed",
                  backgroundColor:
                    "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
                  borderColor:
                    "light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))",
                  // Accessible muted text on the disabled surface (gray-0 light
                  // / dark-6 dark): the dimmed token clears 4.5:1 there, where
                  // the prior gray-5/dark-3 sat at ~2:1.
                  color: "var(--mantine-color-dimmed)",
                },
              }
            : {})}
        >
          <Group
            justify="center"
            gap="xl"
            mih={220}
            style={{ pointerEvents: "none" }}
          >
            <Dropzone.Accept>
              <IconUpload
                size={52}
                color="var(--mantine-color-blue-6)"
                stroke={1.5}
              />
            </Dropzone.Accept>
            <Dropzone.Reject>
              <IconX
                size={52}
                color="var(--mantine-color-red-6)"
                stroke={1.5}
              />
            </Dropzone.Reject>
            <Dropzone.Idle>
              <IconFileDatabase
                size={52}
                color="var(--mantine-color-dimmed)"
                stroke={1.5}
              />
            </Dropzone.Idle>
            <Text mt="sm" inline>
              Drag files here or click to select
            </Text>
            <Text size="xs" c="dimmed" inline mt={7}>
              (Max file size: {MAX_CSV_FILE_MB}MB)
            </Text>
          </Group>
        </Dropzone>

        {rejectionMessage && (
          <Text size="sm" c="red" role="alert">
            {rejectionMessage}
          </Text>
        )}

        {files.length > 0 && (
          <List spacing="xs" size="sm" center icon={<IconFile size={16} />}>
            {files.map((file, idx) => (
              <List.Item key={idx}>{file.name}</List.Item>
            ))}
          </List>
        )}

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
