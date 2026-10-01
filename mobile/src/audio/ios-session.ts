// iPhone only: how EarBridge shares the phone's audio. It records and plays at the same
// time, and chooses which microphone listens: the phone's (which keeps Bluetooth
// earphones in full-quality A2DP) or the earphones' (Bluetooth hands-free, or a wired
// headset's microphone).

import { AudioManager } from 'react-native-audio-api';
import type { AudioDeviceInfo } from 'react-native-audio-api';

import type { CaptureInput } from '../../modules/earbridge-audio/src/EarbridgeAudioModule.ts';

const EARPHONE_INPUTS = new Set(['BluetoothHFP', 'MicrophoneWired', 'USBAudio']);
export const EARPHONE_OUTPUTS = new Set(['Headphones', 'BluetoothA2DPOutput', 'BluetoothLE', 'BluetoothHFP', 'USBAudio']);

/** Sets up and activates the audio session; resolves with the microphone in use. */
export async function startIosSession(earphoneMic: boolean): Promise<CaptureInput> {
  AudioManager.setAudioSessionOptions({
    iosCategory: 'playAndRecord',
    iosMode: 'default',
    // Hands-free Bluetooth (HFP) is the only way to use a Bluetooth microphone, and it
    // lowers the sound quality; without it, iOS keeps the earphones in A2DP.
    iosOptions: earphoneMic
      ? ['allowBluetoothHFP', 'bluetoothHighQualityRecording', 'defaultToSpeaker']
      : ['allowBluetoothA2DP', 'defaultToSpeaker'],
  });
  AudioManager.observeAudioInterruptions(true);
  await AudioManager.setAudioSessionActivity(true);

  let devices: { availableInputs: AudioDeviceInfo[]; currentInputs: AudioDeviceInfo[] };
  try {
    devices = await AudioManager.getDevicesInfo();
  } catch {
    return { input: 'phone', name: 'Microphone' };
  }
  // A wired headset takes over the microphone by default; choose explicitly.
  const wanted = earphoneMic
    ? devices.availableInputs.find((device) => EARPHONE_INPUTS.has(device.category))
    : devices.availableInputs.find((device) => device.category === 'MicrophoneBuiltIn');
  if (wanted && !devices.currentInputs.some((device) => device.id === wanted.id)) {
    try {
      await AudioManager.setInputDevice(wanted.id);
    } catch {
      // Keep the one iOS chose.
    }
  }
  const current = wanted ?? devices.currentInputs[0];
  if (current && EARPHONE_INPUTS.has(current.category)) return { input: 'earphones', name: current.name };
  return { input: 'phone', name: 'Phone microphone' };
}

export async function stopIosSession(): Promise<void> {
  try {
    await AudioManager.setAudioSessionActivity(false);
  } catch {
    // Already inactive, or another app holds the audio.
  }
}
