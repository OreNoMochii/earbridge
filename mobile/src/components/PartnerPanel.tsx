// One-phone mode: the latest translation for the other person, in large type. Flip turns
// it around for someone sitting across.

import { useEffect, useState } from 'react';
import { Animated, ScrollView, Text, View, useWindowDimensions } from 'react-native';

import { languageName } from '../../../shared/languages.ts';
import { nativeLanguageName } from '../language-names.ts';
import type { PartnerView } from '../live-session.ts';
import { RADIUS, themedStyles } from '../theme.ts';
import { Button } from './Button.tsx';

export function PartnerPanel({ partner, lang }: { partner: PartnerView; lang: string }) {
  const { styles } = useStyles();
  const { width, height } = useWindowDimensions();
  const [flipped, setFlipped] = useState(false);
  const [turn] = useState(() => new Animated.Value(0));

  useEffect(() => {
    Animated.timing(turn, { toValue: flipped ? 1 : 0, duration: 350, useNativeDriver: true }).start();
  }, [flipped, turn]);

  const waiting = partner.state === 'waiting';
  const text = waiting ? 'Waiting for you to speak…' : partner.state === 'failed' ? '⚠︎' : partner.text || '…';
  const fontSize = Math.round(Math.min(36, Math.max(22, width * 0.055)));
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '180deg'] });

  return (
    <Animated.View
      style={[styles.partner, { maxHeight: height * 0.38, transform: [{ rotate }] }]}
      accessibilityLabel={`For the other person, in ${languageName(lang)}`}
    >
      <View style={styles.head}>
        <Text style={styles.lang}>{nativeLanguageName(lang) ?? languageName(lang)}</Text>
        <Button
          small
          kind="ghost"
          label="Flip ↻"
          onPress={() => setFlipped((value) => !value)}
          accessibilityLabel="Turn this text around for the person facing you"
        />
      </View>
      <ScrollView style={styles.scroll}>
        <Text
          style={[
            waiting ? styles.placeholder : [styles.text, { fontSize, lineHeight: Math.round(fontSize * 1.25) }],
            partner.state === 'streaming' && styles.streaming,
          ]}
          accessibilityLiveRegion="polite"
        >
          {text}
        </Text>
      </ScrollView>
    </Animated.View>
  );
}

const useStyles = themedStyles((palette) => ({
  partner: {
    marginTop: 12,
    marginHorizontal: 16,
    paddingTop: 4,
    paddingBottom: 16,
    paddingHorizontal: 16,
    borderRadius: RADIUS,
    backgroundColor: palette.accentSoft,
  },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginRight: -12,
  },
  lang: {
    color: palette.accentStrong,
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  scroll: {
    flexGrow: 0,
  },
  text: {
    color: palette.text,
    fontWeight: '600',
  },
  placeholder: {
    color: palette.muted,
    fontSize: 16,
  },
  streaming: {
    opacity: 0.8,
  },
}));
