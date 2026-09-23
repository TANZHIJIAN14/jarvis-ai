#!/bin/sh
# Downloads the small ONNX models for wake word and voice activity detection into models/.
set -eu
cd "$(dirname "$0")/.."
mkdir -p models
OWW=https://github.com/dscripka/openWakeWord/releases/download/v0.5.1
fetch() { [ -s "models/$2" ] || curl -fsSL "$1" -o "models/$2"; }
fetch "$OWW/melspectrogram.onnx" melspectrogram.onnx
fetch "$OWW/embedding_model.onnx" embedding_model.onnx
fetch "$OWW/hey_jarvis_v0.1.onnx" hey_jarvis.onnx
fetch https://github.com/snakers4/silero-vad/raw/v5.1.2/src/silero_vad/data/silero_vad.onnx silero_vad.onnx
ls -l models
