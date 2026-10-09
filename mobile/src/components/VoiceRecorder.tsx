// Records a voice for "Only our two voices": the phone owner's, from about ten seconds of
// them talking, or someone they talk with, from a few seconds of that person with the
// owner's voice left out. It is turned into a voice print that stays on the phone; the
// recording itself is not kept. Shown over the whole screen; the Android back button
// cancels it.

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { BackHandler, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';

import { consoleLogger } from '../../../shared/pipeline/log.ts';
import {
  PARTNER_SECONDS,
  PartnerRecording,
  RECORDING_SECONDS,
  VoiceFilter,
  VoiceRecording,
} from '../../../shared/pipeline/voices.ts';
import type { RecordingProblem } from '../../../shared/protocol.ts';
import { openMicrophone } from '../audio/mic.ts';
import type { Microphone } from '../audio/mic.ts';
import { prepareVoiceModel, printVoice, releaseVoiceModel, VOICE_MODEL_MB } from '../engines/voices.ts';
import { themedStyles, type } from '../theme.ts';
import { Banner } from './Basics.tsx';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { LevelBars } from './LevelBars.tsx';

/** Gives up when there still isn't enough of my speech after this long. */
const MAX_SECONDS = 45;
/** After this long with little of my speech, suggests speaking up. */
const HELP_AFTER_SECONDS = 15;
const NOT_HEARD = { title: 'Couldn’t hear enough of your voice', message: 'Try again closer to the phone, somewhere quieter.' };
/** Why recording their voice did not work. */
const THEIRS_FAILED: Record<RecordingProblem, { title: string; message: string }> = {
  mine: { title: 'It heard mostly your voice', message: 'Let them talk. You stay quiet.' },
  quiet: { title: 'Couldn’t hear enough of their voice', message: 'Try again closer to them, somewhere quieter.' },
};
/** What to do while recording their voice goes wrong. */
const THEIRS_HINTS: Record<RecordingProblem, string> = {
  mine: 'That sounded like you. Let them talk.',
  quiet: 'Can’t hear them well. Hold the phone closer to them.',
};

const RING = 200;
const STROKE = 14;
const RADIUS = (RING - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type Phase =
  | { step: 'recording'; speech: number; heard: number; hint: RecordingProblem | undefined }
  | { step: 'saving'; download: number | undefined }
  | { step: 'failed'; title: string; message: string };

const START: Phase = { step: 'recording', speech: 0, heard: 0, hint: undefined };

interface VoiceRecorderProps {
  /** Someone the phone owner talks with, leaving out the owner's voice (`mine`); else the owner. */
  them?: { name: string; mine: Float32Array };
  /** Listen through the earphones' microphone, as conversations will. */
  earphoneMic: boolean;
  /** Keeps the voice print; rejects if the phone could not. */
  save(print: Float32Array): Promise<unknown>;
  /** The voice print is saved. */
  onDone(): void;
  onClose(): void;
}

export function VoiceRecorder({ them, earphoneMic, save, onDone, onClose }: VoiceRecorderProps) {
  const { styles, palette } = useStyles();
  const insets = useSafeAreaInsets();
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>(START);
  const levelListeners = useRef(new Set<(level: number) => void>());
  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    const listeners = levelListeners.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const done = useEffectEvent(onDone);
  const keepPrint = useEffectEvent(save);
  const mine = them?.mine;

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  useEffect(() => {
    const abort = new AbortController();
    let mic: Microphone | undefined;
    let heard = 0;
    let download: number | undefined;
    let stage: 'recording' | 'saving' | 'over' = 'recording';
    const whose = mine ? 'their' : 'your';

    const fail = (title: string, message: string) => {
      if (stage === 'over' || abort.signal.aborted) return;
      stage = 'over';
      mic?.stop();
      setPhase({ step: 'failed', title, message });
    };
    const failWith = (error: unknown) => fail(`${mine ? 'Their' : 'Your'} voice wasn’t saved`, errorText(error));

    // The model downloads while they talk, if it isn't on the phone yet.
    const model = prepareVoiceModel(abort.signal, (fraction) => {
      download = fraction;
      if (stage === 'saving') setPhase({ step: 'saving', download });
    });
    model.catch(failWith);

    /** Makes the voice print once enough was heard, and keeps it. */
    const finish = async (print: () => Promise<Float32Array | undefined>) => {
      stage = 'saving';
      mic?.stop();
      setPhase({ step: 'saving', download });
      try {
        await model;
        const made = await print();
        if (!made) throw new Error('Couldn’t make a voice print. Try again.');
        try {
          await keepPrint(made);
        } catch {
          throw new Error(`Couldn’t save ${whose} voice on this phone. Try again.`);
        }
      } catch (error) {
        failWith(error);
        return;
      }
      if (abort.signal.aborted) return;
      stage = 'over';
      done();
    };

    let add: (pcm: ArrayBuffer) => void;
    let partner: PartnerRecording | undefined;
    if (mine) {
      // Their voice, told from mine: printing waits for the model.
      const voices = new VoiceFilter({
        mine,
        print: async (samples) => {
          await model;
          return printVoice(samples);
        },
      });
      partner = new PartnerRecording(
        voices,
        {
          progress: ({ seconds, hint }) => {
            if (stage === 'recording') setPhase({ step: 'recording', speech: seconds, heard, hint });
          },
          done: (failed) => {
            if (failed) fail(THEIRS_FAILED[failed].title, THEIRS_FAILED[failed].message);
            else void finish(async () => voices.recordedPartner);
          },
        },
        consoleLogger,
      );
      add = (pcm) => partner?.add(new Uint8Array(pcm));
    } else {
      const recording = new VoiceRecording();
      add = (pcm) => {
        recording.add(new Int16Array(pcm));
        const speech = recording.speechSeconds;
        if (speech >= RECORDING_SECONDS) void finish(() => printVoice(recording.speech()));
        else if (heard >= MAX_SECONDS) fail(NOT_HEARD.title, NOT_HEARD.message);
        else setPhase({ step: 'recording', speech, heard, hint: undefined });
      };
    }

    const onAudio = (pcm: ArrayBuffer) => {
      if (stage !== 'recording') return;
      heard += pcm.byteLength / 2 / 16_000;
      add(pcm);
    };

    openMicrophone({
      earphoneMic,
      onAudio,
      onLevel: (level) => {
        for (const listener of levelListeners.current) listener(level);
      },
      onEnded: failWith,
    }).then(
      (opened) => {
        if (stage !== 'recording' || abort.signal.aborted) {
          opened.stop();
          return;
        }
        mic = opened;
        mic.mode = 'live';
      },
      failWith,
    );

    return () => {
      abort.abort();
      partner?.stop();
      mic?.stop();
      // A conversation loads it again.
      releaseVoiceModel();
    };
  }, [attempt, earphoneMic, mine]);

  const needed = them ? PARTNER_SECONDS : RECORDING_SECONDS;
  let status = '';
  let icon: IconName = 'mic';
  let fraction = 1;
  if (phase.step === 'recording') {
    fraction = Math.min(1, phase.speech / needed);
    if (phase.hint) {
      status = THEIRS_HINTS[phase.hint];
      icon = phase.hint === 'mine' ? 'hand' : 'volume-2';
    } else if (phase.speech === 0) {
      status = them ? 'Listening… ask them to talk.' : 'Listening… start talking.';
    } else if (fraction >= 1) {
      // Their last parts are still being checked.
      status = 'Got it. One moment…';
      icon = 'circle-check';
    } else if (!them && phase.heard >= HELP_AFTER_SECONDS && fraction < 0.5) {
      status = 'Speak up a little, or move somewhere quieter.';
      icon = 'volume-2';
    } else {
      status = them ? 'Keep going…' : 'Keep talking…';
      icon = 'audio-lines';
    }
  } else if (phase.step === 'saving') {
    if (phase.download === undefined) {
      status = them ? 'Saving their voice…' : 'Saving your voice…';
      icon = 'circle-check';
    } else {
      status = `Got it. Downloading the voice model (${VOICE_MODEL_MB} MB)… ${Math.round(phase.download * 100)}%`;
      icon = 'download';
    }
  }

  return (
    <View style={[styles.overlay, { paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right }]}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 28 }]}>
        <View style={styles.top}>
          <Text style={styles.title} accessibilityRole="header">
            {them ? `Record ${them.name}’s voice` : 'Record your voice'}
          </Text>
          <Text style={styles.text}>
            {them
              ? 'Ask them to talk normally for a few seconds, with the phone held as in your talks. You stay quiet.'
              : `Talk normally for about ${RECORDING_SECONDS} seconds. Hold the phone as you will in conversations. For example, say what you did today, in both your languages if you can.`}
          </Text>
        </View>
        {phase.step === 'failed' ? (
          <Banner
            icon="mic-off"
            title={phase.title}
            message={phase.message}
            action={{
              label: 'Try again',
              icon: 'rotate-cw',
              onPress: () => {
                setPhase(START);
                setAttempt((count) => count + 1);
              },
            }}
          />
        ) : (
          <View style={styles.progress}>
            <View
              style={styles.ring}
              accessible
              accessibilityRole="progressbar"
              accessibilityLabel="Recorded"
              accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100) }}
            >
              <Svg width={RING} height={RING} style={styles.ringSvg}>
                <Circle cx={RING / 2} cy={RING / 2} r={RADIUS} stroke={palette.surface2} strokeWidth={STROKE} fill="none" />
                {fraction > 0 && (
                  <Circle
                    cx={RING / 2}
                    cy={RING / 2}
                    r={RADIUS}
                    stroke={palette.accent}
                    strokeWidth={STROKE}
                    strokeLinecap="round"
                    strokeDasharray={`${CIRCUMFERENCE * fraction} ${CIRCUMFERENCE}`}
                    fill="none"
                    transform={`rotate(-90 ${RING / 2} ${RING / 2})`}
                  />
                )}
              </Svg>
              <View style={styles.center}>
                <Icon name={icon} size={56} color={palette.accent} />
              </View>
            </View>
            <View style={styles.status}>
              {phase.step === 'recording' && <LevelBars subscribe={subscribeLevel} mode="live" />}
              <Text style={styles.statusText} accessibilityLiveRegion="polite">
                {status}
              </Text>
            </View>
            {phase.step === 'recording' && (
              <Text style={styles.seconds}>
                {Math.min(needed, Math.floor(phase.speech))} of {needed} seconds
              </Text>
            )}
          </View>
        )}
        <View style={styles.bottom}>
          <View style={styles.privacy}>
            <Icon name="lock" size={22} color={palette.accent} />
            <Text style={styles.privacyText}>
              Only a voice print is kept, on this phone. The recording isn’t kept or sent anywhere.
            </Text>
          </View>
          <Button label="Cancel" icon="x" onPress={onClose} />
        </View>
      </ScrollView>
    </View>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  content: {
    flexGrow: 1,
    justifyContent: 'space-between',
    gap: 24,
    width: '100%',
    maxWidth: 560,
    alignSelf: 'center',
    paddingTop: 12,
    paddingHorizontal: 20,
  },
  top: {
    gap: 20,
  },
  title: {
    ...type.title,
    color: palette.text,
  },
  text: {
    ...type.body,
    color: palette.text,
  },
  progress: {
    alignItems: 'center',
    gap: 16,
  },
  ring: {
    width: RING,
    height: RING,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ringSvg: {
    position: 'absolute',
    top: 0,
    left: 0,
  },
  center: {
    width: 128,
    height: 128,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 64,
    backgroundColor: palette.accentSoft,
  },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  statusText: {
    ...type.largeBold,
    flexShrink: 1,
    color: palette.text,
    textAlign: 'center',
  },
  seconds: {
    ...type.secondary,
    color: palette.muted,
  },
  bottom: {
    gap: 16,
  },
  privacy: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  privacyText: {
    ...type.secondary,
    flex: 1,
    color: palette.muted,
  },
}));
