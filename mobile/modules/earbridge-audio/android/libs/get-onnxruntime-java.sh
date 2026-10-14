#!/bin/bash
# Gets the ONNX Runtime Java library that separating voices uses (VoiceIsolator.kt): the Java
# API into libs/onnxruntime-<version>.jar, and its JNI library into src/main/jniLibs, from the
# Android build sherpa-onnx's author publishes, which is the one sherpa-onnx bundles. The Java
# side must be of exactly the runtime's version, as the runtime's symbols carry it
# (VERS_1.28.2), and Maven Central's onnxruntime-android has no 1.28.2: its 1.28.0 fails to
# load against the bundled runtime. The runtime itself (libonnxruntime.so) comes with
# sherpa-onnx, and so is not kept here.
set -euo pipefail
VERSION=1.28.2
URL="https://github.com/csukuangfj/onnxruntime-libs/releases/download/v$VERSION/onnxruntime-android-$VERSION.zip"
SHA256=01518867f78241138b6aa25925802e843a4fa9085af8d303d49e35bbb52aff4d
HERE=$(cd "$(dirname "$0")" && pwd)
JNI_LIBS="$HERE/../src/main/jniLibs/arm64-v8a"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

curl -sSL -o "$WORK/upstream.zip" "$URL"
echo "$SHA256  $WORK/upstream.zip" | shasum -a 256 -c -
unzip -q "$WORK/upstream.zip" classes.jar jni/arm64-v8a/libonnxruntime4j_jni.so -d "$WORK"

rm -f "$HERE"/onnxruntime-*.jar
cp "$WORK/classes.jar" "$HERE/onnxruntime-$VERSION.jar"
mkdir -p "$JNI_LIBS"
cp "$WORK/jni/arm64-v8a/libonnxruntime4j_jni.so" "$JNI_LIBS/libonnxruntime4j_jni.so"
shasum -a 256 "$HERE/onnxruntime-$VERSION.jar" "$JNI_LIBS/libonnxruntime4j_jni.so"
