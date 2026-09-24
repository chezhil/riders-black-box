import { Ionicons } from '@expo/vector-icons';
import { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';

import { Colors, Spacing } from '@/constants/theme';
import { actions, newId, useApp } from '@/lib/store';
import type { EmergencyContact } from '@/lib/types';

import { Button, Card, Field, Row, T } from './ui';

const MAX_CONTACTS = 5;
const EMPTY = { name: '', phone: '', relationship: '' };

export function ContactsEditor() {
  const contacts = useApp((s) => s.contacts);
  const [editing, setEditing] = useState<EmergencyContact | null>(null);
  const [draft, setDraft] = useState(EMPTY);
  const [open, setOpen] = useState(false);

  function startAdd() {
    setEditing(null);
    setDraft(EMPTY);
    setOpen(true);
  }

  function startEdit(c: EmergencyContact) {
    setEditing(c);
    setDraft({ name: c.name, phone: c.phone, relationship: c.relationship });
    setOpen(true);
  }

  function save() {
    const phone = draft.phone.replace(/[^\d+]/g, '');
    if (!draft.name.trim() || phone.length < 8) {
      Alert.alert('Missing details', 'Add a name and a valid phone number.');
      return;
    }
    actions.upsertContact({
      id: editing?.id ?? newId(),
      name: draft.name.trim(),
      phone,
      relationship: draft.relationship.trim(),
    });
    setOpen(false);
  }

  function remove(c: EmergencyContact) {
    Alert.alert(`Remove ${c.name}?`, 'They will no longer be alerted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => actions.removeContact(c.id) },
    ]);
  }

  return (
    <View style={{ gap: Spacing.sm }}>
      {contacts.map((c) => (
        <Card key={c.id} onPress={() => startEdit(c)} style={{ paddingVertical: Spacing.md }}>
          <Row gap={Spacing.md}>
            <Ionicons name="person-circle" size={36} color={Colors.accent} />
            <View style={{ flex: 1 }}>
              <T.Body style={{ fontWeight: '700' }}>{c.name}</T.Body>
              <T.Dim>
                {c.phone}
                {c.relationship ? ` · ${c.relationship}` : ''}
              </T.Dim>
            </View>
            <Pressable hitSlop={12} onPress={() => remove(c)} accessibilityLabel={`Remove ${c.name}`}>
              <Ionicons name="trash-outline" size={20} color={Colors.textDim} />
            </Pressable>
          </Row>
        </Card>
      ))}

      {open ? (
        <Card style={{ borderColor: Colors.accent }}>
          <T.H2>{editing ? 'Edit contact' : 'New emergency contact'}</T.H2>
          <Field
            label="Name"
            value={draft.name}
            onChangeText={(name) => setDraft({ ...draft, name })}
            placeholder="e.g. Priya Sharma"
            autoCapitalize="words"
          />
          <Field
            label="Phone"
            value={draft.phone}
            onChangeText={(phone) => setDraft({ ...draft, phone })}
            placeholder="+91 98765 43210"
            keyboardType="phone-pad"
            hint="Include the country code so SMS works from anywhere."
          />
          <Field
            label="Relationship"
            value={draft.relationship}
            onChangeText={(relationship) => setDraft({ ...draft, relationship })}
            placeholder="e.g. Sister, Friend, Spouse"
            autoCapitalize="words"
          />
          <Row>
            <Button label="Cancel" variant="secondary" style={{ flex: 1 }} onPress={() => setOpen(false)} />
            <Button label="Save" style={{ flex: 1 }} onPress={save} />
          </Row>
        </Card>
      ) : (
        contacts.length < MAX_CONTACTS && (
          <Button label="Add emergency contact" icon="person-add" variant="secondary" onPress={startAdd} />
        )
      )}
    </View>
  );
}

export function MedicalEditor() {
  const profile = useApp((s) => s.profile);
  const m = profile.medical;
  const set = (patch: Partial<typeof m>) => actions.updateProfile({ medical: { ...m, ...patch } });
  return (
    <View style={{ gap: Spacing.md }}>
      <Field
        label="Blood group"
        value={m.bloodGroup}
        onChangeText={(bloodGroup) => set({ bloodGroup })}
        placeholder="e.g. B+"
        autoCapitalize="characters"
      />
      <Field
        label="Allergies"
        value={m.allergies}
        onChangeText={(allergies) => set({ allergies })}
        placeholder="e.g. Penicillin"
      />
      <Field
        label="Existing conditions / medication"
        value={m.conditions}
        onChangeText={(conditions) => set({ conditions })}
        placeholder="e.g. Asthma, diabetes"
        multiline
      />
    </View>
  );
}
