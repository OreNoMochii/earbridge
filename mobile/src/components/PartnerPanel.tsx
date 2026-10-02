// One phone: the latest translation for the other person, in large type. Turn around
// shows it upside down, for someone sitting across.

import { useEffect, useRef, useState } from 'react';
import { Animated, ScrollView, Text, View, useWindowDimensions } from 'react-native';

import { plainLanguageName } from '../language-names.ts';
import type { PartnerView } from '../live-session.ts';
import { RADIUS_LG, themedStyles, type } from '../theme.ts';
import { CompactButton } from './Button.tsx';

export function PartnerPanel({ partner, lang }: { partner: PartnerView; lang: string }) {
  const { styles } = useStyles();
  const { height } = useWindowDimensions();
  const [turned, setTurned] = useState(false);
  const [turn] = useState(() => new Animated.Value(0));
  const scroll = useRef<ScrollView>(null);
  useEffect(() => {
    Animated.timing(turn, { toValue: turned ? 1 : 0, duration: 350, useNativeDriver: true }).start();
  }, [turned, turn]);

  const waiting = partner.state === 'waiting';
  // A sign rather than words: the person reading may not know English.
  const text = waiting ? 'Waiting for you to speak…' : partner.state === 'failed' ? '⚠︎' : partner.text || '…';
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });
  const language = plainLanguageName(lang);
  return (
    <Animated.View style={[styles.panel, { maxHeight: height * 0.38, transform: [{ rotate }] }]}>
      <View style={styles.head}>
        <Text style={styles.for}>For them, in {language}</Text>
        <CompactButton
          label="Turn around"
          icon="refresh-ccw"
          onPress={() => setTurned((value) => !value)}
          accessibilityHint="Turns this text upside down, for the person facing you"
          accessibilityState={{ selected: turned }}
        />
      </View>
      <ScrollView style={styles.scroll} onContentSizeChange={() => scroll.current?.scrollToEnd({ animated: true })} ref={scroll}>
        <Text
          style={waiting ? styles.waiting : styles.text}
          accessibilityLabel={partner.state === 'failed' ? 'The translation failed' : undefined}
          accessibilityLiveRegion="polite"
        >
          {text}
        </Text>
      </ScrollView>
    </Animated.View>
  );
}

const useStyles = themedStyles((palette) => ({
  panel: {
    gap: 8,
    paddingTop: 14,
    paddingRight: 16,
    paddingBottom: 20,
    paddingLeft: 20,
    borderWidth: 2,
    borderColor: palette.accent,
    borderRadius: RADIUS_LG,
    backgroundColor: palette.surface,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  for: {
    ...type.smallBold,
    flexShrink: 1,
    color: palette.muted,
  },
  scroll: {
    flexGrow: 0,
  },
  text: {
    ...type.partner,
    color: palette.text,
  },
  waiting: {
    ...type.heading,
    fontWeight: '400',
    color: palette.muted,
  },
}));
