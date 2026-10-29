"""Every line of the clip sets as the app would print it with a speaker model: its talker, times,
words, whether another talker overlaps it, how alike it is to my recording, and the print itself,
so that the whole-line rule can be replayed with any bars (sweep.py) without the recognizer.
usage: python -I scores.py <model.onnx> <rig folder> <out.json> <set prefix>...   (variants clean, snr10, snr5, snr0)"""
import json, os, sys, wave
import numpy as np
import sherpa_onnx

model, rig, out, prefixes = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=2))
SR, LOUDNESS, MAX_PRINT_SECONDS = 16000, 0.1, 10


def read(path):
    with wave.open(path, 'rb') as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0


def print_of(x):
    """As the app prints speech: its middle 10 s at most, brought to the loudness prints are made at."""
    if len(x) > SR * MAX_PRINT_SECONDS:
        mid = len(x) // 2
        x = x[mid - SR * 5: mid + SR * 5]
    peak = float(np.abs(x).max())
    if peak == 0:
        return None
    x = x * min(LOUDNESS / (float(np.sqrt(np.mean(x * x))) + 1e-9), 1 / peak)
    s = ex.create_stream()
    s.accept_waveform(sample_rate=SR, waveform=x)
    s.input_finished()
    if not ex.is_ready(s):
        return None
    e = np.array(ex.compute(s), dtype=np.float32)
    return e / (np.linalg.norm(e) + 1e-9)


sets = {}
for prefix in prefixes:
    truth = json.load(open(os.path.join(rig, 'clips', f'{prefix}-truth.json')))
    rec_path = os.path.join(rig, 'clips', f'{prefix}-recording.wav')
    if not os.path.exists(rec_path):
        rec_path = os.path.join(rig, 'recording.wav')
    rec = print_of(read(rec_path))
    for variant in ['clean', 'snr10', 'snr5', 'snr0']:
        path = os.path.join(rig, 'clips', f'{prefix}-{variant}.wav')
        if not os.path.exists(path):
            continue
        audio = read(path)
        lines = []
        for l in sorted(truth['lines'], key=lambda l: l['start']):
            x = audio[int(l['start'] * SR): int(l['end'] * SR)]
            p = print_of(x)
            if p is None:
                continue
            overlap = any(o is not l and o['speaker'] != l['speaker'] and o['start'] < l['end'] and o['end'] > l['start'] for o in truth['lines'])
            lines.append({'speaker': l['speaker'], 'start': l['start'], 'seconds': round(l['end'] - l['start'], 2),
                          'words': len(l['text'].split()), 'overlap': overlap, 'rec': round(float(p @ rec), 3),
                          'print': [round(float(v), 5) for v in p]})
        sets[f'{prefix}-{variant}'] = lines
        me = [l['rec'] for l in lines if l['speaker'] == 'me']
        them = [l['rec'] for l in lines if l['speaker'] != 'me']
        print(f'{prefix}-{variant:5}: vs recording me {min(me):.2f}..{max(me):.2f} them {min(them):.2f}..{max(them):.2f}', flush=True)
json.dump({'model': os.path.basename(model), 'sets': sets}, open(out, 'w'))
