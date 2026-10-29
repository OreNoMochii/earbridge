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

To try another speaker model in place of the phone's: `VOICE_MODEL=<path to its .onnx> node run.mts clips/clean.wav`
(any model sherpa-onnx's speaker embedding extractor loads; the recording and every print of the run are then made with it).
The bars that go with a model (how alike its prints must be to be one voice: `VoiceBars` in `shared/pipeline/voices.ts`)
are taken from its file name (CAM++'s, or ERes2Net's for a file named so) or given: `VOICE_BARS=same,alike,unlike`;
the run's first line says which were used.

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
venv/bin/python -I clips/make_real_clips.py <LibriSpeech/dev-clean folder> --me 251 --other 5694 --late [--turns] [--earphone]
node run.mts clips/real-late-251-5694-clean.wav
```

That writes `clips/real-late-251-5694-{clean,snr10,snr5,snr0}.wav`, the truth, and `real-late-251-5694-recording.wav`,
"my" recording made of three other sentences of reader 251 (20 s), which `run.mts` uses in place of the
stand-in for any clip set that has one. `--late` and `--earphone` mean what they do for `make_clips.py`; `--turns`
(`real-late-turns-251-5694-*`) puts three lines of the other reader's first, said holding the "Them" button (the
truth marks them `held`, and `run.mts` holds that button over them, from half a second before to half a second
after), so that their voice is learned from what they say for themselves before they talk over my lines, as in a
real talk; the summary line then also counts their held words kept (`held for them: 29/32 theirs`). `--turns`
also writes their recording, `real-late-turns-251-5694-partner.wav` (three other sentences of theirs, 20 s),
which `run.mts` gives the talk as the other person's voice recorded in an earlier talk, unless `RIG_PARTNER=none`
makes it learn their voice from their held lines instead; the earphone channel itself is `clips/channel.py`,
shared by both makers. Readers are chosen by number:
each reader's own lines are 0.61-0.93 like their recording, and the nearest other reader of the same
gender gets 0.41-0.45 (men) or up to 0.52 (women) like it, so a man's "1 in 100" stranger over the `same` bar
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
Through that channel the recording itself still tells the two apart, only lower down: my lines are 0.24-0.44 like
it (0.02-0.37 in chatter) and his at most 0.08-0.15, under `alike`; it is my voice learned here, made of my lines as
the channel colours them, that his lines come near (0.48-0.67 like a voice of two or three such lines). A twin print
of the recording heard as through the channel (band-limited, with or without room, `probe/twin.py`) does not help:
my lines rise to 0.43-0.87 like it, but so do his, to 0.42-0.65, and the gap is gone.

## Probes

`probe/` holds the measurements behind the numbers above, run with the rig's venv (`venv/bin/python -I probe/<name>.py`,
each prints its usage at the top of the file): `separation.py` scores every solo line of the real-voice clip sets
against my voice as settled from my first three lines, with one speaker model and several scorings (raw cosine,
z-norm against a cohort of the other readers heard clean or through the channel, the cosine less the chatter's or
the nearest cohort voice's), whole lines and 1.5 s pieces, and prints the gap between my least alike line and the
stranger's most alike; `twin.py` scores the lines against the recording printed clean and through the channel;
`scores.py` writes every line of the clip sets as one model prints it (talker, times, words, whether anyone talks
over it, likeness to my recording, the print itself) to a JSON file, over which `sweep.py` replays the app's
whole-line rule for held "Me" lines with any bars, without the recognizer, and counts my words lost and the other
talker's let through, in all and by kind of clip (plain or earphone channel, clean or in chatter), then over a grid
of bars (`--solo`: lines nobody talks over only, as the app judges the rest by their parts); `speed.py` times a
model's print of 1.5 s and 10 s of speech on this Mac, one thread.

### The other person's voice over my button (2026-10-30)

With their voice known, speech for me that is clearly theirs (0.4 like their voice, the `same` bar) and 0.1 more
like theirs than like mine is theirs, however like mine it is (`VoiceFilter.ratherTheirs`): at the gate (their
windows close it), on whole held lines and on parts of split lines. Five `--turns` sets, their voice recorded
(`clips/<set>partner.wav`), before → after with the split, single runs (Deepgram itself varies by a few words
between runs): mine 865 → 859 of 1263 words, theirs leaked under my button 176 → 116 of 507. On the clean
microphone, 251-5694 leaked 12/24/25 → 1/1/5 of 30 (clean, 10 dB, 5 dB) with mine 81/79/61 → 81/79/62 of 78,
and 5536-777 leaked 6/0/0 → 0/0/0 of 40 with mine 91/94/76 → 89/93/70 of 95; the loss at 5 dB was one 1.7 s
part of mine 0.42 like me and 0.54 like theirs taken for theirs, and Deepgram mishearing the start of my next
line after the gate had closed over theirs. The three earphone-channel sets did not change at all: through that
channel their lines are 0.26-0.50 like their recording, mostly under the bar, so the rule never fires, as it
would not for the user's own lines through earphones (0.04-0.25 like the recording). With their voice learned
from three held lines instead (`RIG_PARTNER=none`), it was learned on 5536-777 only (on the other sets their
held lines are 0.4 like mine and so are taken as mine translating for them): there leaked 6/6/0 → 0/1/0 and
mine 90/95/75 → 91/93/77.

### Other speaker models (2026-10-30)

Ten models sherpa-onnx ships were measured with `separation.py` on the three earphone sets, clean and at 10 dB, by
the raw gap between my least alike line and the stranger's most alike against a voice settled from my first three
lines: the phone's CAM++ gives 0.14 / 0.11 (251 vs 5694), 0.00 / -0.16 (5694 vs 251, the uneven voice) and
0.15 / 0.13 (5536 vs 777); ERes2Net VoxCeleb 0.18 / 0.07, 0.22 / -0.09 and 0.19 / 0.18; TitaNet small
0.18 / 0.07, 0.05 / -0.08 and 0.07 / 0.16; the rest no better (CAM++ VoxCeleb en and the WeSpeaker CAM++, ResNet34
and ResNet152 LM models under zero everywhere; ERes2Net base 200k and ERes2NetV2 zh-cn within 0.1 of zero;
ERes2Net large zh-cn 0.31 on one set and under zero on another). No model separates the 1.5 s pieces, and no
other scoring is better than the raw cosine: z-norm against the cohort heard through the channel widens the gap
on clean lines but closes or reverses it in chatter and on the pieces. Six went on to `sweep.py`, over the solo
lines of 52 clips (2288 of my words, 996 of a stranger's): my words lost / the stranger's let through at CAM++'s
bars (0.4 / 0.2 / 0.3) and at the best bars of the grid, and the time of a print on this Mac (one thread):

| model | at CAM++'s bars | best bars (same / alike / unlike) | lost / let through | ms per 1.5 s / 10 s |
| --- | --- | --- | --- | --- |
| CAM++ zh-en (3D-Speaker; the phone's) | 177 / 346 | 0.55 / 0.15 / 0.55 | 111 / 225 | 49 / 324 |
| ERes2Net VoxCeleb (3D-Speaker) | 147 / 356 | 0.5 / 0.15 / 0.5 | 125 / 114 | 147 / 1121 |
| ERes2NetV2 zh-cn (3D-Speaker) | 26 / 862 | 0.65 / 0.35 / 0.6 | 111 / 233 | 362 / 2326 |
| TitaNet small (NeMo) | 415 / 162 | 0.45 / 0.15 / 0.45 | 304 / 144 | 45 / 296 |
| CAM++ LM (WeSpeaker, VoxCeleb) | 779 / 321 | 0.5 / 0.1 / 0.5 | 399 / 601 | 58 / 270 |
| ResNet34 LM (WeSpeaker, VoxCeleb) | 0 / 996 | 0.6 / 0.45 / 0.6 | 111 / 687 | 111 / 879 |

Only ERes2Net VoxCeleb does better than the phone's model, and the whole of its gain is the higher `unlike`
floor: at 0.5 the stranger's lines through the earphone channel stay under it while mine stay over, on these
clips; at a 0.4 floor it is about even with CAM++ (100 / 256 against CAM++'s 98 / 289, both at 0.5 / 0.15 / 0.4).
On the phone the user's own lines through earphones were 0.43-0.73 like their voice here, which a 0.5 floor would
cut into, and it prints three times slower, on a phone whose gate judges every 0.5 s; so the phone keeps CAM++
and its bars, and the bars now travel with the model (`VoiceBars` in `shared/pipeline/voices.ts`, chosen in
`mobile/src/engines/voices.ts`) so that a swap is a change of one constant. Retuning CAM++'s own bars was not
done either: the grid's best for it raises `same` to 0.55, which on the phone would lose the user's lines 0.4-0.5
like their voice here and under 0.15 like their recording (their earphone lines are 0.04-0.25 like it), and
`unlike` at 0.4 sits at the edge of their least alike line, 0.43. End to end (`node run.mts` on the 21 clips of the seven
sets, clean and in chatter at 10 and 5 dB; my words kept / the stranger's let through, with the split, summed over
each group of sets; every run on a Mac under a load of 20-27 from other work):

| clips (my words / a stranger's, per variant) | model and bars | clean | 10 dB | 5 dB | all |
| --- | --- | --- | --- | --- | --- |
| macOS voices (late, late-earphone-fred): 144 / 56 | CAM++ at the app's, 0.4 / 0.2 / 0.3 | 142 / 19 | 116 / 18 | 114 / 0 | 372 / 37 |
| | ERes2Net VoxCeleb at its own, 0.5 / 0.15 / 0.5 | 138 / 0 | 111 / 0 | 111 / 4 | 360 / 4 |
| readers (real-late-251-5694, -5536-777): 173 / 70 | CAM++ | 174 / 19 | 172 / 15 | 138 / 13 | 484 / 47 |
| | ERes2Net | 172 / 2 | 172 / 24 | 115 / 4 | 459 / 30 |
| readers through the earphone channel (real-late-earphone-251-5694, -5536-777, -5694-251): 248 / 99 | CAM++ | 224 / 44 | 122 / 16 | 55 / 7 | 401 / 67 |
| | ERes2Net | 182 / 0 | 112 / 25 | 50 / 0 | 344 / 25 |
| all 21 clips: 1695 / 675 | CAM++ | 540 / 82 | 410 / 49 | 307 / 20 | 1257 / 151 |
| | ERes2Net | 492 / 2 | 395 / 49 | 276 / 8 | 1163 / 59 |

ERes2Net at its own bars lets through less than half as many of the stranger's words and keeps 94 fewer of mine:
it rejects the stranger's whole lines over the button that CAM++ passes as my voice here (0.07 like my recording
where CAM++ sees 0.23), and its split leaves out more of my own words in mixed lines (parts 0.25-0.34 like my
voice here, under its 0.5 floor); in chatter at 10 dB the two let through the same number. CAM++ at
0.5 / 0.15 / 0.4 end to end is no better than at the app's bars (1196 / 137). A line sitting at a bar moves these
counts from run to run: the Fred clip's 19 words let through here were 1 in the runs of 2026-10-29 and early
2026-10-30 under the same rules, his line being 0.43 like my voice here against a bar of 0.40.

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
