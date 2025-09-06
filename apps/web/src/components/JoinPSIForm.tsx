import { useForm } from '@tanstack/react-form';

import { Button, Center, Stack, TextInput } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';

export default function JoinPSIForm() {
  const navigate = useNavigate();

  const form = useForm({
    defaultValues: {
      uuid: '',
    },
    onSubmit: ({ value }) => {
      console.log(value);
      navigate({
        to: '/psi',
        search: {
          uuid: value['uuid'],
          start: false
        }
      });
    }
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        form.handleSubmit()
      }}
    >
      <Stack>
        <form.Field
          name='uuid'
          validators={{
            onChange: ({ value }) =>
              !value ? 'PSI session ID required' : undefined,
          }}
          children={({ state, handleChange, handleBlur }) => (
            <TextInput
              defaultValue={state.value}
              onChange={(e) => handleChange(e.target.value)}
              onBlur={handleBlur}
              withAsterisk
              required
              label='PSI Session ID'
              description='The unique identifier given by the other party'
              placeholder='PSI Session ID'
              />
          )}
          />
        <Center>
          <Button
            type="submit"
            >Join</Button>
        </Center>
      </Stack>
    </form>
  )
}