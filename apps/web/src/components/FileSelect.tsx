import {
  Button,
  Group,
  List,
  Paper,
  Stack,
  Text
} from '@mantine/core';
import { Dropzone, MIME_TYPES } from '@mantine/dropzone';
import { IconFile, IconFileDatabase, IconUpload, IconX  } from '@tabler/icons-react';

import type { PaperProps } from '@mantine/core';

interface FileSelectProps extends PaperProps {
  handleSubmit: () => void
  files: Array<File>
  setFiles: (acceptedFiles: Array<File>) => void
  submitted: boolean
}

export default function FileSelect(props: FileSelectProps) {
  const { handleSubmit, files, setFiles, submitted, ...paperProps } = props;

  const handleDrop = (acceptedFiles: Array<File>) => {
    setFiles(acceptedFiles);
  };

  return (
    <Paper {...paperProps}>
      <Stack gap="md">
        <Dropzone
          onDrop={handleDrop}
          onReject={() => {}}
          maxSize={10 * 1024 ** 2} // 10MB
          accept={[
            // 'text/plain',
            MIME_TYPES.csv,
            // MIME_TYPES.xls,
            // MIME_TYPES.xlsx,
            // 'application/vnd.apache.parquet'
          ]}
          {...(submitted ? {
              disabled: true,
              style: {
                cursor: 'not-allowed',
                'backgroundColor': 'light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))',
                'borderColor': 'light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-5))',
                color: 'light-dark(var(--mantine-color-gray-5), var(--mantine-color-dark-3))'
              }
            }
            : {}
          )}
        >
          <Group justify="center" gap="xl" mih={220} style={{ pointerEvents: 'none' }}>
            <Dropzone.Accept>
              <IconUpload size={52} color="var(--mantine-color-blue-6)" stroke={1.5} />
            </Dropzone.Accept>
            <Dropzone.Reject>
              <IconX size={52} color="var(--mantine-color-red-6)" stroke={1.5} />
            </Dropzone.Reject>
            <Dropzone.Idle>
              <IconFileDatabase size={52} color="var(--mantine-color-dimmed)" stroke={1.5} />
            </Dropzone.Idle>
            <Text mt="sm" inline>Drag files here or click to select</Text>
            <Text size="xs" c="dimmed" inline mt={7}>
              (Max file size: 10MB)
            </Text>
          </Group>
        </Dropzone>

        {files.length > 0 && (
          <List spacing="xs" size="sm" center icon={<IconFile size={16} />}>
            {files.map((file, idx) => (
              <List.Item key={idx}>{file.name}</List.Item>
            ))}
          </List>
        )}

        <Group justify="center" mt="sm">
          <Button
            disabled={files.length === 0 || submitted}
            onClick={handleSubmit}
          >
            Start
          </Button>
        </Group>
      </Stack>
    </Paper>
  );
}
