import { Alert, Stack, Text, VisuallyHidden } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

/** The warning alert's title, and the whole of what its polite region announces
 * -- the warnings themselves stay in reading order below it. */
const CREDENTIAL_WARNING_TITLE = "Credential file location";

/**
 * The non-blocking credential warnings for an authored SFTP connection, rendered
 * below the connection summary as a yellow (warning) Alert. The console writes
 * each warning, and it names a credential field and a directory only -- never a
 * path or a secret. The exchange still runs; the warnings point the operator at
 * a separate read-only secrets mount.
 *
 * The polite region is mounted in every phase and announces the title alone; the
 * visible Alert holds the warnings and takes `role="presentation"` to displace
 * Mantine's `role="alert"` default, which would announce the same warnings a
 * second time. Nothing visible renders while there are no warnings.
 */
export function SftpCredentialWarnings({
  warnings,
}: {
  warnings: ReadonlyArray<string>;
}) {
  const announcement = useDeferredAnnouncement(
    warnings.length === 0 ? "" : CREDENTIAL_WARNING_TITLE,
  );
  return (
    <>
      <VisuallyHidden
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="credential-warnings-announcement"
      >
        {announcement}
      </VisuallyHidden>
      {warnings.length > 0 && (
        <Alert
          color="yellow"
          role="presentation"
          icon={<IconAlertTriangle aria-hidden />}
          title={CREDENTIAL_WARNING_TITLE}
        >
          <Stack gap={4}>
            {warnings.map((warning, index) => (
              <Text key={index} size="sm">
                {warning}
              </Text>
            ))}
          </Stack>
        </Alert>
      )}
    </>
  );
}
