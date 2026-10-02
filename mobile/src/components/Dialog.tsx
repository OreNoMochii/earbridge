// Asks before something that can't be undone, like ending a conversation. Staying is the
// first button; the Android back button stays too.

import { Modal, Text, View } from 'react-native';

import { RADIUS_LG, themedStyles, type } from '../theme.ts';
import { Button } from './Button.tsx';
import type { IconName } from './Icon.tsx';

interface DialogChoice {
  label: string;
  icon: IconName;
}

interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message: string;
  keep: DialogChoice;
  go: DialogChoice;
  onKeep(): void;
  onGo(): void;
}

export function ConfirmDialog({ visible, title, message, keep, go, onKeep, onGo }: ConfirmDialogProps) {
  const { styles } = useStyles();
  return (
    <Modal visible={visible} transparent animationType="fade" statusBarTranslucent navigationBarTranslucent onRequestClose={onKeep}>
      <View style={styles.scrim}>
        <View style={styles.card} accessibilityViewIsModal>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          <Text style={styles.message}>{message}</Text>
          <Button label={keep.label} icon={keep.icon} onPress={onKeep} />
          <Button kind="danger" label={go.label} icon={go.icon} onPress={onGo} />
        </View>
      </View>
    </Modal>
  );
}

const useStyles = themedStyles((palette) => ({
  scrim: {
    flex: 1,
    justifyContent: 'center',
    padding: 20,
    backgroundColor: palette.scrim,
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
  message: {
    ...type.secondary,
    color: palette.muted,
  },
}));
