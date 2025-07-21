import { useForm } from '@tanstack/react-form';
import { TextInput, Textarea, Group, Button } from '@mantine/core';
import { useNavigate } from '@tanstack/react-router';

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
      
      const { id: sessionId, timeToLive: timeToLive } = await response.json();

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

  /* const { mutate, isLoading, error } = useMutation(newForm =>
    fetch('/api/psi', {
      method: 'GET',
    }).then(res => res.json())
  );

  const submitForm = (formData) => {
    mutate(formData, {
      onSuccess: (data) => console.log('Form submitted successfully', data),
      onError: (error) => form.setError('server', { message: error.message })
    });
  };
  

  if (error) {
    return <div>An error occurred: {error.message}</div>;
  }
  if (isLoading) {
    return <div>Submitting...</div>;
  }
*/

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        form.handleSubmit();
      }}
    >
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
      <Group justify="flex-end" mt="md">
        <Button
          type="submit"
          >Submit</Button>
      </Group>
    </form>
  )
}