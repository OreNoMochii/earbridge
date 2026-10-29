#!/usr/bin/env python3
"""Builds test clips: me (the macOS voice Daniel) holding the button, another talker (Samantha, or
the voice named as the first argument, e.g. Tessa, whose voice the phone's model finds rather like
Daniel's) interjecting between and over my lines, with and without babble. With --late, three more
of my lines come first, with pauses between, so that my voice here is settled (three prints) before
anyone else talks (files are then named late-*; with a voice named, late-tessa-* and so on).

With --earphone, every line is heard as through an earphone microphone in a loud place: the
telephone band, some of the room, and now and then the chatter louder for a moment, differing
line to line, so that my voice here is learned unevenly (the user's AirPods lines score 0.43-0.73
like the voice learned from them, and strangers come much nearer to it; files are named
late-earphone-* and so on). The recording stays as it is, as the user's was made on another
microphone.

Writes 16 kHz mono PCM16 .wav files next to this script, plus truth.json with each
line's speaker and times.
"""
import json
import os
import re
import subprocess
import sys
import wave

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 16000


def say(voice, text, path):
    subprocess.run(['say', '-v', voice, '-o', path, '--data-format=LEI16@16000', text], check=True)
    with wave.open(path) as w:
        assert w.getframerate() == SR and w.getnchannels() == 1 and w.getsampwidth() == 2
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)


def rms(x):
    return float(np.sqrt(np.mean(x * x)) + 1e-9)


def write(path, x):
    x = np.clip(x, -32767, 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(x.tobytes())


# (speaker, start seconds, text)
ME, OTHER = 'me', 'other'
SCRIPT = [
    (ME, 1.0, "Hello, I'd like to order two coffees and a croissant please."),
    (OTHER, 5.5, "Did you hear what happened yesterday at the station?"),
    (ME, 9.5, "Could you also tell me where the nearest metro station is? I need to get to the airport by five."),
    (OTHER, 12.0, "No way, that's completely crazy."),   # overlaps my second line
    (OTHER, 17.0, "I think it's about ten minutes from here on foot."),
    (ME, 21.0, "Thank you very much, that's really helpful. Have a nice day."),
    (OTHER, 23.5, "Sure, see you later."),               # overlaps the end of my last line
]
LATE = '--late' in sys.argv
EARPHONE = '--earphone' in sys.argv
ARGS = [a for a in sys.argv[1:] if not a.startswith('--')]
if LATE:
    # My voice here settles after three clear lines: three more of mine first, 2 s apart so that the
    # recognizer cuts them into separate lines, everything else 16 s later.
    SCRIPT = [
        (ME, 1.0, "Good morning. Is this table free, or are you expecting someone?"),
        (ME, 6.5, "I'll have the same as yesterday, thank you very much."),
        (ME, 11.5, "And a glass of water, if that's no trouble."),
    ] + [(who, start + 16.0, text) for who, start, text in SCRIPT]
VOICES = {ME: 'Daniel', OTHER: ARGS[0] if ARGS else 'Samantha'}
# Named after the other voice when one is given, so that the clips with each voice sit side by side.
PREFIX = ('late-' if LATE else '') + ('earphone-' if EARPHONE else '') + (f'{ARGS[0].lower()}-' if ARGS else '')
BABBLE = ['Karen', 'Tessa', 'Moira', 'Rishi', 'Fred', 'Tara']
BABBLE_TEXT = (
    "So I told him we should probably leave earlier because the traffic on the way to the "
    "harbour is always terrible on Saturdays, and he said fine but then he took forever to "
    "get ready, and by the time we got there the market was already closing, so we ended up "
    "having lunch at that little place near the bridge, which honestly was not bad at all."
)

total = 43.0 if LATE else 27.0
n = int(total * SR)

babble = np.zeros(n, dtype=np.float32)
for j, voice in enumerate(BABBLE):
    x = say(voice, BABBLE_TEXT, os.path.join(HERE, f'babble{j}.wav'))
    x = x * (2000.0 / rms(x))
    # Each voice starts at a different point so that the chatter is continuous.
    shift = int(j * 2.3 * SR)
    x = np.concatenate([x[shift:], x[:shift]])
    reps = int(np.ceil(n / len(x)))
    babble += np.tile(x, reps)[:n]


# ---- An earphone microphone in a loud place (--earphone).
def lowpass(x, hz, taps=255):
    k = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(2 * hz / SR * k) * np.hamming(taps)
    return np.convolve(x, h / h.sum(), mode='same')


def band(x, low, high):
    y = lowpass(x, high)
    return y - lowpass(y, low)


def reverb(x, rt60, wet, seed):
    rng = np.random.default_rng(seed)
    m = int(rt60 * SR)
    t = np.arange(m) / SR
    response = rng.standard_normal(m) * np.exp(-6.9 * t / rt60)
    response[0] = 0
    size = len(x) + m
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(response, size), size)[: len(x)]
    return (1 - wet) * x + wet * y * (rms(x) / rms(y))


# (low Hz, high Hz, reverberation seconds, how much of the room, chatter on the line in dB SNR or None)
CHANNEL = {
    'A': (300, 3400, 0.3, 0.2, None),
    'B': (300, 2500, 0.5, 0.4, None),
    'C': (200, 5000, 0.3, 0.3, None),
    'D': (300, 3400, 0.5, 0.5, 5),
    'E': (300, 3400, 0.3, 0.2, 10),
}
# Which channel each line of SCRIPT goes through, in order (mine, mine, mine, mine, other, ...).
CHANNELS = ['A', 'B', 'D', 'A', 'D', 'B', 'A', 'E', 'E', 'B']


def through(x, name, seed):
    low, high, rt60, wet, snr = CHANNEL[name]
    y = reverb(band(x, low, high), rt60, wet, seed)
    y = y * (2000.0 / rms(y))
    if snr is not None:
        at = seed * 7919 % (len(babble) - len(y))
        chatter = babble[at: at + len(y)]
        y = y + chatter * (2000.0 / rms(chatter)) / (10 ** (snr / 20))
    return y


mix = np.zeros(n, dtype=np.float32)
truth = []
level = {}
for i, (who, start, text) in enumerate(SCRIPT):
    x = say(VOICES[who], text, os.path.join(HERE, f'{PREFIX}line{i}.wav'))
    if EARPHONE:
        x = through(x, CHANNELS[i % len(CHANNELS)], i + 1)
    # Bring every line to the same loudness.
    x = x * (2000.0 / rms(x))
    at = int(start * SR)
    end = min(n, at + len(x))
    mix[at:end] += x[: end - at]
    truth.append({'speaker': who, 'start': start, 'end': start + len(x) / SR, 'text': text})
    level[who] = rms(x)

speech = 2000.0
for name, snr in [('clean', None), ('snr10', 10), ('snr5', 5), ('snr0', 0)]:
    out = mix.copy()
    if snr is not None:
        out += babble * (speech / rms(babble)) / (10 ** (snr / 20))
    write(os.path.join(HERE, f'{PREFIX}{name}.wav'), out)
    print(name, 'rms', round(rms(out)))

with open(os.path.join(HERE, f'{PREFIX}truth.json'), 'w') as f:
    json.dump({'voices': VOICES, 'lines': truth}, f, indent=1)
for name in os.listdir(HERE):
    if re.match(rf'{PREFIX}line\d+\.wav$|babble\d+\.wav$', name):
        os.remove(os.path.join(HERE, name))
print('wrote', len(truth), 'lines')
