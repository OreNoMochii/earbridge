// Asks for the name of someone whose voice print is to be kept on the phone, and whether
// they agree: their voice print is about them, so it is kept only with their OK.

import { useState } from 'react';
import { KeyboardAvoidingView, Modal, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NAME_LENGTH } from '../engines/voices.ts';
import { RADIUS_LG, themedStyles, type } from '../theme.ts';
import { ErrorText } from './Basics.tsx';
import { Button } from './Button.tsx';
import { SwitchRow } from './Choices.tsx';
import { TextField } from './Field.tsx';
import type { IconName } from './Icon.tsx';

interface PersonDialogProps {
  title: string;
  /** The button that goes on, e.g. Save. */
  go: { label: string; icon: IconName };
  /** Names already saved: one of them is replaced. */
  taken: readonly string[];
  /** False when it did not work: the dialog stays, and says so. */
  onGo(name: string): boolean | Promise<boolean>;
  onCancel(): void;
}

export function PersonDialog({ title, go, taken, onGo, onCancel }: PersonDialogProps) {
  const { styles } = useStyles();
  const insets = useSafeAreaInsets();
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const trimmed = name.trim();
  const same = taken.find((other) => other.toLocaleLowerCase() === trimmed.toLocaleLowerCase());

  const submit = async () => {
    if (!trimmed || !agreed || busy) return;
    setBusy(true);
    setFailed(false);
    const done = await onGo(trimmed);
    setBusy(false);
    setFailed(!done);
  };

  // Padding on Android too: drawn edge to edge, the window does not shrink for the keyboard.
  return (
    <Modal visible transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onCancel}>
      <KeyboardAvoidingView behavior="padding" style={[styles.scrim, { paddingTop: insets.top }]}>
        <ScrollView contentContainerStyle={[styles.center, { paddingBottom: insets.bottom + 20 }]} keyboardShouldPersistTaps="handled">
          <View style={styles.card} accessibilityViewIsModal>
            <Text style={styles.title} accessibilityRole="header">
              {title}
            </Text>
            <TextField
              label="Their name"
              value={name}
              onChangeText={setName}
              hint={same ? `Replaces the voice saved as ${same}.` : undefined}
              maxLength={NAME_LENGTH}
              autoCapitalize="words"
              autoCorrect={false}
              autoComplete="off"
              autoFocus
              returnKeyType="done"
            />
            <SwitchRow
              title="They agree"
              description="To their voice print being kept on this phone, until you delete it."
              value={agreed}
              onChange={setAgreed}
            />
            {failed && <ErrorText>Couldn’t save it on this phone. Try again.</ErrorText>}
            <Button
              kind="primary"
              label={go.label}
              icon={go.icon}
              disabled={!trimmed || !agreed || busy}
              onPress={() => void submit()}
            />
            <Button label="Cancel" icon="x" onPress={onCancel} />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const useStyles = themedStyles((palette) => ({
  scrim: {
    flex: 1,
    backgroundColor: palette.scrim,
  },
  center: {
    flexGrow: 1,
    justifyContent: 'center',
    padding: 20,
  },
  card: {
    width: '100%',
    maxWidth: 480,
    alignSelf: 'center',
    gap: 16,
    padding: 24,
    borderRadius: RADIUS_LG,
    backgroundColor: palette.surface,
    elevation: 12,
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 12 },
  },
  title: {
    ...type.heading,
    color: palette.text,
  },
}));
