import { useForm } from '@tanstack/react-form';
import { TextInput, Group, Button } from '@mantine/core';

export default function JoinPSIForm() {
  const { Field, handleSubmit, state } = useForm({
    defaultValues: {
      id: '',
    },
    onSubmit: async ({ value }) => {
      console.log(value);
      // fetch()
    }
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        handleSubmit()
      }}
    >
      <Field
        name='id'
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
      <Group justify="flex-end" mt="md">
        <Button
          type="submit"
          >Join</Button>
      </Group>
    </form>
  )
}