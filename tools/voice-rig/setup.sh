#!/bin/sh
# Sets the rig up: a Python venv with sherpa-onnx (CAM++ voice prints, the model the phone uses),
# the model itself, a stand-in recording of "my" voice, and the test clips. macOS only (uses `say`).
set -e
cd "$(dirname "$0")"
[ -d venv ] || python3 -m venv venv
./venv/bin/pip install -q sherpa-onnx numpy
mkdir -p model
[ -f model/campplus.onnx ] || curl -sL -o model/campplus.onnx \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx
[ -f recording.wav ] || say -v Daniel -o recording.wav --data-format=LEI16@16000 \
  "My name is Daniel and this is my voice, recorded so that the app can tell it apart from the others. I usually speak at a normal pace, in a quiet room, holding the phone in front of me. One, two, three, four, five, six, seven, eight, nine, ten."
[ -f clips/clean.wav ] || ./venv/bin/python clips/make_clips.py
[ -f clips/late-clean.wav ] || ./venv/bin/python clips/make_clips.py --late
echo "ready: node run.mts clips/clean.wav"
