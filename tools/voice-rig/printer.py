#!/usr/bin/env python3
"""Voice prints over stdin/stdout with the app's CAM++ model, as the phone's module makes them:
request = <u32 LE byte count><16 kHz PCM16>, reply = <u32 LE float count><float32 embedding>, 0 floats when too short."""
import struct
import sys

import numpy as np
import sherpa_onnx

config = sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=sys.argv[1], num_threads=2)
extractor = sherpa_onnx.SpeakerEmbeddingExtractor(config)
inp, out = sys.stdin.buffer, sys.stdout.buffer
while True:
    header = inp.read(4)
    if len(header) < 4:
        break
    n = struct.unpack('<I', header)[0]
    buf = b''
    while len(buf) < n:
        chunk = inp.read(n - len(buf))
        if not chunk:
            sys.exit(0)
        buf += chunk
    pcm = np.frombuffer(buf, dtype=np.int16).astype(np.float32) / 32768.0
    stream = extractor.create_stream()
    stream.accept_waveform(sample_rate=16000, waveform=pcm)
    stream.input_finished()
    emb = np.array(extractor.compute(stream), dtype=np.float32) if extractor.is_ready(stream) else np.zeros(0, np.float32)
    out.write(struct.pack('<I', len(emb)) + emb.tobytes())
    out.flush()
