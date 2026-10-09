// One phone, where it is too loud for the filters to tell the two people from the others:
// the advice to hold a button while talking, and a way to switch to that.

import { Text, View } from 'react-native';

import { themedStyles, type } from '../theme.ts';
import { CompactButton } from './Button.tsx';
import { Icon } from './Icon.tsx';

export function LoudHint({ onHold, onClose }: { onHold(): void; onClose(): void }) {
  const { styles, palette } = useStyles();
  return (
    <View style={styles.card} accessibilityLiveRegion="polite">
      <View style={styles.head}>
        <Icon name="volume-2" size={24} color={palette.busy} />
        <Text style={styles.title}>It’s loud here</Text>
      </View>
      <Text style={styles.text}>Hold a button to talk, with the phone close to whoever speaks.</Text>
      <View style={styles.buttons}>
        <CompactButton label="Hold to talk" icon="hand" onPress={onHold} style={styles.button} />
        <CompactButton label="Not now" onPress={onClose} style={styles.button} />
      </View>
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  card: {
    gap: 10,
    padding: 14,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 16,
    backgroundColor: palette.surface,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  title: {
    ...type.bodyBold,
    flex: 1,
    color: palette.text,
  },
  text: {
    ...type.secondary,
    color: palette.text,
  },
  buttons: {
    flexDirection: 'row',
    gap: 10,
  },
  button: {
    flex: 1,
  },
}));
