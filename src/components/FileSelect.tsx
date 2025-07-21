import { useState } from 'react';
import {
  Button,
  Group,
  Text,
  Center,
  Paper,
  Stack,
  List,
  ThemeIcon,
  PaperProps,
} from '@mantine/core';
import { Dropzone, MIME_TYPES } from '@mantine/dropzone';
import { IconUpload, IconFile, IconCheck } from '@tabler/icons-react';

export default function FileSelect(props: PaperProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [submitted, setSubmitted] = useState(false);

  const handleDrop = (acceptedFiles: File[]) => {
    setFiles(acceptedFiles);
    setSubmitted(false);
  };

  const handleSubmit = () => {
    // Normally you'd upload or process the files here
    setSubmitted(true);
  };

  return (
    //<Paper shadow="md" padding="lg" radius="md" withBorder style={{ maxWidth: 500, margin: '0 auto' }}>
    <Paper {...props}>
      <Stack gap="md">
        <Dropzone
          onDrop={handleDrop}
          onReject={() => {}}
          maxSize={10 * 1024 ** 2} // 10MB
          accept={['text/plain', MIME_TYPES.csv, MIME_TYPES.xls, MIME_TYPES.xlsx]}
        >
          <Center style={{ minHeight: 100, flexDirection: 'column' }}>
            <IconUpload size={32} />
            <Text mt="sm">Drag files here or click to select</Text>
            <Text size="xs" c="dimmed">
              (Max file size: 10MB)
            </Text>
          </Center>
        </Dropzone>

        {files.length > 0 && (
          <List spacing="xs" size="sm" center icon={<IconFile size={16} />}>
            {files.map((file, idx) => (
              <List.Item key={idx}>{file.name}</List.Item>
            ))}
          </List>
        )}

        <Group justify="right" mt="sm">
          <Button
            disabled={files.length === 0}
            onClick={handleSubmit}
          >
            {submitted ? 'Submitted' : 'Start'}
          </Button>
        </Group>

        {submitted && (
          <Group justify="center">
            <ThemeIcon color="green" radius="xl" size="lg">
              <IconCheck />
            </ThemeIcon>
            <Text c="green" fw={500}>
              Files submitted successfully!
            </Text>
          </Group>
        )}
      </Stack>
    </Paper>
  );
}
