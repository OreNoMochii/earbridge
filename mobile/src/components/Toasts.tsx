import { Text, View } from 'react-native';

import type { Toast } from '../live-session.ts';
import { themedStyles } from '../theme.ts';

/** Short messages over the conversation; they go away by themselves. */
export function Toasts({ toasts, top }: { toasts: readonly Toast[]; top: number }) {
  const { styles } = useStyles();
  if (toasts.length === 0) return null;
  return (
    <View style={[styles.toasts, { top }]} pointerEvents="none">
      {toasts.map((toast) => (
        <Text key={toast.id} style={styles.toast} accessibilityLiveRegion="polite" accessibilityRole="alert">
          {toast.message}
        </Text>
      ))}
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  toasts: {
    position: 'absolute',
    left: 16,
    right: 16,
    zIndex: 10,
    gap: 6,
  },
  toast: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    overflow: 'hidden',
    borderRadius: 12,
    backgroundColor: palette.toastBg,
    color: palette.toastText,
    fontSize: 15,
    lineHeight: 20,
    elevation: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 6 },
  },
}));
