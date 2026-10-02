// The running conversation: what each person said, in their language and translated.
// It follows new lines unless the user has scrolled up to read.

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import type { SkipReason } from '../../../shared/protocol.ts';
import { plainLanguageName } from '../language-names.ts';
import type { FeedEntry, Interim } from '../live-session.ts';
import { themedStyles, type } from '../theme.ts';
import { CompactButton } from './Button.tsx';
import { Icon } from './Icon.tsx';

/** Keep following new lines only when the user has not scrolled up to read. */
const FOLLOW_WITHIN = 80;

type Row =
  | { kind: 'entry'; key: string; entry: FeedEntry }
  | { kind: 'more'; key: string; run: string; hidden: number; open: boolean };

/**
 * Of several skipped lines in a row only the latest shows, after a button that shows the
 * others, so that noise does not push the conversation off the screen. Runs are known by
 * the id of their first line.
 */
function feedRows(entries: readonly FeedEntry[], openRuns: ReadonlySet<string>): Row[] {
  const rows: Row[] = [];
  let run: FeedEntry[] = [];
  const endRun = () => {
    const first = run[0];
    if (first === undefined) return;
    const open = openRuns.has(first.id);
    if (run.length > 1) rows.push({ kind: 'more', key: `more:${first.id}`, run: first.id, hidden: run.length - 1, open });
    for (const entry of open ? run : run.slice(-1)) rows.push({ kind: 'entry', key: entry.id, entry });
    run = [];
  };
  for (const entry of entries) {
    if (entry.skipped) {
      run.push(entry);
      continue;
    }
    endRun();
    rows.push({ kind: 'entry', key: entry.id, entry });
  }
  endRun();
  return rows;
}

interface FeedProps {
  entries: readonly FeedEntry[];
  interims: readonly Interim[];
  /** Shown until someone speaks. */
  placeholder: string;
  /** Translate something that was skipped. */
  onTranslate(id: string): void;
}

export function Feed({ entries, interims, placeholder, onTranslate }: FeedProps) {
  const { styles, palette } = useStyles();
  const list = useRef<FlatList<Row>>(null);
  const following = useRef(true);
  const [openRuns, setOpenRuns] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => feedRows(entries, openRuns), [entries, openRuns]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    following.current = contentSize.height - contentOffset.y - layoutMeasurement.height <= FOLLOW_WITHIN;
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (following.current) list.current?.scrollToEnd({ animated: true });
  }, []);
  const toggleRun = useCallback((run: string) => {
    setOpenRuns((current) => {
      const next = new Set(current);
      if (!next.delete(run)) next.add(run);
      return next;
    });
  }, []);
  const renderRow = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === 'more') {
        return (
          <CompactButton
            label={item.open ? 'Show fewer' : `${item.hidden} more not translated`}
            icon={item.open ? 'chevron-up' : 'chevron-down'}
            accessibilityState={{ expanded: item.open }}
            onPress={() => toggleRun(item.run)}
            style={styles.more}
          />
        );
      }
      return item.entry.skipped ? <Skipped entry={item.entry} onTranslate={onTranslate} /> : <Bubble entry={item.entry} />;
    },
    [onTranslate, toggleRun, styles.more],
  );

  if (rows.length === 0 && interims.length === 0) {
    return (
      <View style={styles.empty}>
        <Icon name="messages-square" size={36} color={palette.muted} />
        <Text style={styles.emptyText}>{placeholder}</Text>
      </View>
    );
  }
  return (
    <FlatList
      ref={list}
      style={styles.feed}
      contentContainerStyle={styles.content}
      data={rows}
      keyExtractor={keyOf}
      renderItem={renderRow}
      ItemSeparatorComponent={Gap}
      ListFooterComponent={interims.length > 0 ? <Captions interims={interims} spaced={rows.length > 0} /> : null}
      onScroll={onScroll}
      scrollEventThrottle={100}
      onContentSizeChange={onContentSizeChange}
      accessibilityLabel="Conversation"
    />
  );
}

function keyOf(row: Row): string {
  return row.key;
}

function Gap() {
  const { styles } = useStyles();
  return <View style={styles.gap} />;
}

/** Entries are replaced, never changed, so a new object means a change. */
const Bubble = memo(function Bubble({ entry }: { entry: FeedEntry }) {
  const { styles } = useStyles();
  const { translation, mine } = entry;
  // For what others said, their words in my language matter most.
  const translationFirst = !mine && translation !== undefined;
  const original = (
    <Text style={translationFirst ? styles.second : styles.first} selectable>
      {entry.text}
    </Text>
  );
  let translated = null;
  if (translation) {
    const { state, text } = translation;
    const shown = state === 'pending' ? 'Translating…' : state === 'empty' ? '(nothing to translate)' : text;
    translated = (
      <Text
        selectable
        style={[
          translationFirst ? styles.first : styles.second,
          (state === 'pending' || state === 'empty') && styles.quiet,
          state === 'pending' && styles.italic,
          state === 'failed' && styles.failed,
        ]}
      >
        {shown}
        {state === 'interrupted' && ' (cut off)'}
      </Text>
    );
  }
  return (
    <View style={[styles.row, mine && styles.rowMine]}>
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
        <Text style={styles.who}>{`${entry.speaker} · ${plainLanguageName(entry.lang)}`}</Text>
        {translationFirst ? translated : original}
        {translationFirst ? original : translated}
      </View>
    </View>
  );
});

