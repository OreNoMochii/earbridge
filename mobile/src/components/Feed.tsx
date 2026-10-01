// The running conversation: what each person said, in their language and translated.
// It follows new lines unless the user has scrolled up to read.

import { memo, useCallback, useRef } from 'react';
import { FlatList, Text, View } from 'react-native';
import type { NativeScrollEvent, NativeSyntheticEvent } from 'react-native';

import { plainLanguageName } from '../language-names.ts';
import type { FeedEntry, Interim } from '../live-session.ts';
import { RADIUS, themedStyles } from '../theme.ts';

/** Keep following new lines only when the user has not scrolled up to read. */
const FOLLOW_WITHIN = 80;

interface FeedProps {
  entries: readonly FeedEntry[];
  interims: readonly Interim[];
  /** Shown until someone speaks. */
  placeholder: string;
}

export function Feed({ entries, interims, placeholder }: FeedProps) {
  const { styles } = useStyles();
  const list = useRef<FlatList<FeedEntry>>(null);
  const following = useRef(true);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    following.current = contentSize.height - contentOffset.y - layoutMeasurement.height <= FOLLOW_WITHIN;
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (following.current) list.current?.scrollToEnd({ animated: true });
  }, []);

  const empty = entries.length === 0 && interims.length === 0;
  return (
    <FlatList
      ref={list}
      style={styles.feed}
      contentContainerStyle={styles.content}
      data={entries}
      keyExtractor={keyOf}
      renderItem={renderEntry}
      ListHeaderComponent={empty ? <Text style={styles.empty}>{placeholder}</Text> : null}
      ListFooterComponent={interims.length > 0 ? <Interims interims={interims} /> : null}
      onScroll={onScroll}
      scrollEventThrottle={100}
      onContentSizeChange={onContentSizeChange}
      accessibilityLabel="Conversation"
    />
  );
}

function keyOf(entry: FeedEntry): string {
  return entry.id;
}

function renderEntry({ item }: { item: FeedEntry }) {
  return <Entry entry={item} />;
}

/** Entries are replaced, never changed, so a new object means a change. */
const Entry = memo(function Entry({ entry }: { entry: FeedEntry }) {
  const { styles } = useStyles();
  const translation = entry.translation;
  // For what others said, their words in my language matter most.
  const translationFirst = !entry.mine && translation !== undefined;
  const original = (
    <Text style={[styles.original, translationFirst && styles.originalSecondary]} selectable>
      {entry.text}
    </Text>
  );
  let translated = null;
  if (translation) {
    const { state, text } = translation;
    const shown =
      state === 'pending' ? 'Translating…' : state === 'empty' ? '(nothing to translate)' : text;
    translated = (
      <Text
        selectable
        style={[
          styles.translation,
          translationFirst && styles.translationMain,
          (state === 'pending' || state === 'empty') && styles.translationQuiet,
          state === 'streaming' && styles.translationStreaming,
          state === 'failed' && styles.translationFailed,
        ]}
      >
        {shown}
        {state === 'interrupted' && <Text style={styles.cutOff}> (cut off)</Text>}
      </Text>
    );
  }
  return (
    <View style={[styles.entry, entry.mine ? styles.mine : styles.theirs]}>
      <Text style={styles.meta}>{`${entry.speaker} · ${plainLanguageName(entry.lang)}`}</Text>
      {translationFirst ? translated : original}
      {translationFirst ? original : translated}
    </View>
  );
});

function Interims({ interims }: { interims: readonly Interim[] }) {
  const { styles } = useStyles();
  return (
    // Live, unfinished transcripts: too jumpy for screen readers.
    <View style={styles.interims} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {interims.map((interim) => (
        <Text key={interim.key} style={[styles.interim, interim.mine && styles.interimMine]}>
          {`${interim.speaker}: ${interim.text}`}
        </Text>
      ))}
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  feed: {
    flex: 1,
  },
  content: {
    paddingTop: 12,
    paddingBottom: 16,
    paddingHorizontal: 16,
  },
  empty: {
    maxWidth: 352,
    marginVertical: 32,
    alignSelf: 'center',
    color: palette.muted,
    fontSize: 16,
    lineHeight: 23,
    textAlign: 'center',
  },
  entry: {
    maxWidth: '88%',
    marginBottom: 10,
    paddingVertical: 9,
    paddingHorizontal: 13,
    gap: 2,
    borderWidth: 1,
    borderColor: palette.border,
    borderRadius: RADIUS,
  },
  mine: {
    alignSelf: 'flex-end',
    borderBottomRightRadius: 6,
    backgroundColor: palette.mineBg,
  },
  theirs: {
    alignSelf: 'flex-start',
    borderBottomLeftRadius: 6,
    backgroundColor: palette.surface,
  },
  meta: {
    color: palette.muted,
    fontSize: 12,
    fontWeight: '600',
  },
  original: {
    color: palette.text,
    fontSize: 16,
    lineHeight: 22,
  },
  originalSecondary: {
    color: palette.muted,
    fontSize: 14,
    lineHeight: 20,
  },
  translation: {
    color: palette.muted,
    fontSize: 15,
    lineHeight: 21,
  },
  translationMain: {
    color: palette.text,
    fontSize: 18,
    lineHeight: 25,
    fontWeight: '600',
  },
  translationQuiet: {
    color: palette.muted,
    fontStyle: 'italic',
    fontWeight: '400',
  },
  translationStreaming: {
    opacity: 0.85,
  },
  translationFailed: {
    color: palette.danger,
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '500',
  },
  cutOff: {
    color: palette.muted,
    fontSize: 13,
    fontWeight: '400',
  },
  interims: {
    gap: 6,
    marginTop: 4,
  },
  interim: {
    color: palette.muted,
    fontSize: 15,
    fontStyle: 'italic',
  },
  interimMine: {
    textAlign: 'right',
  },
}));
