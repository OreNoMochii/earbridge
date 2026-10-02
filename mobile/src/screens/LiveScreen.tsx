// The conversation: the two languages (or the group), how it's going, the big
// translation for the other person, everything said so far, and the talk controls.

import { useCallback, useState, useSyncExternalStore } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { SpeakerSelection } from '../../../shared/protocol.ts';
import { formatRoomCode } from '../../../shared/room-code.ts';
import { StatusPill } from '../components/Basics.tsx';
import { Button, CompactButton } from '../components/Button.tsx';
import { Segments } from '../components/Choices.tsx';
import type { SegmentOption } from '../components/Choices.tsx';
import { ConfirmDialog } from '../components/Dialog.tsx';
import { Feed } from '../components/Feed.tsx';
import { HoldButton } from '../components/HoldButton.tsx';
import { Icon } from '../components/Icon.tsx';
import { InvitePanel } from '../components/InvitePanel.tsx';
import { LevelBars } from '../components/LevelBars.tsx';
import { PartnerPanel } from '../components/PartnerPanel.tsx';
import { PersonChips } from '../components/PersonChips.tsx';
import { DownloadCard } from '../components/Screen.tsx';
import { Toasts } from '../components/Toasts.tsx';
import { nativeLanguageName, plainLanguageName } from '../language-names.ts';
import type { LiveSession, LiveState } from '../live-session.ts';
import { themedStyles, type } from '../theme.ts';
import { useBackButton } from './parts.tsx';

/** A language in its own words, e.g. "Español". */
function native(code: string): string {
  return nativeLanguageName(code) ?? plainLanguageName(code);
}

