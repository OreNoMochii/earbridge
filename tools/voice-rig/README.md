# Voice rig

Plays a clip through the app's real pipeline on this Mac and scores what would have been translated: the same
`SoloConversation` as the phone, the real Deepgram recognizer (with who-said-what labels on, as with your own keys),
and real CAM++ voice prints, made with the same model the phone uses. "Me" holds the button throughout. It is how the
noisy-place filters are measured without a phone or a bar; each run costs a few cents of Deepgram time.

```sh
./setup.sh                      # once: Python venv with sherpa-onnx, the CAM++ model, a stand-in recording of "my"
                                # voice (the macOS voice Daniel), and the clips (macOS only: it uses `say`)
node run.mts clips/clean.wav    # needs DEEPGRAM_API_KEY in the repository's .env
```

Clips (`clips/make_clips.py`): me (Daniel) and another talker (Samantha) over 27 s, the other interrupting
between and over my lines; `clean`, and the same under a crowd's chatter at 10, 5 and 0 dB SNR. The `late-*` clips
put three more of my lines, with pauses between, first, so that my voice as heard here is settled (three prints) before anyone else talks,
as in a conversation that has gone on for a minute. `truth.json` / `late-truth.json` hold each line's talker and
times. With a voice named (`clips/make_clips.py Tessa --late`), that voice is the other talker and the clips are named
after it (`late-tessa-*`, `late-tessa-truth.json`): Tessa's and Fred's voices are the hardest strangers for the phone's
model, 0.38 and 0.29 like the Daniel recording (Samantha 0.25; Daniel himself 0.93), as close as the user found other
talkers' voices to their own in real places. With `--earphone` (`clips/make_clips.py Fred --late --earphone`,
`late-earphone-fred-*`), every line is heard as through an earphone microphone in a loud place: the telephone band
(300-3400 Hz, what a Bluetooth earphone's microphone delivers), some of the room, and now and then the chatter louder
for a moment, differing line to line. My voice here is then learned unevenly, as the user's AirPods lines are (0.43-0.73
like the voice learned from them), and the other voices come much nearer to it on such a channel (Fred 0.5-0.6 like my
voice learned through it, against 0.2-0.4 clean), which is what makes real places hard. The recording stays full-band,
as the user's was made on another microphone. On these clips the app as of 49cc1cf keeps 68-73 of my 72 words without chatter but lets 0 (Samantha), 8
(Tessa) and 19 (Fred) of the 28 stranger words through, Fred's whole lines passing as clearly mine at 0.43-0.61 like my
voice here (my own lines are 0.65-0.89, their 1.5 s pieces 0.43-0.68); at 10 dB and 5 dB of chatter it keeps 32-53 of
my words and lets 0-18 stranger words through, the recognizer returning nothing for my two lines through the harshest
channels although the gate sent them on.

A run prints each line as the app judged it (translated or skipped, how alike my recording and my voice here it was,
its parts when the recognizer heard two talkers and what was left out), then counts: of my words and the other
talker's, how many would have been translated under the whole-line rule alone, and with the parts. It writes the
talk report and the messages to `clips/<clip>.wav.run.jsonl`.

Nothing generated is committed (see `.gitignore`), and the key is read from `.env` only.

## Real voices

The macOS voices are few and even. `clips/make_real_clips.py` builds the same kind of clips from recorded
human voices, the 40 readers (20 men, 20 women) of LibriSpeech's `dev-clean` set (337 MB, from
`https://www.openslr.org/resources/12/dev-clean.tar.gz`, unpacked anywhere outside the repo), with the lines
of a set at one loudness (RMS 2000) and chatter made of six more readers' sentences:

```sh
venv/bin/python -I clips/make_real_clips.py <LibriSpeech/dev-clean folder> --me 251 --other 5694 --late [--earphone]
node run.mts clips/real-late-251-5694-clean.wav
```

That writes `clips/real-late-251-5694-{clean,snr10,snr5,snr0}.wav`, the truth, and `real-late-251-5694-recording.wav`,
"my" recording made of three other sentences of reader 251 (20 s), which `run.mts` uses in place of the
stand-in for any clip set that has one. `--late` and `--earphone` mean what they do for `make_clips.py`;
the earphone channel itself is `clips/channel.py`, shared by both makers. Readers are chosen by number:
each reader's own lines are 0.61-0.93 like their recording, and the nearest other reader of the same
gender gets 0.41-0.45 (men) or up to 0.52 (women) like it, so a man's "1 in 100" stranger over SAME_VOICE
is a certainty among twenty: 251 vs 5694 (an even voice, 0.85 like its own recording at the least, against
its nearest, 0.44), 5694 vs 251 (an uneven one, 0.66), 5536 vs 777 (0.45), 1272 vs 2412 (a woman: the easy case).

Measured on these (my words kept / the other reader's words let through, with the parts): without the earphone
channel the voice here tells the two readers apart as it does the macOS voices, 0.65-0.95 like my own lines
against 0.12-0.54 for his once it is settled (over 0.45 only in 5 dB of chatter), and what leaks is his whole lines that happen to be 0.42-0.45
like my recording (the "clearly mine" bar), his words said over mine that the recognizer labels as one talker's,
and short parts of 1-2 s whose prints reach 0.4 by chance. Such a line, once learned from as mine, dragged my voice
here his way and lowered the bar from 0.48 to 0.30 for the rest of the talk; since LEARN_MARGIN (`shared/pipeline/voices.ts`)
a settled voice here is not learned from a line much less like it than my own lines have been, which brought his
leaked words from 13 to 10 of 30 (251 vs 5694) and from 12 to 8 of 40 (5536 vs 777) without chatter, mine unchanged
(79-81 of 78, 98 of 95), and changed nothing in chatter or on the macOS voices. Through the earphone channel his lines come to
0.52-0.67 like my voice here while my own range from 0.41 to 0.91, so no bar on this measure separates them:
251 vs 5694 lets 11 of his 30 words through without chatter, 5536 vs 777 23 of 40, and in chatter the
recognizer drops most of my lines before any voice check (15-21 of my 75-95 words kept at 5 dB).

## Reading real talks

Test builds of the app (made with `EXPO_PUBLIC_TALK_REPORT=1`) keep a report of each talk on
the phone, one JSON line per event in the same shape as the rig's `clips/<clip>.wav.run.jsonl`
(see `shared/pipeline/report.ts`). `./pull_reports.sh <folder outside the repo>` pulls them all
over adb and reads each with `python3 -I report.py <report.jsonl>`, which prints every line
heard with its loudness, its likeness to my recording and to my voice here, the recognizer's
talker labels on its words and the parts left out, then the gate's windows by verdict, and a
summary comparing my held lines with the other voices heard: in loudness, in likeness and in
labels (`--full` for whole texts, `--gate` for every gate window). The reports and the printed
output hold the words of everyone heard, so they stay out of the repo. The reader works on the
rig's runs too.
