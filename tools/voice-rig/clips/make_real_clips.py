#!/usr/bin/env python3
"""Builds test clips like make_clips.py, but from recorded human voices (LibriSpeech, read
audiobook sentences at 16 kHz): me holding the button, another talker interjecting between
and over my lines, and six more voices as the place's chatter. My recording is made of other
sentences of mine (clips/<set>recording.wav; run.mts uses it in place of the stand-in).

Usage: venv/bin/python -I clips/make_real_clips.py <LibriSpeech/dev-clean folder> --me 1272 --other 2412
       [--babble 84,174,251,422,652,777] [--late] [--turns] [--earphone]
Writes clips/real-[late-][turns-][earphone-]<me>-<other>-{clean,snr10,snr5,snr0}.wav, the truth and the recording.
--turns: three lines of theirs first, said holding the "Them" button (the truth marks them held), so that
their voice is learned from them before they talk over mine, as in a real talk; and their recording,
clips/<prefix>partner.wav, made of three other sentences of theirs, which run.mts uses as their voice
recorded in an earlier talk unless RIG_PARTNER=none.
"""
import json
import os
import subprocess
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from channel import CHANNELS, rms, through  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SR = 16000
ME, OTHER = 'me', 'other'


def option(name, default=None):
    if name in sys.argv:
        return sys.argv[sys.argv.index(name) + 1]
    return default


corpus = next(a for a in sys.argv[1:] if not a.startswith('--') and os.path.isdir(a))
LATE = '--late' in sys.argv
EARPHONE = '--earphone' in sys.argv
TURNS = '--turns' in sys.argv
VOICES = {ME: option('--me', '1272'), OTHER: option('--other', '2412')}
BABBLE = option('--babble', '84,174,251,422,652,777').split(',')
PREFIX = 'real-' + ('late-' if LATE else '') + ('turns-' if TURNS else '') + ('earphone-' if EARPHONE else '') + f"{VOICES[ME]}-{VOICES[OTHER]}-"


def seconds(path):
    """From the FLAC header, without decoding."""
    with open(path, 'rb') as f:
        f.seek(8)
        info = f.read(34)
    bits = int.from_bytes(info[10:18], 'big')
    return (bits & ((1 << 36) - 1)) / (bits >> 44)


def pcm(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32)


def utterances(speaker):
    """(path, seconds, text) of each of the speaker's sentences, in the corpus's order."""
    folder = os.path.join(corpus, speaker)
    text = {}
    for root, _, files in os.walk(folder):
        for f in files:
            if f.endswith('.trans.txt'):
                for line in open(os.path.join(root, f), encoding='utf-8'):
                    uid, _, words = line.strip().partition(' ')
                    text[uid] = words
    out = []
    for root, _, files in os.walk(folder):
        for f in sorted(files):
            if f.endswith('.flac'):
                path = os.path.join(root, f)
                out.append((path, seconds(path), text[f[:-5]]))
    return sorted(out)


def pick(items, low, high, used, n=1):
    """The first n unused sentences between low and high seconds."""
    got = []
    for item in items:
        if item[0] not in used and low <= item[1] <= high:
            used.add(item[0])
            got.append(item)
            if len(got) == n:
                return got
    raise SystemExit(f'not enough sentences of {low}-{high} s')


def write(path, x):
    import wave
    x = np.clip(x, -32767, 32767).astype(np.int16)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(x.tobytes())


mine, theirs = utterances(VOICES[ME]), utterances(VOICES[OTHER])
used = set()
# Lines as in make_clips.py's script: three short lines of mine (--late), then three of theirs said holding
# the "Them" button (--turns: so that their voice is learned from them, as in a real talk), then mine, theirs,
# a long one of mine that they interrupt, theirs, mine, and theirs over the end of my last line.
me_lines = pick(mine, 3, 6.5, used, 3) if LATE else []
me_lines += pick(mine, 3, 6.5, used, 1) + pick(mine, 6, 10, used, 1) + pick(mine, 3, 6.5, used, 1)
them = pick(theirs, 2.5, 5, used, 1) + pick(theirs, 1.5, 3.5, used, 1) + pick(theirs, 2.5, 5, used, 1) + pick(theirs, 1.5, 3.5, used, 1)
solo = pick(theirs, 2.5, 5, used, 3) if TURNS else []
recording = np.concatenate([pcm(p) for p, _, _ in pick(mine, 4, 12, used, 3)])[: SR * 20]
partner = np.concatenate([pcm(p) for p, _, _ in pick(theirs, 4, 12, used, 3)])[: SR * 20] if TURNS else None

