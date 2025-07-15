import { useForm } from '@tanstack/react-form';
import { TextInput, Textarea, Group, Button } from '@mantine/core';

export default function CreatePSIForm() {
  const { Field, handleSubmit, state } = useForm({
    defaultValues: {
      initiatedName: '',
      invitedName: '',
      description: ''
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
      <Field
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
      <Field
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
      <Group justify="flex-end" mt="md">
        <Button
          type="submit"
          >Submit</Button>
      </Group>
    </form>
  )
}