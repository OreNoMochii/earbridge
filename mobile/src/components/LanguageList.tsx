// The full-screen list of languages to pick from. Shown over the setup screen, so it
// shares its safe-area insets; the Android back button closes it.

import { useEffect, useMemo } from 'react';
import { BackHandler, FlatList, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { LANGUAGES } from '../../../shared/languages.ts';
import { languageLabel } from '../language-names.ts';
import { themedStyles } from '../theme.ts';
import { Button } from './Button.tsx';

const SORTED_CODES = [...LANGUAGES].sort((a, b) => a.name.localeCompare(b.name, 'en')).map((language) => language.code);
const ROW_HEIGHT = 52;

interface LanguageListProps {
  title: string;
  value: string;
  onSelect(code: string): void;
  onClose(): void;
}

export function LanguageList({ title, value, onSelect, onClose }: LanguageListProps) {
  const { styles } = useStyles();
  const insets = useSafeAreaInsets();

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  const initialIndex = useMemo(() => Math.max(0, SORTED_CODES.indexOf(value) - 3), [value]);

  return (
    <View style={[styles.screen, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={styles.header}>
        <Text style={styles.title} accessibilityRole="header">
          {title}
        </Text>
        <Button small kind="ghost" label="Close" onPress={onClose} />
      </View>
      <FlatList
        data={SORTED_CODES}
        keyExtractor={(code) => code}
        initialScrollIndex={initialIndex}
        getItemLayout={(_, index) => ({ length: ROW_HEIGHT, offset: ROW_HEIGHT * index, index })}
        contentContainerStyle={{ paddingBottom: insets.bottom + 16 }}
        renderItem={({ item: code }) => {
          const selected = code === value;
          return (
            <Pressable
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => onSelect(code)}
              style={({ pressed }) => [styles.row, selected && styles.rowSelected, pressed && styles.rowPressed]}
            >
              <Text style={[styles.rowText, selected && styles.rowTextSelected]} numberOfLines={1}>
                {languageLabel(code)}
              </Text>
              {selected && <Text style={styles.check}>✓</Text>}
            </Pressable>
          );
        }}
      />
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  screen: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: palette.surface,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 8,
    paddingLeft: 16,
    paddingRight: 8,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  title: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '700',
  },
  row: {
    height: ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
  },
  rowSelected: {
    backgroundColor: palette.accentSoft,
  },
  rowPressed: {
    backgroundColor: palette.surface2,
  },
  rowText: {
    flexShrink: 1,
    color: palette.text,
    fontSize: 16,
  },
  rowTextSelected: {
    fontWeight: '600',
  },
  check: {
    marginLeft: 12,
    color: palette.accent,
    fontSize: 18,
    fontWeight: '700',
  },
}));
