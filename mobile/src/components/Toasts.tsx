// Short messages near the top of a conversation; they go away by themselves.

import { Text, View } from 'react-native';

import type { Toast } from '../live-session.ts';
import { themedStyles, type } from '../theme.ts';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';

/** An icon that hints at what the message is about; the order matters. */
function toastIcon(message: string): IconName {
  if (/^Earphones connected/.test(message)) return 'headphones';
  if (/disconnected|No earphones/.test(message)) return 'speaker';
  if (/microphone/i.test(message)) return 'mic';
  if (/voice/i.test(message)) return 'volume-2';
  if (/copied/.test(message)) return 'check';
  if (/joined\.$/.test(message)) return 'user-plus';
  if (/left\.$/.test(message)) return 'log-out';
  return 'info';
}

export function Toasts({ toasts, top }: { toasts: readonly Toast[]; top: number }) {
  const { styles, palette } = useStyles();
  if (toasts.length === 0) return null;
  return (
    <View style={[styles.toasts, { top }]}>
      {toasts.slice(-3).map((toast) => (
        <View key={toast.id} style={styles.toast} accessible accessibilityRole="alert" accessibilityLiveRegion="polite">
          <Icon name={toastIcon(toast.message)} size={24} color={palette.toastText} />
          <Text style={styles.text}>{toast.message}</Text>
        </View>
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
    gap: 8,
    pointerEvents: 'none',
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderRadius: 16,
    backgroundColor: palette.toastBg,
    elevation: 6,
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 6 },
  },
  text: {
    ...type.secondary,
    flex: 1,
    color: palette.toastText,
  },
}));
