// Choosing a language: the common ones first, then the others, each in its own name and
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

const COMMON = known(['en-US', 'en-GB', 'es', 'fr', 'de', 'it', 'pt-BR', 'ja', 'ko', 'zh-CN', 'zh-TW', 'hi', 'ar']);
const OTHERS = othersThan(COMMON);
/** Fewer common ones where the list is part of a page, like in the setup. */
const FEW = known(['ja', 'es', 'fr', 'de', 'zh-CN', 'ko', 'ar']);
const NOT_FEW = othersThan(FEW);

function known(codes: readonly string[]): string[] {
  return codes.filter((code) => LANGUAGES.some((language) => language.code === code));
}

/** The rest, by their English name. */
function othersThan(codes: readonly string[]): string[] {
  return LANGUAGES.filter((language) => !codes.includes(language.code))
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .map((language) => language.code);
}

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
  // Also for English, so that every language looks the same.
  const second = detail ?? languageName(code);
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
        <Text style={styles.english}>{second}</Text>
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
  onSelectedLayout?: ((y: number, height: number) => void) | undefined;
  /** Left out, with its other variants: e.g. my own language, when choosing theirs. */
  exclude?: string | undefined;
  /** Fewer common languages, under a title: on a page that asks for a language. */
  titled?: boolean;
}

/** All languages, common ones first; or those that match what was typed. */
export function LanguageRows({ query, value, onSelect, onSelectedLayout, exclude, titled = false }: LanguageRowsProps) {
  const { styles } = useStyles();
  const folded = fold(query.trim());
  const shown = (code: string) => exclude === undefined || !sameLanguage(code, exclude);
  const row = (code: string) => (
    <LanguageRow
      key={code}
      code={code}
      selected={code === value}
      onPress={() => onSelect(code)}
      onLayout={
        code === value && onSelectedLayout
          ? (event) => onSelectedLayout(event.nativeEvent.layout.y, event.nativeEvent.layout.height)
          : undefined
      }
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
  const common = (titled ? FEW : COMMON).filter(shown);
  const others = (titled ? NOT_FEW : OTHERS).filter(shown);
  return (
    <View style={styles.rows} accessibilityRole="radiogroup">
      {titled && (
        <Text style={styles.heading} accessibilityRole="header">
          Common languages
        </Text>
      )}
      {common.map(row)}
      <Text style={styles.more}>
        {titled
          ? `Scroll down for all ${common.length + others.length} languages`
          : `…and ${others.length} more. Scroll down, or search.`}
      </Text>
      {others.map(row)}
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
  const shown = useRef(0);
  const rowsTop = useRef(0);
  const scrolled = useRef(false);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  // When the chosen language is further down than the screen, starts with it in view. Once
  // every part of the list has its place.
  const onSelectedLayout = (y: number, height: number) => {
    if (scrolled.current) return;
    scrolled.current = true;
    setTimeout(() => {
      const top = rowsTop.current + y;
      if (top + height > shown.current) scroll.current?.scrollTo({ y: top - 120, animated: false });
    }, 0);
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={[styles.overlay, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}
    >
      <ScrollView
        ref={scroll}
        keyboardShouldPersistTaps="handled"
        onLayout={(event) => (shown.current = event.nativeEvent.layout.height)}
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + 28 }]}
      >
        <View style={styles.header}>
          <Text style={styles.title} accessibilityRole="header">
            {title}
          </Text>
          <CompactButton label="Close" icon="x" onPress={onClose} />
        </View>
        <LanguageSearch value={query} onChange={setQuery} />
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
    gap: 20,
    paddingTop: 12,
    paddingHorizontal: 20,
  },
  rows: {
    gap: 8,
  },
  heading: {
    ...type.secondaryBold,
    color: palette.muted,
  },
  more: {
    ...type.secondary,
    color: palette.muted,
    textAlign: 'center',
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
    paddingVertical: 10,
    paddingHorizontal: 14,
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
