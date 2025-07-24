import { useForm } from '@tanstack/react-form';
import { useNavigate } from '@tanstack/react-router';

import { Button, Center, Stack, TextInput, Textarea } from '@mantine/core';

export default function CreatePSIForm() {
  const navigate = useNavigate();

  const form = useForm({
    defaultValues: {
      initiatedName: '',
      invitedName: '',
      description: ''
    },
    onSubmit: async ({ value }) => {
      const response = await fetch('./api/psi/create', {
        method: 'POST',
        body: JSON.stringify({
          initiatedName: value.initiatedName,
          invitedName: value.invitedName,
          description: value.description
        }),
      });
      
      const { id: sessionId, timeToLive: _timeToLive } = await response.json();

      if (response.ok) {
        navigate({
          to: '/psi',
          search: {
            id: sessionId,
            start: true
          }
        });
      } else {
        console.log(`error: ${response.statusText}`);
      }
    }
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
      <Stack>
        <form.Field
          name='initiatedName'
          validators={{
            onChange: ({ value }) =>
              !value ? 'Your name is required' : undefined,
          }}
          children={({ state, handleChange, handleBlur }) => (
            <TextInput
              defaultValue={state.value}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={handleBlur}
              withAsterisk
              required
              label='Your name'
              description='So that your partner can identify you'
              placeholder='Your name'
              />
          )}
          />
        <form.Field
          name='invitedName'
          validators={{
            onChange: ({ value }) =>
              !value ? 'Invited name is required' : undefined,
          }}
          children={({ state, handleChange, handleBlur }) => (
            <TextInput
              defaultValue={state.value}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={handleBlur}
              withAsterisk
              required
              label="Partner's name"
              description='So that your partner knows they received the right link'
              placeholder="Partner's name"
              />
          )}
          />
        <form.Field
          name='description'
          children={({ state, handleChange, handleBlur }) => (
            <Textarea
              defaultValue={state.value}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={handleBlur}
              label='Description'
              description='Describe the purposes of the data exchange'
              placeholder='Description'
              autosize
              minRows={2}
              />
          )}
          />
        <Center>
          <Button
            type="submit"
            >Submit</Button>
        </Center>
      </Stack>
    </form>
  )
}