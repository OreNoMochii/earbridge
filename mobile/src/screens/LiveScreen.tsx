// The conversation screen: status, the running transcript, and the talk controls.

import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { Alert, BackHandler, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { languageName } from '../../../shared/languages.ts';
import type { SpeakerSelection } from '../../../shared/protocol.ts';
import { formatRoomCode } from '../../../shared/room-code.ts';
import { Button } from '../components/Button.tsx';
import { Feed } from '../components/Feed.tsx';
import { HoldButton } from '../components/HoldButton.tsx';
import { LevelMeter } from '../components/LevelMeter.tsx';
import { Participants } from '../components/Participants.tsx';
import { PartnerPanel } from '../components/PartnerPanel.tsx';
import { Segmented } from '../components/Segmented.tsx';
import type { Option } from '../components/Segmented.tsx';
import { SharePanel } from '../components/SharePanel.tsx';
import { StatusDot } from '../components/StatusDot.tsx';
import { Toasts } from '../components/Toasts.tsx';
import { nativeLanguageName, shortLanguageLabel } from '../language-names.ts';
import type { LiveSession, LiveState } from '../live-session.ts';
import { themedStyles } from '../theme.ts';

export function LiveScreen({ session }: { session: LiveSession }) {
  const { styles } = useStyles();
  const insets = useSafeAreaInsets();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const subscribeLevel = useCallback((listener: (level: number) => void) => session.subscribeLevel(listener), [session]);
  const solo = session.mode === 'solo';

  // The back button asks first, rather than silently leaving the conversation running.
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      Alert.alert(solo ? 'End the conversation?' : 'Leave the room?', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: solo ? 'End' : 'Leave', style: 'destructive', onPress: () => session.stop() },
      ]);
      return true;
    });
    return () => subscription.remove();
  }, [session, solo]);

  const title = solo
    ? `${shortLanguageLabel(session.myLang)} ⇄ ${shortLanguageLabel(session.theirLang)}`
    : state.roomCode
      ? `Room ${formatRoomCode(state.roomCode)}`
      : 'Room';
  const placeholder = !solo
    ? 'When someone speaks, it appears here in their language and in yours.'
    : session.talkMode === 'hold'
      ? 'Hold your button while you talk. Everything you both say appears here, translated.'
      : 'Start talking. Everything you both say appears here, translated.';

  return (
    <View style={[styles.screen, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={[styles.header, { paddingTop: insets.top + 10 }]}>
        <View style={styles.heading}>
          <Text style={styles.title} numberOfLines={1} accessibilityRole="header">
            {title}
          </Text>
          <View style={styles.status} accessibilityLiveRegion="polite">
            <StatusDot tone={state.status.tone} />
            <Text style={styles.statusText} numberOfLines={1}>
              {state.status.text}
            </Text>
          </View>
        </View>
        <View style={styles.actions}>
          {!solo && (
            <Button
              small
              label="Invite"
              disabled={!state.roomCode}
              active={false}
              onPress={() => session.toggleInvite()}
              accessibilityLabel={state.inviteOpen ? 'Hide the invite' : 'Invite others'}
            />
          )}
          <Button small kind="danger" label={solo ? 'End' : 'Leave'} onPress={() => session.stop()} />
        </View>
      </View>

      {solo && <PartnerPanel partner={state.partner} lang={session.theirLang} />}
      {!solo && state.inviteOpen && state.roomCode && (
        <SharePanel server={session.server} room={state.roomCode} onToast={(message) => session.toast(message)} />
      )}
      {!solo && <Participants participants={state.participants} />}

      <Feed entries={state.entries} interims={state.interims} placeholder={placeholder} />

      <View style={[styles.controls, { paddingBottom: insets.bottom + 12 }]}>
        <View style={styles.micRow}>
          <LevelMeter subscribe={subscribeLevel} mode={state.micMode} />
          <Text style={styles.micLabel} numberOfLines={1}>
            {state.micLabel}
          </Text>
        </View>
        <TalkControls session={session} state={state} />
      </View>

      <Toasts toasts={state.toasts} top={insets.top + 72} />
    </View>
  );
}

function TalkControls({ session, state }: { session: LiveSession; state: LiveState }) {
  const { styles } = useStyles();
  const { myLang, theirLang } = session;
  const solo = session.mode === 'solo';

  if (session.talkMode === 'hold') {
    return (
      <View style={styles.talkRow}>
        {solo ? (
          <>
            <HoldButton
              label="Me"
              detail={nativeLanguageName(myLang) ?? languageName(myLang)}
              pressed={state.holding === 'me'}
              onChange={(pressed) => session.setHolding('me', pressed)}
            />
            <HoldButton
              label="Them"
              detail={nativeLanguageName(theirLang) ?? languageName(theirLang)}
              pressed={state.holding === 'them'}
              onChange={(pressed) => session.setHolding('them', pressed)}
            />
          </>
        ) : (
          <HoldButton
            label="Hold to talk"
            detail="Let go when you’re done"
            pressed={state.holding === 'room'}
            onChange={(pressed) => session.setHolding('room', pressed)}
          />
        )}
      </View>
    );
  }

  const speakers: Option<SpeakerSelection>[] = [
    ...(state.autoDetect ? [{ value: 'auto' as const, label: 'Auto' }] : []),
    { value: 'me', label: `Me · ${shortLanguageLabel(myLang)}` },
    { value: 'them', label: `Them · ${shortLanguageLabel(theirLang)}` },
  ];
  return (
    <View style={styles.talkRow}>
      {solo && (
        <Segmented
          look="bar"
          accessibilityLabel="Who is talking"
          options={speakers}
          value={state.speaker}
          onChange={(speaker) => session.selectSpeaker(speaker)}
        />
      )}
      <Button
        label={state.muted ? 'Unmute' : 'Mute'}
        active={state.muted}
        onPress={() => session.setMuted(!state.muted)}
        style={solo ? styles.mute : styles.muteWide}
      />
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  screen: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingBottom: 10,
    paddingHorizontal: 16,
    borderBottomWidth: 1,
    borderBottomColor: palette.border,
    backgroundColor: palette.surface,
  },
  heading: {
    flexShrink: 1,
  },
  title: {
    color: palette.text,
    fontSize: 18,
    fontWeight: '700',
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  statusText: {
    flexShrink: 1,
    color: palette.muted,
    fontSize: 14,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  controls: {
    gap: 10,
    paddingTop: 10,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
  micRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  micLabel: {
    flexShrink: 1,
    color: palette.muted,
    fontSize: 13,
  },
  talkRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    gap: 10,
  },
  mute: {
    minHeight: 48,
  },
  muteWide: {
    flex: 1,
    minHeight: 48,
  },
}));
