// Whether earphones (wired or Bluetooth) are connected, and when that changes.

import { Platform } from 'react-native';
import { AudioManager } from 'react-native-audio-api';

import EarbridgeAudio from '../../modules/earbridge-audio/src/EarbridgeAudioModule.ts';
import { EARPHONE_OUTPUTS } from './ios-session.ts';

export async function earphonesConnected(): Promise<boolean> {
  if (EarbridgeAudio) return EarbridgeAudio.earphonesConnected();
  if (Platform.OS !== 'ios') return false;
  try {
    const devices = await AudioManager.getDevicesInfo();
    // Before the session is active, only the available outputs are known.
    const outputs = devices.currentOutputs.length > 0 ? devices.currentOutputs : devices.availableOutputs;
    return outputs.some((device) => EARPHONE_OUTPUTS.has(device.category));
  } catch {
    return false;
  }
}

/** Calls back when earphones connect or disconnect; returns a function that stops watching. */
export function watchEarphones(onChange: (connected: boolean) => void): () => void {
  if (EarbridgeAudio) {
    const subscription = EarbridgeAudio.addListener('onEarphonesChange', (event) => onChange(event.connected));
    return () => subscription.remove();
  }
  if (Platform.OS !== 'ios') return () => {};
  let last: boolean | undefined;
  let stopped = false;
  void earphonesConnected().then((connected) => {
    last ??= connected;
  });
  const subscription = AudioManager.addSystemEventListener('routeChange', () => {
    void earphonesConnected().then((connected) => {
      if (stopped || connected === last) return;
      last = connected;
      onChange(connected);
    });
  });
  return () => {
    stopped = true;
    subscription.remove();
  };
}
