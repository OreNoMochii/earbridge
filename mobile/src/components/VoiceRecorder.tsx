// Records the phone owner's voice for "Only our two voices": about ten seconds of them
// talking, turned into a voice print that stays on the phone; the recording itself is not
// kept. Shown over the whole screen; the Android back button cancels it.

import { useCallback, useEffect, useEffectEvent, useRef, useState } from 'react';
import { BackHandler, ScrollView, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Circle } from 'react-native-svg';

import { RECORDING_SECONDS, VoiceRecording } from '../../../shared/pipeline/voices.ts';
import { openMicrophone } from '../audio/mic.ts';
import type { Microphone } from '../audio/mic.ts';
import { prepareVoiceModel, printVoice, releaseVoiceModel, saveMyVoice, VOICE_MODEL_MB } from '../engines/voices.ts';
import { themedStyles, type } from '../theme.ts';
import { Banner } from './Basics.tsx';
import { Button } from './Button.tsx';
import { Icon } from './Icon.tsx';
import type { IconName } from './Icon.tsx';
import { LevelBars } from './LevelBars.tsx';

/** Gives up when there still isn't enough speech after this long. */
const MAX_SECONDS = 45;
/** After this long with little speech, suggests speaking up. */
const HELP_AFTER_SECONDS = 15;
const NOT_HEARD = 'Couldn’t hear enough of your voice. Try again closer to the phone, somewhere quieter.';

const RING = 200;
const STROKE = 14;
const RADIUS = (RING - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

type Phase =
  | { step: 'recording'; speech: number; heard: number }
  | { step: 'saving'; download: number | undefined }
  | { step: 'failed'; message: string };

interface VoiceRecorderProps {
  /** Listen through the earphones' microphone, as conversations will. */
  earphoneMic: boolean;
  /** My voice print is saved. */
  onDone(): void;
  onClose(): void;
}

export function VoiceRecorder({ earphoneMic, onDone, onClose }: VoiceRecorderProps) {
  const { styles, palette } = useStyles();
  const insets = useSafeAreaInsets();
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>({ step: 'recording', speech: 0, heard: 0 });
  const levelListeners = useRef(new Set<(level: number) => void>());
  const subscribeLevel = useCallback((listener: (level: number) => void) => {
    const listeners = levelListeners.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  const done = useEffectEvent(onDone);

  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [onClose]);

  useEffect(() => {
    const abort = new AbortController();
    const recording = new VoiceRecording();
    let mic: Microphone | undefined;
    let heard = 0;
    let download: number | undefined;
    let stage: 'recording' | 'saving' | 'over' = 'recording';

    const fail = (message: string) => {
      if (stage === 'over' || abort.signal.aborted) return;
      stage = 'over';
      mic?.stop();
      setPhase({ step: 'failed', message });
    };

    // The model downloads while I talk, if it isn't on the phone yet.
    const model = prepareVoiceModel(abort.signal, (fraction) => {
      download = fraction;
      if (stage === 'saving') setPhase({ step: 'saving', download });
    });
    model.catch((error: unknown) => fail(errorText(error)));

    const save = async () => {
      stage = 'saving';
      mic?.stop();
      setPhase({ step: 'saving', download });
      try {
        await model;
        const print = await printVoice(recording.speech());
        if (!print) throw new Error('Couldn’t make a voice print. Try again.');
        try {
          await saveMyVoice(print);
        } catch {
          throw new Error('Couldn’t save your voice on this phone. Try again.');
        }
      } catch (error) {
        fail(errorText(error));
        return;
      }
      if (abort.signal.aborted) return;
      stage = 'over';
      done();
    };

    const onAudio = (pcm: ArrayBuffer) => {
      if (stage !== 'recording') return;
      recording.add(new Int16Array(pcm));
      heard += pcm.byteLength / 2 / 16_000;
      const speech = recording.speechSeconds;
      if (speech >= RECORDING_SECONDS) void save();
      else if (heard >= MAX_SECONDS) fail(NOT_HEARD);
      else setPhase({ step: 'recording', speech, heard });
    };

    openMicrophone({
      earphoneMic,
      onAudio,
      onLevel: (level) => {
        for (const listener of levelListeners.current) listener(level);
      },
      onEnded: fail,
    }).then(
      (opened) => {
        if (stage !== 'recording' || abort.signal.aborted) {
          opened.stop();
          return;
        }
        mic = opened;
        mic.mode = 'live';
      },
      (error: unknown) => fail(errorText(error)),
    );

    return () => {
      abort.abort();
      mic?.stop();
      // A conversation loads it again.
      releaseVoiceModel();
    };
  }, [attempt, earphoneMic]);

  let status = '';
  let icon: IconName = 'mic';
  let fraction = 1;
  if (phase.step === 'recording') {
    fraction = Math.min(1, phase.speech / RECORDING_SECONDS);
    if (phase.speech === 0) status = 'Listening… start talking.';
    else if (phase.heard >= HELP_AFTER_SECONDS && fraction < 0.5) {
      status = 'Speak up a little, or move somewhere quieter.';
      icon = 'volume-2';
    } else {
      status = 'Keep talking…';
      icon = 'audio-lines';
    }
  } else if (phase.step === 'saving') {
    if (phase.download === undefined) {
      status = 'Saving your voice…';
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
            Record your voice
          </Text>
          <Text style={styles.text}>
            Talk normally for about {RECORDING_SECONDS} seconds. Hold the phone as you will in conversations. For example,
            say what you did today, in both your languages if you can.
          </Text>
        </View>
        {phase.step === 'failed' ? (
          <Banner
            icon="mic-off"
            title={phase.message === NOT_HEARD ? 'Couldn’t hear enough of your voice' : 'Your voice wasn’t saved'}
            message={phase.message === NOT_HEARD ? 'Try again closer to the phone, somewhere quieter.' : phase.message}
            action={{
              label: 'Try again',
              icon: 'rotate-cw',
              onPress: () => {
                setPhase({ step: 'recording', speech: 0, heard: 0 });
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
                {Math.min(RECORDING_SECONDS, Math.floor(phase.speech))} of {RECORDING_SECONDS} seconds
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
