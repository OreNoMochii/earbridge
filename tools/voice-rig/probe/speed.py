"""Seconds per print for a speaker model on this Mac: 1.5 s and 10 s of speech, 1 thread, best of 5.
usage: python -I speed.py <model.onnx>..."""
import sys, time, os
import numpy as np
import sherpa_onnx
SR = 16000
rng = np.random.default_rng(1)
for model in sys.argv[1:]:
    ex = sherpa_onnx.SpeakerEmbeddingExtractor(sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=model, num_threads=1))
    out = []
    for secs in (1.5, 10):
        x = (rng.standard_normal(int(SR * secs)) * 0.05).astype(np.float32)
        best = 9e9
        for _ in range(5):
            t = time.perf_counter()
            s = ex.create_stream(); s.accept_waveform(sample_rate=SR, waveform=x); s.input_finished(); e = ex.compute(s)
            best = min(best, time.perf_counter() - t)
        out.append(f'{secs:4}s: {best*1000:6.1f} ms')
    print(f'{os.path.basename(model)[:50]:50} dim {len(e):3} ' + '  '.join(out))
