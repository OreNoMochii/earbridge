#!/bin/bash
# Pulls the talk reports Alo keeps on the phone (test builds made with EXPO_PUBLIC_TALK_REPORT=1
# only) into a folder and reads each one with report.py, writing <name>.txt next to it.
# Usage: pull_reports.sh <folder outside the repo> [adb serial]
# The reports hold the words of everyone heard: keep that folder out of the repo.
set -e
OUT=${1:?folder to pull into}
SERIAL=${2:-$ANDROID_SERIAL}
ADB="${ADB:-$HOME/Library/Android/sdk/platform-tools/adb}"
[ -n "$SERIAL" ] && ADB="$ADB -s $SERIAL"
HERE=$(cd "$(dirname "$0")" && pwd)
REPORTS=/sdcard/Android/data/app.earbridge.mobile/files/reports
mkdir -p "$OUT"
echo "on the phone:"
$ADB shell ls -la "$REPORTS/" | tr -d '\r'
$ADB pull "$REPORTS/" "$OUT/" >/dev/null
for f in "$OUT"/reports/*.jsonl; do
  [ -e "$f" ] || { echo "no reports"; exit 0; }
  python3 -I "$HERE/report.py" "$f" > "${f%.jsonl}.txt"
  echo "$(wc -l < "$f" | tr -d ' ') entries: $f -> ${f%.jsonl}.txt"
done