export function LiveScreen({ session }: { session: LiveSession }) {
  const { styles, palette } = useStyles();
  const insets = useSafeAreaInsets();
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const subscribeLevel = useCallback((listener: (level: number) => void) => session.subscribeLevel(listener), [session]);
  const [confirming, setConfirming] = useState(false);

  useBackButton(() => {
    setConfirming(true);
    return true;
  });

  const solo = session.mode === 'solo';
  const hold = session.talkMode === 'hold';
  const { status } = state;
  const downloading = status.tone === 'busy' && /ownloading/.test(status.text);
  const pill = downloading ? { text: 'Getting ready…', tone: status.tone } : status;

  const placeholder = !solo
    ? 'When someone speaks, it appears here in their language and in yours.'
    : hold
      ? 'Hold your button while you talk. Everything you both say appears here, translated.'
      : 'Start talking. Everything you both say appears here, translated.';

  const feed = (
    <Feed entries={state.entries} interims={state.interims} placeholder={placeholder} onTranslate={(id) => session.accept(id)} />
  );

  return (
    <View style={[styles.screen, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={[styles.body, { paddingTop: insets.top + 12 }]}>
        {solo ? (
          <View style={styles.top}>
            <View style={styles.topText}>
              <View
                style={styles.languages}
                accessible
                accessibilityRole="header"
                accessibilityLabel={`${plainLanguageName(session.myLang)} and ${plainLanguageName(session.theirLang)}`}
              >
                <Text style={styles.language} numberOfLines={1}>
                  {native(session.myLang)}
                </Text>
                <Icon name="arrow-left-right" size={22} color={palette.muted} />
                <Text style={styles.language} numberOfLines={1}>
                  {native(session.theirLang)}
                </Text>
              </View>
              <Status text={pill.text} tone={pill.tone} />
            </View>
            <CompactButton
              kind="danger"
              label="End"
              icon="x"
              accessibilityLabel="End the conversation"
              onPress={() => setConfirming(true)}
            />
          </View>
        ) : (
          <View style={styles.groupTop}>
            <View style={styles.groupHead}>
              <Text style={styles.groupTitle} numberOfLines={1} accessibilityRole="header">
                {state.roomCode ? `Group ${formatRoomCode(state.roomCode)}` : 'Group'}
              </Text>
              <CompactButton
                kind="danger"
                label="Leave"
                icon="log-out"
                accessibilityLabel="Leave the group"
                onPress={() => setConfirming(true)}
              />
            </View>
            <View style={styles.groupHead}>
              <Status text={pill.text} tone={pill.tone} />
              <CompactButton
                kind={state.inviteOpen ? 'active' : 'plain'}
                label={state.inviteOpen ? 'Hide invite' : 'Invite'}
                icon="user-plus"
                accessibilityLabel={state.inviteOpen ? 'Hide the invite' : 'Invite others'}
                disabled={!state.roomCode}
                onPress={() => session.toggleInvite()}
              />
            </View>
          </View>
        )}

        {downloading && <DownloadCard text={status.text} />}

        {solo ? (
          <>
            <PartnerPanel partner={state.partner} lang={session.theirLang} />
            {feed}
          </>
        ) : state.inviteOpen && state.roomCode && session.server !== undefined ? (
          <ScrollView style={styles.invite} contentContainerStyle={styles.inviteContent}>
            <InvitePanel server={session.server} room={state.roomCode} onToast={(message) => session.toast(message)} />
          </ScrollView>
        ) : (
          <>
            <PersonChips participants={state.participants} />
            {feed}
          </>
        )}
      </View>

      <View style={[styles.panel, { paddingBottom: insets.bottom + 28 }]}>
        {solo ? (
          <SoloControls session={session} state={state} subscribeLevel={subscribeLevel} />
        ) : (
          <GroupControls session={session} state={state} subscribeLevel={subscribeLevel} />
        )}
      </View>

      <Toasts toasts={state.toasts} top={insets.top + 12} />

      <ConfirmDialog
        visible={confirming}
        title={solo ? 'End the conversation?' : 'Leave the group?'}
        message={solo ? 'The words on the screen go away when it ends.' : 'The others can keep talking without you.'}
        keep={solo ? { label: 'Keep talking', icon: 'mic' } : { label: 'Stay in the group', icon: 'users' }}
        go={solo ? { label: 'End', icon: 'x' } : { label: 'Leave', icon: 'log-out' }}
        onKeep={() => setConfirming(false)}
        onGo={() => {
          setConfirming(false);
          session.stop();
        }}
      />
    </View>
  );
}

function Status({ text, tone }: LiveState['status']) {
  const { styles } = useStyles();
  return (
    <View style={styles.status} accessibilityLiveRegion="polite">
      <StatusPill text={text} tone={tone} />
    </View>
  );
}

interface ControlsProps {
  session: LiveSession;
  state: LiveState;
  subscribeLevel(listener: (level: number) => void): () => void;
}

function MicRow({ state, subscribeLevel }: Omit<ControlsProps, 'session'>) {
  const { styles, palette } = useStyles();
  return (
    <View style={styles.micRow}>
      <Icon name={state.muted ? 'mic-off' : 'mic'} size={22} color={palette.muted} />
      <Text style={styles.micLabel} numberOfLines={1}>
        {state.micLabel}
      </Text>
      <LevelBars subscribe={subscribeLevel} mode={state.micMode} />
    </View>
  );
}

/** One phone: who is talking and pause, or a button to hold for each of the two. */
function SoloControls({ session, state, subscribeLevel }: ControlsProps) {
  const { styles } = useStyles();
  const { myLang, theirLang } = session;

  if (session.talkMode === 'hold') {
    return (
      <>
        <MicRow state={state} subscribeLevel={subscribeLevel} />
        <Text style={styles.hint}>Hold a button to talk. Let go when you’re done.</Text>
        <View style={styles.holdRow}>
          <HoldButton
            detail={`Me · ${native(myLang)}`}
            pressed={state.holding === 'me'}
            onChange={(pressed) => session.setHolding('me', pressed)}
          />
          <HoldButton
            detail={`Them · ${native(theirLang)}`}
            pressed={state.holding === 'them'}
            onChange={(pressed) => session.setHolding('them', pressed)}
          />
        </View>
      </>
    );
  }

  const speakers: SegmentOption<SpeakerSelection>[] = [
    ...(state.autoDetect ? [{ value: 'auto' as const, top: 'Automatic', bottom: 'Both' }] : []),
    { value: 'me', top: 'Me', bottom: native(myLang) },
    { value: 'them', top: 'Them', bottom: native(theirLang) },
  ];
  return (
    <>
      <MicRow state={state} subscribeLevel={subscribeLevel} />
      <Segments<SpeakerSelection>
        look="question"
        label="Who is talking?"
        options={speakers}
        value={state.speaker}
        onChange={(speaker) => session.selectSpeaker(speaker)}
      />
      <Text style={styles.hint}>
        {state.autoDetect ? 'Who is talking is noticed automatically.' : 'Tap Me or Them to show who is talking.'}
      </Text>
      <Button
        label={state.muted ? 'Resume' : 'Pause'}
        icon={state.muted ? 'play' : 'pause'}
        accessibilityLabel={state.muted ? 'Resume listening' : 'Pause listening'}
        onPress={() => session.setMuted(!state.muted)}
      />
    </>
  );
}

/** A group: the microphone and pause, or one button to hold. */
function GroupControls({ session, state, subscribeLevel }: ControlsProps) {
  const { styles, palette } = useStyles();

  if (session.talkMode === 'hold') {
    return (
      <>
        <MicRow state={state} subscribeLevel={subscribeLevel} />
        <View style={styles.holdRow}>
          <HoldButton
            detail={`Me · ${native(session.myLang)}`}
            pressed={state.holding === 'room'}
            onChange={(pressed) => session.setHolding('room', pressed)}
          />
        </View>
      </>
    );
  }

  return (
    <View style={styles.groupControls}>
      <Icon name={state.muted ? 'mic-off' : 'mic'} size={24} color={palette.muted} />
      <View style={styles.groupMic}>
        <Text style={styles.micLabel} numberOfLines={1}>
          {state.micLabel}
        </Text>
        <LevelBars subscribe={subscribeLevel} mode={state.micMode} />
      </View>
      <Button
        label={state.muted ? 'Resume' : 'Pause'}
        icon={state.muted ? 'play' : 'pause'}
        accessibilityLabel={state.muted ? 'Resume listening' : 'Pause listening'}
        onPress={() => session.setMuted(!state.muted)}
      />
    </View>
  );
}

const useStyles = themedStyles((palette) => ({
  screen: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  body: {
    flex: 1,
    gap: 16,
    paddingHorizontal: 20,
    paddingBottom: 12,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  topText: {
    flex: 1,
    gap: 8,
  },
  languages: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  language: {
    ...type.section,
    flexShrink: 1,
    color: palette.text,
  },
  status: {
    flexDirection: 'row',
  },
  groupTop: {
    gap: 10,
  },
  groupHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  groupTitle: {
    ...type.heading,
    flexShrink: 1,
    color: palette.text,
  },
  invite: {
    flex: 1,
  },
  inviteContent: {
    paddingBottom: 12,
  },
  panel: {
    gap: 14,
    paddingTop: 16,
    paddingHorizontal: 20,
    borderTopWidth: 2,
    borderTopColor: palette.border,
    backgroundColor: palette.surface,
  },
  micRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  micLabel: {
    ...type.secondary,
    flexShrink: 1,
    color: palette.muted,
  },
  hint: {
    ...type.secondary,
    color: palette.muted,
  },
  holdRow: {
    flexDirection: 'row',
    gap: 12,
  },
  groupControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  groupMic: {
    flex: 1,
    gap: 6,
  },
}));
