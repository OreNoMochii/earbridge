// Choosing a language: the common ones first, then all of them, each in its own name and
// in English, so the other person can find theirs too. Typing narrows the list down.

import { useEffect, useRef, useState } from 'react';
import { BackHandler, KeyboardAvoidingView, Pressable, ScrollView, Text, View } from 'react-native';
import type { LayoutChangeEvent } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LANGUAGES, languageName, sameLanguage } from '../../../shared/languages.ts';
import { nativeLanguageName } from '../language-names.ts';
import { themedStyles, type } from '../theme.ts';
import { CompactButton } from './Button.tsx';
import { TextField } from './Field.tsx';
import { Icon } from './Icon.tsx';

const COMMON = ['en-US', 'es', 'fr', 'de', 'ja', 'zh-CN', 'ko', 'ar', 'it', 'pt-BR', 'ru', 'hi'].filter((code) =>
  LANGUAGES.some((language) => language.code === code),
);
const OTHERS = LANGUAGES.filter((language) => !COMMON.includes(language.code))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'))
  .map((language) => language.code);

/** Lower case, without accents: "espanol" finds Español. */
function fold(text: string): string {
  const lower = text.toLowerCase();
  try {
    return lower.normalize('NFD').replace(/[̀-ͯ]/g, '');
  } catch {
    return lower;
  }
}

function matches(code: string, query: string): boolean {
  return [languageName(code), nativeLanguageName(code) ?? '', code].some((name) => fold(name).includes(query));
}

interface LanguageRowProps {
  code: string;
  selected: boolean;
  onPress(): void;
  /** Under the name, instead of its English name. */
  detail?: string | undefined;
  onLayout?: ((event: LayoutChangeEvent) => void) | undefined;
}

/** A language in its own name, and in English under it. */
export function LanguageRow({ code, selected, onPress, detail, onLayout }: LanguageRowProps) {
  const { styles, palette } = useStyles();
  const native = nativeLanguageName(code);
  const second = detail ?? (native === undefined ? undefined : languageName(code));
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={[languageName(code), native, detail].filter((part) => part !== undefined).join(', ')}
      onPress={onPress}
      onLayout={onLayout}
      style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.pressed]}
    >
      <View style={styles.texts}>
        <Text style={styles.native}>{native ?? languageName(code)}</Text>
        {second !== undefined && <Text style={styles.english}>{second}</Text>}
      </View>
      {selected && <Icon name="check" size={28} color={palette.accent} />}
    </Pressable>
  );
}

export function LanguageSearch({ value, onChange, placeholder = 'Type a language' }: { value: string; onChange(text: string): void; placeholder?: string }) {
  return (
    <TextField
      label="Search"
      icon="search"
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="off"
      returnKeyType="search"
    />
  );
}

interface LanguageRowsProps {
  query: string;
  value: string;
  onSelect(code: string): void;
  /** Where the chosen language is, so the list can start there. */
  onSelectedLayout?: ((y: number) => void) | undefined;
  /** Left out, with its other variants: e.g. my own language, when choosing theirs. */
  exclude?: string | undefined;
}

/** All languages, common ones first; or those that match what was typed. */
export function LanguageRows({ query, value, onSelect, onSelectedLayout, exclude }: LanguageRowsProps) {
  const { styles } = useStyles();
  const folded = fold(query.trim());
  const shown = (code: string) => exclude === undefined || !sameLanguage(code, exclude);
  const row = (code: string) => (
    <LanguageRow
      key={code}
      code={code}
      selected={code === value}
      onPress={() => onSelect(code)}
      onLayout={code === value && onSelectedLayout ? (event) => onSelectedLayout(event.nativeEvent.layout.y) : undefined}
    />
  );
  if (folded) {
    const found = [...COMMON, ...OTHERS].filter((code) => shown(code) && matches(code, folded));
    return (
      <View style={styles.rows} accessibilityRole="radiogroup">
        {found.length > 0 ? found.map(row) : <Text style={styles.nothing}>No language matches “{query.trim()}”.</Text>}
      </View>
    );
  }
  return (
    <View style={styles.rows} accessibilityRole="radiogroup">
      <Text style={styles.heading} accessibilityRole="header">
        Common languages
      </Text>
      {COMMON.filter(shown).map(row)}
      <Text style={[styles.heading, styles.headingSpaced]} accessibilityRole="header">
        All languages
      </Text>
      {OTHERS.filter(shown).map(row)}
    </View>
  );
}

interface LanguageListProps {
  title: string;
  value: string;
  onSelect(code: string): void;
  onClose(): void;
}

/** The list over the whole screen; the Android back button closes it. */
export function LanguageList({ title, value, onSelect, onClose }: LanguageListProps) {
  const { styles } = useStyles();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');
  const scroll = useRef<ScrollView>(null);
  const rowsTop = useRef(0);
  const scrolled = useRef(false);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  // Starts with the chosen language in view, a little below the top.
  const onSelectedLayout = (y: number) => {
    if (scrolled.current) return;
    scrolled.current = true;
    const top = rowsTop.current + y - 120;
    if (top > 0) scroll.current?.scrollTo({ y: top, animated: false });
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.overlay, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}
    >
      <View style={styles.top}>
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          <CompactButton label="Close" icon="x" onPress={onClose} />
        </View>
        <LanguageSearch value={query} onChange={setQuery} />
      </View>
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 28 }]}
      >
        <View onLayout={(event) => (rowsTop.current = event.nativeEvent.layout.y)}>
          <LanguageRows query={query} value={value} onSelect={onSelect} onSelectedLayout={onSelectedLayout} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = themedStyles((palette) => ({
  overlay: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 20,
    backgroundColor: palette.bg,
  },
  top: {
    gap: 20,
    paddingTop: 12,
    paddingHorizontal: 20,
    paddingBottom: 12,
    borderBottomWidth: 2,
    borderBottomColor: palette.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  title: {
    ...type.title,
    flex: 1,
    color: palette.text,
  },
  list: {
    paddingTop: 16,
    paddingHorizontal: 20,
  },
  rows: {
    gap: 8,
  },
  heading: {
    ...type.secondaryBold,
    color: palette.muted,
  },
  headingSpaced: {
    marginTop: 12,
  },
  nothing: {
    ...type.body,
    paddingVertical: 16,
    color: palette.muted,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 2,
    borderColor: 'transparent',
    borderRadius: 14,
    backgroundColor: palette.surface,
  },
  rowSelected: {
    borderColor: palette.accent,
    backgroundColor: palette.accentSoft,
  },
  pressed: {
    opacity: 0.75,
  },
  texts: {
    flex: 1,
    gap: 2,
  },
  native: {
    ...type.largeBold,
    color: palette.text,
  },
  english: {
    ...type.secondary,
    color: palette.muted,
  },
}));
