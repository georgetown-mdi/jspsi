import { useEffect, useRef } from "react";

import { Button, Group, Stack, Text } from "@mantine/core";

import { sanitizeForDisplay } from "@psilink/core";

import { IDENTITY_DEFAULT_LOCATION_LABEL } from "@psi/receiptsModel";

import styles from "@styles/app.module.css";

import { SecretsFilePicker } from "./SecretsFilePicker";

import type { JobSigningIdentityLocation } from "@jobs/intentSchemas";

/**
 * Where this party's signing identity is kept, as an authoring control: the
 * console's default folder, or a file the operator picks by browsing the
 * secrets mount. It composes the `signing.identity_file` of the configuration a
 * graduated command-line run loads unchanged.
 *
 * The value is a LOCATOR -- the mount id and the path segments -- never a path:
 * the server resolves it against its own `JOB_SECRETS_DIR`, so no
 * container-absolute path is shown here or sent from here. The default is
 * described in the operator's own words rather than spelled as a path, for the
 * same reason.
 *
 * A picked location is one the console READS. It creates the identity only at
 * its default location, which is why the operator's own folder may be mounted
 * read-only and why nothing there is reported rather than minted.
 */
export function SigningIdentityLocationField({
  location,
  pickerOpen,
  onPickerOpen,
  onPickerClose,
  onChange,
}: {
  location: JobSigningIdentityLocation | undefined;
  pickerOpen: boolean;
  onPickerOpen: () => void;
  onPickerClose: () => void;
  /** Commit a picked location, or the default when it is undefined. */
  onChange: (location: JobSigningIdentityLocation | undefined) => void;
}) {
  // Opening the picker leaves focus on the trigger, which then unmounts; move it
  // into the revealed picker. SecretsFilePicker skips focus on its own mount by
  // design, so the open action is what moves focus here.
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pickerOpen) pickerRef.current?.focus();
  }, [pickerOpen]);

  return (
    <Stack gap="xs">
      <Text size="sm" fw={600}>
        Where your signing identity is kept
      </Text>
      <Text size="xs" c="dimmed">
        By default the console creates it in the folder you mounted. Point it at
        a file in your secrets folder instead to keep the key out of the folder
        this exchange works in. Either way the configuration you take to the
        command line names the same file.
      </Text>

      <Group gap="xs" align="center">
        <Text size="sm">In use:</Text>
        <span className={styles.mono} data-testid="signing-identity-location">
          {location === undefined
            ? IDENTITY_DEFAULT_LOCATION_LABEL
            : `secrets / ${location.subPath
                .map((segment) => sanitizeForDisplay(segment))
                .join(" / ")}`}
        </span>
        {location !== undefined && (
          <Button
            size="compact-xs"
            variant="subtle"
            onClick={() => onChange(undefined)}
          >
            Use the folder you mounted
          </Button>
        )}
      </Group>

      {pickerOpen ? (
        <div ref={pickerRef} tabIndex={-1} style={{ outline: "none" }}>
          <Stack gap="xs">
            <SecretsFilePicker
              unconfiguredNotice={
                <>
                  This console has no separate secrets directory to browse, so
                  your signing identity stays in the folder you mounted. To keep
                  it somewhere else, mount a separate directory as
                  JOB_SECRETS_DIR, put your identity file there with psilink
                  fingerprint, and restart the console.
                </>
              }
              onSelect={(subPath) => {
                onChange({ mount: "secrets", subPath });
                onPickerClose();
              }}
            />
            <Button
              size="xs"
              variant="default"
              style={{ alignSelf: "flex-start" }}
              onClick={onPickerClose}
            >
              Cancel browsing
            </Button>
          </Stack>
        </div>
      ) : (
        <Button
          size="xs"
          variant="light"
          style={{ alignSelf: "flex-start" }}
          onClick={onPickerOpen}
        >
          {location === undefined
            ? "Choose a file from the secrets folder"
            : "Choose a different file"}
        </Button>
      )}
    </Stack>
  );
}