const SKIP_REASONS: Readonly<Record<Exclude<SkipReason, 'language'>, string>> = {
  distant: 'far away',
  voice: 'another voice',
};

/** Something heard but not translated: too far away, another voice or another language. */
const Skipped = memo(function Skipped({ entry, onTranslate }: { entry: FeedEntry; onTranslate(id: string): void }) {
  const { styles, palette } = useStyles();
  const skipped = entry.skipped;
  if (!skipped) return null;
  const accepting = skipped.state === 'accepting';
  const why = skipped.reason === 'language' ? plainLanguageName(entry.lang) : SKIP_REASONS[skipped.reason];
  return (
    <View style={styles.skipped}>
      <Icon name={accepting ? 'languages' : 'ear-off'} size={22} color={palette.idle} />
      <View style={styles.skippedTexts}>
        <Text style={styles.skippedWhy}>{accepting ? 'Translating…' : `Not translated · ${why}`}</Text>
        <Text style={styles.skippedWords}>{entry.text}</Text>
      </View>
      {skipped.state === 'skipped' && (
        <CompactButton
          label="Translate"
          icon="languages"
          accessibilityLabel={`Translate “${entry.text}”`}
          onPress={() => onTranslate(entry.id)}
        />
      )}
    </View>
  );
});

/** What someone is saying right now, before it is finished. */
function Captions({ interims, spaced }: { interims: readonly Interim[]; spaced: boolean }) {
  const { styles } = useStyles();
  return (
    // Live, unfinished words: too jumpy for screen readers.
    <View
      style={[styles.captions, spaced && styles.captionsSpaced]}
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
    >
      {interims.map((interim) => (
        <View key={interim.key} style={[styles.row, interim.mine && styles.rowMine]}>
          <View style={[styles.caption, interim.mine && styles.captionMine]}>
            <Text style={styles.who}>{`${interim.speaker} · still talking…`}</Text>
            <Text style={styles.captionWords}>{interim.text}</Text>
          </View>
        </View>
      ))}
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  feed: {
    flex: 1,
  },
  content: {
    paddingVertical: 4,
  },
  gap: {
    height: 12,
  },
  empty: {
    flex: 1,
    alignItems: 'center',
    gap: 12,
    padding: 24,
  },
  emptyText: {
    ...type.body,
    maxWidth: 360,
    color: palette.muted,
    textAlign: 'center',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
  },
  rowMine: {
    justifyContent: 'flex-end',
  },
  bubble: {
    maxWidth: '86%',
    gap: 6,
    paddingVertical: 14,
    paddingHorizontal: 18,
    borderWidth: 2,
  },
  bubbleTheirs: {
    borderColor: palette.border,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 20,
    backgroundColor: palette.surface,
  },
  bubbleMine: {
    borderColor: palette.accentSoft,
    borderTopLeftRadius: 20,
    borderTopRightRadius: 6,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 20,
    backgroundColor: palette.mine,
  },
  who: {
    ...type.smallBold,
    color: palette.muted,
  },
  first: {
    ...type.large,
    color: palette.text,
  },
  second: {
    ...type.secondary,
    color: palette.muted,
  },
  quiet: {
    color: palette.muted,
  },
  italic: {
    fontStyle: 'italic',
  },
  failed: {
    fontWeight: '700',
    color: palette.danger,
  },
  more: {
    alignSelf: 'flex-start',
  },
  skipped: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingTop: 12,
    paddingRight: 12,
    paddingBottom: 12,
    paddingLeft: 16,
    borderRadius: 14,
    backgroundColor: palette.idleSoft,
  },
  skippedTexts: {
    flex: 1,
    gap: 2,
  },
  skippedWhy: {
    ...type.smallBold,
    color: palette.idle,
  },
  skippedWords: {
    ...type.secondary,
    fontStyle: 'italic',
    color: palette.idle,
  },
  captions: {
    gap: 12,
  },
  captionsSpaced: {
    marginTop: 12,
  },
  caption: {
    maxWidth: '86%',
    gap: 4,
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderTopLeftRadius: 6,
    borderTopRightRadius: 20,
    borderBottomRightRadius: 20,
    borderBottomLeftRadius: 20,
    backgroundColor: palette.surface2,
  },
  captionMine: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 6,
  },
  captionWords: {
    ...type.body,
    fontStyle: 'italic',
    color: palette.muted,
  },
}));