# (who, sentence, where it starts: after the last line's end, into the last line of mine, or before my last line's
# end; and who holds the button meanwhile, when not me)
order = [(ME, line, ('after', 1.5)) for line in me_lines[:-3]]
order += [(OTHER, line, ('after', 1.5, 'them')) for line in solo]
order += [
    (ME, me_lines[-3], ('after', 2.7 if LATE else 0)),
    (OTHER, them[0], ('after', 0.9)),
    (ME, me_lines[-2], ('after', 1.5)),
    (OTHER, them[1], ('into', 2.5)),
    (OTHER, them[2], ('after-mine', 1.3)),
    (ME, me_lines[-1], ('after', 1.5)),
    (OTHER, them[3], ('before-end', 1.5)),
]

lines = []
clock = 1.0
my_last = None
audio = []
for i, (who, (path, dur, text), (how, gap, *held)) in enumerate(order):
    x = pcm(path)
    if how == 'after':
        start = clock + gap if lines else 1.0
    elif how == 'into':
        start = my_last['start'] + gap
    elif how == 'after-mine':
        start = my_last['end'] + gap
    else:
        start = my_last['end'] - gap
    end = start + len(x) / SR
    line = {'speaker': who, 'start': round(start, 3), 'end': round(end, 3), 'text': text, **({'held': held[0]} if held else {})}
    lines.append(line)
    audio.append(x)
    if who == ME:
        my_last = line
    clock = max(clock, end)
total = max(l['end'] for l in lines) + 2.0
n = int(total * SR)

babble = np.zeros(n, dtype=np.float32)
for j, speaker in enumerate(BABBLE):
    x = np.concatenate([pcm(p) for p, _, _ in utterances(speaker)[:12]])
    x = x * (2000.0 / rms(x))
    shift = int(j * 2.3 * SR)
    x = np.concatenate([x[shift:], x[:shift]])
    babble += np.tile(x, int(np.ceil(n / len(x))))[:n]

mix = np.zeros(n, dtype=np.float32)
for i, (line, x) in enumerate(zip(lines, audio)):
    if EARPHONE:
        x = through(x, CHANNELS[i % len(CHANNELS)], i + 1, babble)
    x = x * (2000.0 / rms(x))
    at = int(line['start'] * SR)
    end = min(n, at + len(x))
    mix[at:end] += x[: end - at]

speech = 2000.0
for name, snr in [('clean', None), ('snr10', 10), ('snr5', 5), ('snr0', 0)]:
    out = mix.copy()
    if snr is not None:
        out += babble * (speech / rms(babble)) / (10 ** (snr / 20))
    write(os.path.join(HERE, f'{PREFIX}{name}.wav'), out)
write(os.path.join(HERE, f'{PREFIX}recording.wav'), recording * (2000.0 / rms(recording)))
if partner is not None:
    write(os.path.join(HERE, f'{PREFIX}partner.wav'), partner * (2000.0 / rms(partner)))
with open(os.path.join(HERE, f'{PREFIX}truth.json'), 'w') as f:
    json.dump({'voices': VOICES, 'lines': lines}, f, indent=1)
for line in lines:
    print(f"{line['speaker']:5} {line['start']:6.2f}-{line['end']:6.2f} {line.get('held', '-'):4} {line['text'][:70]}")
print(f'wrote {len(lines)} lines, {total:.1f} s, recording {len(recording) / SR:.1f} s' + (f', theirs {len(partner) / SR:.1f} s' if partner is not None else '') + f', as {PREFIX}*')
