"""Does a twin print of my recording, heard as through the earphone channel, bring my lines through
that channel nearer to it than the stranger's? For each clip set: every solo line's likeness to the
recording printed clean, band-limited (300-3400, 300-2500) and band-limited with room (channels A,
B), and the best of several; my lines (min/median/max) against the stranger's (max), and how many
of each pass `alike` (0.2) and `same` (0.4).
usage: python -I twin.py <model.onnx> <rig clips folder> <channel.py folder> <set prefix>..."""
import json, os, sys, wave
import numpy as np
import sherpa_onnx

model, folder, chanfolder, prefixes = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
sys.path.insert(0, chanfolder)
from channel import band, reverb  # noqa: E402

ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=2))
SR = 16000


def read(path):
    with wave.open(path, 'rb') as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32)


def print_of(x):
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


VARIANTS = {
    'clean': lambda r: r,
    'band3k4': lambda r: band(r, 300, 3400),
    'band2k5': lambda r: band(r, 300, 2500),
    'chanA': lambda r: reverb(band(r, 300, 3400), 0.3, 0.2, 1),
    'chanB': lambda r: reverb(band(r, 300, 2500), 0.5, 0.4, 2),
}
BEST = {'best-all': list(VARIANTS), 'clean+band3k4': ['clean', 'band3k4'], 'clean+chanA': ['clean', 'chanA'],
        'clean+chanB': ['clean', 'chanB']}

for prefix in prefixes:
    truth = json.load(open(os.path.join(folder, f'{prefix}-truth.json')))
    rec = read(os.path.join(folder, f'{prefix}-recording.wav'))
    recs = {name: print_of(f(rec)) for name, f in VARIANTS.items()}
    for variant in ['clean', 'snr10', 'snr5']:
        path = os.path.join(folder, f'{prefix}-{variant}.wav')
        if not os.path.exists(path):
            continue
        audio = read(path)
        lines = []
        for l in truth['lines']:
            x = audio[int(l['start'] * SR): int(l['end'] * SR)]
            overlap = any(o is not l and o['speaker'] != l['speaker'] and o['start'] < l['end'] and o['end'] > l['start'] for o in truth['lines'])
            p = print_of(x)
            if p is not None and not overlap:
                lines.append((l['speaker'], {name: float(p @ r) for name, r in recs.items()}))

        def report(name, score):
            me = [score(s) for spk, s in lines if spk == 'me']
            them = [score(s) for spk, s in lines if spk == 'other']
            if not me or not them:
                return
            print(f'{prefix}-{variant:5} {name:14} me {min(me):5.2f}/{np.median(me):5.2f}/{max(me):5.2f} '
                  f'(>=.4 {sum(v >= 0.4 for v in me)}/{len(me)}, >=.2 {sum(v >= 0.2 for v in me)}/{len(me)})  '
                  f'them max {max(them):5.2f} (>=.4 {sum(v >= 0.4 for v in them)}/{len(them)}, >=.2 {sum(v >= 0.2 for v in them)}/{len(them)})  '
                  f'gap {min(me) - max(them):5.2f}')

        for name in VARIANTS:
            report(name, lambda s, n=name: s[n])
        for name, names in BEST.items():
            report(name, lambda s, ns=names: max(s[n] for n in ns))
        print()
