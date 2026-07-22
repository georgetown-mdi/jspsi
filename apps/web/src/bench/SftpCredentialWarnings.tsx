import { Alert, Stack, Text } from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

/**
 * The non-blocking credential warnings for an authored SFTP connection, rendered
 * below the connection summary as a yellow (warning) Alert. Each warning is
 * appliance-generated and names a credential field and a directory only -- never a
 * path or secret. The exchange still runs; these only guide the operator toward a
 * separate read-only secrets mount. Renders nothing when there are no warnings.
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
