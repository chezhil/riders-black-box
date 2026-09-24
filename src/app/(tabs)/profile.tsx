import { Alert } from 'react-native';

import { ContactsEditor, MedicalEditor } from '@/components/contacts-editor';
import { Button, Card, Field, Screen, T } from '@/components/ui';
import { buildAlertMessage } from '@/lib/alerts';
import { actions, useApp } from '@/lib/store';

export default function Profile() {
  const profile = useApp((s) => s.profile);
  // Re-render the preview when contacts/settings change.
  useApp((s) => s.settings);

  return (
    <Screen>
      <T.Title>Contacts & profile</T.Title>

      <T.Label>Emergency contacts</T.Label>
      <ContactsEditor />

      <T.Label>You</T.Label>
      <Card>
        <Field label="Name" value={profile.name} onChangeText={(name) => actions.updateProfile({ name })} />
        <Field
          label="Phone"
          value={profile.phone}
          keyboardType="phone-pad"
          onChangeText={(phone) => actions.updateProfile({ phone })}
        />
      </Card>

      <T.Label>Medical info card</T.Label>
      <Card>
        <MedicalEditor />
      </Card>

      <Button
        label="Preview alert message"
        icon="eye"
        variant="secondary"
        onPress={() =>
          Alert.alert(
            'What your contacts receive',
            buildAlertMessage('severe', { lat: 12.97159, lng: 77.59456 }),
          )
        }
      />
    </Screen>
  );
}
