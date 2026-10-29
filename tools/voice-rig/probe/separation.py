"""How well a speaker model tells my lines from the nearest stranger's on the real clips, under several
scorings of a print against my voice settled here (my first three lines): raw cosine; z-norm against a
cohort of other speakers (clean, or heard through the earphone channel; all, or the 20 nearest);
the cosine less the cosine to the chatter heard here; the cosine less the nearest cohort voice's.
usage: python -I separation.py <model.onnx> <dev-clean folder> <rig clips folder> <channel.py folder> <set prefix>..."""
import json, os, subprocess, sys, wave
import numpy as np
import sherpa_onnx

model, corpus, folder, chanfolder, prefixes = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5:]
sys.path.insert(0, chanfolder)
from channel import CHANNELS, through  # noqa: E402

ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=4))
SR = 16000
BABBLE = {'84', '174', '251', '422', '652', '777'}


def read(path):
    with wave.open(path, 'rb') as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)


def seconds(path):
    with open(path, 'rb') as f:
        f.seek(8)
        info = f.read(34)
    bits = int.from_bytes(info[10:18], 'big')
    return (bits & ((1 << 36) - 1)) / (bits >> 44)


def flac(path):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'], check=True, capture_output=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32)


def print_of(x):
    """A unit print of PCM16-scaled float samples, as the app makes it (middle 10 s of long speech)."""
    if len(x) < SR * 0.5:
        return None
    if len(x) > SR * 10:
        mid = len(x) // 2
        x = x[mid - SR * 5: mid + SR * 5]
    s = ex.create_stream()
    s.accept_waveform(sample_rate=SR, waveform=x / 32768.0)
    s.input_finished()
    if not ex.is_ready(s):
        return None
    e = np.array(ex.compute(s), dtype=np.float32)
    return e / (np.linalg.norm(e) + 1e-9)


def pieces(x):
    out = []
    for at in range(0, max(1, len(x) - int(SR * 1.5) + 1), SR // 2):
        p = print_of(x[at: at + int(SR * 1.5)])
        if p is not None:
            out.append(p)
    return out


def unit(v):
    return v / (np.linalg.norm(v) + 1e-9)


# The cohort: four sentences of 3-10 s from every speaker but the sets' two and the chatter's six,
# clean and heard through the earphone channels (no chatter bursts).
cohort_clean, cohort_chan = [], []
sets_speakers = set()
for prefix in prefixes:
    truth = json.load(open(os.path.join(folder, f'{prefix}-truth.json')))
    sets_speakers |= set(truth['voices'].values())
for i, spk in enumerate(sorted(os.listdir(corpus), key=int)):
    if spk in BABBLE or spk in sets_speakers:
        continue
    got = 0
    for root, _, files in sorted(os.walk(os.path.join(corpus, spk))):
        for f in sorted(files):
            if got == 4:
                break
            if f.endswith('.flac') and 3 <= seconds(os.path.join(root, f)) <= 10:
                x = flac(os.path.join(root, f))
                p = print_of(x)
                q = print_of(through(x, CHANNELS[(i + got) % len(CHANNELS)], 7 + got, np.zeros(len(x) + SR * 10, np.float32)))
                if p is not None and q is not None:
                    cohort_clean.append(p)
                    cohort_chan.append(q)
                    got += 1
cohort_clean, cohort_chan = np.array(cohort_clean), np.array(cohort_chan)
print(f'cohort: {len(cohort_clean)} prints of {len(cohort_clean) // 4} speakers; model {os.path.basename(model)}')


def scorers(here, crowd):
    def z(cohort, top=None):
        def score(p):
            sims = cohort @ p
            if top:
                sims = np.sort(sims)[-top:]
            return (float(p @ here) - sims.mean()) / (sims.std() + 1e-6)
        return score
    out = {
        'raw': lambda p: float(p @ here),
        'z-clean': z(cohort_clean),
        'z-chan': z(cohort_chan),
        'z-chan-top20': z(cohort_chan, 20),
        'nearest-chan': lambda p: float(p @ here) - float((cohort_chan @ p).max()),
    }
    if crowd is not None:
        out['crowd-diff'] = lambda p: float(p @ here) - float(p @ crowd)
    return out


for prefix in prefixes:
    truth = json.load(open(os.path.join(folder, f'{prefix}-truth.json')))
    for variant in ['clean', 'snr10', 'snr5', 'snr0']:
        path = os.path.join(folder, f'{prefix}-{variant}.wav')
        if not os.path.exists(path):
            continue
        audio = read(path)
        lines = []
        for l in truth['lines']:
            x = audio[int(l['start'] * SR): int(l['end'] * SR)]
            overlap = any(o is not l and o['speaker'] != l['speaker'] and o['start'] < l['end'] and o['end'] > l['start'] for o in truth['lines'])
            lines.append((l['speaker'], print_of(x), pieces(x), overlap))
        mine = [p for s, p, _, _ in lines if s == 'me' and p is not None]
        here = unit(np.sum(mine[:3], axis=0))
        crowd = None
        if variant != 'clean':
            # Chatter alone: the first second and the quiet between lines.
            spans = [(0.0, 1.0)]
            ends = sorted(l['end'] for l in truth['lines'])
            starts = sorted(l['start'] for l in truth['lines'])
            for e in ends:
                nxt = min((s for s in starts if s > e), default=None)
                if nxt is not None and nxt - e >= 1.0:
                    spans.append((e + 0.2, nxt - 0.2))
            chatter = np.concatenate([audio[int(a * SR): int(b * SR)] for a, b in spans])
            crowd = print_of(chatter)
        for name, score in scorers(here, crowd).items():
            me_lines = [score(p) for s, p, _, ov in lines if s == 'me' and p is not None and not ov]
            me_all = [score(p) for s, p, _, ov in lines if s == 'me' and p is not None]
            them = [score(p) for s, p, _, ov in lines if s == 'other' and p is not None and not ov]
            me_pieces = [score(q) for s, _, pc, _ in lines if s == 'me' for q in pc]
            them_pieces = [score(q) for s, _, pc, ov in lines if s == 'other' and not ov for q in pc]
            leaks = sum(t >= min(me_all) for t in them)
            print(f'{prefix}-{variant:5} {name:13} lines: me {min(me_all):6.2f}..{max(me_all):5.2f} them {min(them):6.2f}..{max(them):5.2f} '
                  f'gap {min(me_all) - max(them):5.2f} leaks {leaks}/{len(them)} | pieces: me p10 {np.percentile(me_pieces, 10):6.2f} '
                  f'them p90 {np.percentile(them_pieces, 90):6.2f} gap {np.percentile(me_pieces, 10) - np.percentile(them_pieces, 90):5.2f}')
