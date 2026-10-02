// The frame of every screen outside a conversation: room for the status bar and the
// keyboard, a scrolling column no wider than a phone, and an optional bar fixed at the
// bottom, e.g. for Next. Also the setup's step header and a download's progress.

import { createContext, useContext, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { KeyboardAvoidingView, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { themedStyles, type } from '../theme.ts';
import { CompactButton } from './Button.tsx';
import { Icon } from './Icon.tsx';

/** The first-time setup's steps. */
export const SETUP_STEPS = 4;

/** Space above the column, inside the scrolling part. */
const TOP = 12;
/** Space kept between the field being typed in and the keyboard. */
const ROOM = 16;

type KeepInView = (area: RefObject<View | null>, focused: boolean) => void;

const KeepInViewContext = createContext<KeepInView>(() => {});

/**
 * For a field's focus and blur: while it has the keyboard, the Screen keeps all of `area`
 * above it, e.g. the field's border, hint and buttons. Android only brings up the line
 * being typed in.
 */
export function useKeepInView(): KeepInView {
  return useContext(KeepInViewContext);
}

interface ScreenProps {
  children: ReactNode;
  /** The content fills the screen, so its last part sits at the bottom. */
  fixed?: boolean;
  /** Stays at the bottom while the rest scrolls. */
  footer?: ReactNode;
  gap?: number;
}

export function Screen({ children, fixed = false, footer, gap = 24 }: ScreenProps) {
  const { styles } = useStyles();
  const insets = useSafeAreaInsets();
  const scroll = useRef<ScrollView>(null);
  const column = useRef<View>(null);
  // How far down it is scrolled, and how much of it shows.
  const scrolled = useRef(0);
  const shown = useRef(0);
  const typing = useRef<RefObject<View | null>>(null);

  /** Scrolls down just enough for the field being typed in to show whole. */
  const reveal = () => {
    const area = typing.current?.current;
    const base = column.current;
    if (!area || !base) return;
    area.measureLayout(base, (_left, y, _width, height) => {
      const top = TOP + y;
      const bottom = top + height + ROOM;
      if (bottom <= scrolled.current + shown.current) return;
      // One taller than what shows keeps its top in view.
      scroll.current?.scrollTo({ y: Math.min(top, bottom - shown.current), animated: true });
    });
  };

  const keepInView: KeepInView = (area, focused) => {
    if (focused) {
      typing.current = area;
      // When moving from field to field with the keyboard up. Once drawn as focused.
      setTimeout(reveal, 0);
    } else if (typing.current === area) {
      typing.current = null;
    }
  };

  // Padding on Android too: drawn edge to edge, the window no longer shrinks for the
  // keyboard, so a field near the bottom would stay under it.
  return (
    <KeepInViewContext value={keepInView}>
      <KeyboardAvoidingView
        behavior="padding"
        style={[styles.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}
      >
        <ScrollView
          ref={scroll}
          keyboardShouldPersistTaps="handled"
          scrollEventThrottle={16}
          onScroll={(event) => {
            scrolled.current = event.nativeEvent.contentOffset.y;
          }}
          onLayout={(event) => {
            const { height } = event.nativeEvent.layout;
            const shorter = height < shown.current;
            shown.current = height;
            // Made room for the keyboard.
            if (shorter) reveal();
          }}
          contentContainerStyle={[styles.content, { paddingBottom: footer === undefined ? insets.bottom + 28 : 20 }]}
        >
          <View ref={column} style={[styles.column, { gap }, fixed && styles.fixed]}>
            {children}
          </View>
        </ScrollView>
        {footer !== undefined && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 16 }]}>
            <View style={styles.footerColumn}>{footer}</View>
          </View>
        )}
      </KeyboardAvoidingView>
    </KeepInViewContext>
  );
}

/** "Step 2 of 4", with a bar per step, and Back after the first. */
export function WizardHeader({ step, onBack }: { step: number; onBack?: (() => void) | undefined }) {
  const { styles } = useStyles();
  return (
    <View style={styles.wizardHeader}>
      {onBack !== undefined && <CompactButton label="Back" icon="chevron-left" onPress={onBack} />}
      <View style={styles.steps} accessible accessibilityLabel={`Step ${step} of ${SETUP_STEPS}`}>
        <Text style={styles.stepText}>
          Step {step} of {SETUP_STEPS}
        </Text>
        <View style={styles.bars}>
          {Array.from({ length: SETUP_STEPS }, (_, index) => (
            <View key={index} style={[styles.bar, index < step && styles.barDone]} />
          ))}
        </View>
      </View>
    </View>
  );
}

/** A download the conversation waits for, e.g. "Downloading French speech recognition… 40%". */
export function DownloadCard({ text }: { text: string }) {
  const { styles, palette } = useStyles();
  const percent = /(\d+)%$/.exec(text)?.[1];
  return (
    <View style={styles.download} accessible accessibilityLabel={text} accessibilityLiveRegion="polite">
      <View style={styles.downloadHead}>
        <Icon name="download" size={24} color={palette.accent} />
        <Text style={styles.downloadText}>{text.replace(/\s*\d+%$/, '')}</Text>
      </View>
      {percent !== undefined && (
        <View style={styles.track}>
          <View style={[styles.fill, { width: `${Math.min(100, Number(percent))}%` }]} />
        </View>
      )}
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  screen: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  content: {
    flexGrow: 1,
    paddingTop: TOP,
    paddingHorizontal: 20,
  },
  column: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  fixed: {
    flexGrow: 1,
    justifyContent: 'space-between',
  },
  footer: {
    paddingTop: 16,
    paddingHorizontal: 20,
    borderTopWidth: 2,
    borderTopColor: palette.border,
    backgroundColor: palette.bg,
  },
  footerColumn: {
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
  },
  wizardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  steps: {
    flex: 1,
    gap: 8,
  },
  stepText: {
    ...type.secondaryBold,
    color: palette.muted,
  },
  bars: {
    flexDirection: 'row',
    gap: 6,
  },
  bar: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: palette.border,
  },
  barDone: {
    backgroundColor: palette.accent,
  },
  download: {
    gap: 12,
    padding: 16,
    borderWidth: 2,
    borderColor: palette.border,
    borderRadius: 16,
    backgroundColor: palette.surface,
  },
  downloadHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  downloadText: {
    ...type.secondaryBold,
    flex: 1,
    color: palette.text,
  },
  track: {
    height: 12,
    overflow: 'hidden',
    borderRadius: 6,
    backgroundColor: palette.surface2,
  },
  fill: {
    height: 12,
    borderRadius: 6,
    backgroundColor: palette.accent,
  },
}));
