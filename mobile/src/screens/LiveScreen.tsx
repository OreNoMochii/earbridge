// The conversation: the two languages (or the group), how it's going, the big
// translation for the other person, everything said so far, and the talk controls.

import { useCallback, useState, useSyncExternalStore } from 'react';
import { Text, View } from 'react-native';
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
import { LoudHint } from '../components/LoudHint.tsx';
import { PartnerPanel } from '../components/PartnerPanel.tsx';
import { PersonChips } from '../components/PersonChips.tsx';
import { DownloadCard } from '../components/Screen.tsx';
import { Toasts } from '../components/Toasts.tsx';
import { VoicesBar } from '../components/VoicesBar.tsx';
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
  const hold = state.talkMode === 'hold';
  const { status } = state;
  const downloading = status.tone === 'busy' && /ownloading/.test(status.text);
  const pill = downloading ? { text: 'Getting ready…', tone: status.tone } : status;

  const placeholder = !solo
    ? 'When someone speaks, it appears here in their language and in yours.'
    : hold
      ? 'Hold your button while you talk. The translation shows here.'
      : 'Start talking. The translation shows here.';

  // A group: the invite while it is open, and who is in the group, scroll with the conversation.
  const { server } = session;
  const invite =
    !solo && state.inviteOpen && state.roomCode && server !== undefined ? (
      <InvitePanel server={server} room={state.roomCode} onToast={(message) => session.toast(message)} />
    ) : null;
  const header =
    !solo && (invite || state.participants.length > 0) ? (
      <>
        {invite}
        <PersonChips participants={state.participants} />
      </>
    ) : undefined;

  return (
    <View style={[styles.screen, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={[styles.body, { paddingTop: insets.top + 8 }]}>
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
                <Icon name="arrow-left-right" size={18} color={palette.muted} />
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
                label="Invite"
                icon="user-plus"
                accessibilityLabel={state.inviteOpen ? 'Hide the invite' : 'Invite others'}
                disabled={!state.roomCode}
                onPress={() => session.toggleInvite()}
              />
            </View>
          </View>
        )}

        {solo && state.voices && <VoicesBar session={session} voices={state.voices} />}
        {downloading && <DownloadCard text={status.text} />}

        {solo && <PartnerPanel partner={state.partner} lang={session.theirLang} />}
        <View style={styles.conversation}>
          <Feed
            entries={state.entries}
            interims={state.interims}
            placeholder={placeholder}
            header={header}
            holdHeader={invite !== null}
            onTranslate={(id) => session.accept(id)}
          />
          {/* Over the conversation, clear of the End button and the text for them; low while the QR code shows. */}
          <Toasts toasts={state.toasts} style={[styles.toasts, invite ? styles.toastsLow : styles.toastsHigh]} />
        </View>
        {/* Next to the controls it changes. */}
        {solo && state.loud && <LoudHint onHold={() => session.holdToTalk()} onClose={() => session.dismissLoud()} />}
      </View>

      <View style={[styles.panel, { paddingBottom: insets.bottom + 12 }]}>
        {solo ? (
          <SoloControls session={session} state={state} subscribeLevel={subscribeLevel} />
        ) : (
          <GroupControls session={session} state={state} subscribeLevel={subscribeLevel} />
        )}
      </View>

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
      <Text style={[styles.micLabel, styles.micName]} numberOfLines={1}>
        {state.micLabel}
      </Text>
      <LevelBars subscribe={subscribeLevel} mode={state.micMode} />
    </View>
  );
}

/** The microphone with its level, and the button that pauses it. */
function MicAndPause({ session, state, subscribeLevel }: ControlsProps) {
  const { styles, palette } = useStyles();
  return (
    <View style={styles.micAndPause}>
      <Icon name={state.muted ? 'mic-off' : 'mic'} size={24} color={palette.muted} />
      <View style={styles.mic}>
        <Text style={styles.micLabel} numberOfLines={2}>
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

/** One phone: who is talking and pause, or a button to hold for each of the two. */
function SoloControls({ session, state, subscribeLevel }: ControlsProps) {
  const { styles } = useStyles();
  const { myLang, theirLang } = session;

  if (state.talkMode === 'hold') {
    return (
      <>
        <MicRow state={state} subscribeLevel={subscribeLevel} />
        <View style={styles.holdRow}>
          <HoldButton
            who="Me"
            language={native(myLang)}
            pressed={state.holding === 'me'}
            onChange={(pressed) => session.setHolding('me', pressed)}
          />
          <HoldButton
            who="Them"
            language={native(theirLang)}
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
      <Segments<SpeakerSelection>
        look="question"
        label="Who is talking?"
        options={speakers}
        value={state.speaker}
        onChange={(speaker) => session.selectSpeaker(speaker)}
      />
      <MicAndPause session={session} state={state} subscribeLevel={subscribeLevel} />
    </>
  );
}

/** A group: the microphone and pause, or one button to hold. */
function GroupControls({ session, state, subscribeLevel }: ControlsProps) {
  const { styles } = useStyles();

  if (state.talkMode === 'hold') {
    return (
      <>
        <MicRow state={state} subscribeLevel={subscribeLevel} />
        <View style={styles.holdRow}>
          <HoldButton
            who="Me"
            language={native(session.myLang)}
            pressed={state.holding === 'room'}
            onChange={(pressed) => session.setHolding('room', pressed)}
          />
        </View>
      </>
    );
  }

  return <MicAndPause session={session} state={state} subscribeLevel={subscribeLevel} />;
}

const useStyles = themedStyles((palette) => ({
  screen: {
    flex: 1,
    backgroundColor: palette.bg,
  },
  body: {
    flex: 1,
    gap: 10,
    paddingHorizontal: 20,
    paddingBottom: 10,
  },
  conversation: {
    flex: 1,
  },
  toasts: {
    // 16 from the edges of the screen, past the body's 20.
    left: -4,
    right: -4,
  },
  toastsHigh: {
    top: 8,
  },
  toastsLow: {
    bottom: 8,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
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
  panel: {
    gap: 10,
    paddingTop: 10,
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
  /** In a row, with the level at the end. */
  micName: {
    flex: 1,
  },
  holdRow: {
    flexDirection: 'row',
    gap: 12,
  },
  micAndPause: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  mic: {
    flex: 1,
    gap: 4,
  },
}));
