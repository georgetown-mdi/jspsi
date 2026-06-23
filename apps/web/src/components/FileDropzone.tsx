import { useState } from "react";

import { Dropzone, MIME_TYPES } from "@mantine/dropzone";
import { Group, List, Stack, Text } from "@mantine/core";
import {
  IconFile,
  IconFileDatabase,
  IconUpload,
  IconX,
} from "@tabler/icons-react";

import log from "loglevel";

import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import type { FileRejection } from "@mantine/dropzone";

// Whole megabytes, derived from the cap so the displayed limit and the
// over-size message can never drift from the value the dropzone enforces.
const MAX_CSV_FILE_MB = MAX_CSV_FILE_BYTES / 1024 ** 2;

interface FileDropzoneProps {
  files: Array<File>;
  setFiles: (acceptedFiles: Array<File>) => void;
  /** Disable the drop target and hide the rejection message, e.g. while a parse
   * is in flight. Default `false`. */
  disabled?: boolean;
}

/**
 * The bare CSV drop target: the Mantine {@link Dropzone}, the over-size/wrong-type
 * rejection message, and the chosen-file list -- with no submit button of its own.
 * {@link FileSelect} composes it with an action button (the file-acquire and
 * Advanced-options screens, where dropping and acting are one step); the home page
 * uses it standalone, below both compose panels, so a single shared drop feeds
 * either the invite or the accept path while each panel owns its own action.
 */
export default function FileDropzone({
  files,
  setFiles,
  disabled = false,
}: FileDropzoneProps) {
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
    const codes = new Set(
      rejectedFiles.flatMap((rejection) =>
        rejection.errors.map((error) => error.code),
      ),
    );
    // Report each distinct reason: a batch can mix a too-large file with a
    // wrong-type one, so checking the size code alone would hide the type
    // rejection. Any non-size rejection is a type/format problem against the
    // accept list, and the empty-reasons fallback keeps an unexpected code from
    // producing a silent reject.
    const reasons: Array<string> = [];
    if (codes.has("file-too-large"))
      reasons.push(`larger than the ${MAX_CSV_FILE_MB} MB maximum`);
    if (codes.has("file-invalid-type") || reasons.length === 0)
      reasons.push("not a supported file type");
    setRejectionMessage(
      `That file is ${reasons.join(" and ")}. Choose a CSV file under ${MAX_CSV_FILE_MB} MB.`,
    );
  };

  return (
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
        {...(disabled
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
          // A compact drop target: tall enough to read as a drop zone and stay an
          // easy click/drag target, without the bulk the prior 220 added (it
          // dominated the invite panel). Shared by every screen that drops a file.
          mih={140}
          style={{ pointerEvents: "none" }}
        >
          {/* Drag-state icon colors must clear WCAG 2.1 1.4.11's 3:1
              non-text-contrast bar against the Dropzone's light-variant
              drag-over tint -- and that tint inverts with the color scheme, so
              the icon shade has to invert too. In light the tints are the
              accept primary cyan-1 and the reject red-1, where shade 8 clears
              the bar (blue-8 = 4.29:1, red-8 = 3.73:1) and the prior shade 6
              was a marginal accept pass (3.04:1) and an outright reject
              failure (2.71:1). In dark the tint becomes the dark surface
              darken(shade-9, .5), where a deeper icon drops the other way
              below the bar, so dark stays at shade 6 (blue-6 = 3.53:1, red-6 =
              3.83:1). light-dark() selects per scheme; the icon takes no
              `color` prop so its stroke follows currentColor, which this
              inline color sets. Both schemes' ratios are enforced by
              test/unit/themeContrast.test.ts. */}
          <Dropzone.Accept>
            <IconUpload
              size={52}
              stroke={1.5}
              style={{
                color:
                  "light-dark(var(--mantine-color-blue-8), var(--mantine-color-blue-6))",
              }}
            />
          </Dropzone.Accept>
          <Dropzone.Reject>
            <IconX
              size={52}
              stroke={1.5}
              style={{
                color:
                  "light-dark(var(--mantine-color-red-8), var(--mantine-color-red-6))",
              }}
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
            (Max file size: {MAX_CSV_FILE_MB} MB)
          </Text>
        </Group>
      </Dropzone>

      {!disabled && rejectionMessage && (
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
    </Stack>
  );
}
