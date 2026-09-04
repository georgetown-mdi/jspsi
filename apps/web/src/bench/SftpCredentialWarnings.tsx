import { Alert, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

/**
 * The non-blocking credential warnings for an authored SFTP connection, rendered
 * below the connection summary as a yellow (warning) Alert. The console writes
 * each warning, and it names a credential field and a directory only -- never a
 * path or a secret. The exchange still runs; the warnings point the operator at
 * a separate read-only secrets mount. Renders nothing when there are none.
 */
export function SftpCredentialWarnings({
  warnings,
}: {
  warnings: ReadonlyArray<string>;
}) {
  if (warnings.length === 0) return null;
  return (
    <Alert
      color="yellow"
      role="status"
      icon={<IconAlertTriangle aria-hidden />}
      title="Credential file location"
    >
      <Stack gap={4}>
        {warnings.map((warning, index) => (
          <Text key={index} size="sm">
            {warning}
          </Text>
        ))}
      </Stack>
    </Alert>
  );
}
