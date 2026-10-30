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

Like against like (later that day): their recording is now compared with mine, and their voice as heard
here with mine as heard here, instead of the best of each pair. Through the earphone channel my voice as
learned here is much like anyone heard through it (their held lines were 0.56-0.67 like it, my own lines
0.48-0.79), while the two recordings tell them apart (theirs scores their lines 0.30-0.47 and mine
0.04-0.29; mine scores their lines 0.10-0.21 and my own 0.07-0.45). So speech for me is theirs when it is
somewhat like their recording (0.2, the `alike` bar) and 0.1 more like it than like mine, or clearly like
their voice here (0.4) and 0.1 more like it than like mine here; and their held lines teach their voice
here however like mine here they are, as nothing else would through earphones. Before → after with the
split, single runs: mine 859 → 878 of 1263, theirs leaked under my button 116 → 30 of 507, their held lines
348 → 355 of 510. The earphone sets, unchanged by the rule above, leaked 23/24/0 → 6/14/0 (251-5694),
16/16/0 → 0/0/4 (5536-777) and 15/15/0 → 0/5/0 (5694-251) at clean/10 dB/5 dB, with mine 68/54/21 →
82/54/21, 64/47/6 → 70/42/6 and 64/46/15 → 62/46/15; the clean-microphone sets leaked 1/1/5 → 0/1/0 and
0/0/0 → 0/0/0, with mine 81/79/62 → 81/79/62 and 89/93/70 → 89/92/77. `python3 -I gate_stats.py` counts
the gate's windows of these runs against the truth: of 916 windows with sound during my lines alone, 184
were judged someone else's, 174 of them under both of my bars (plain unlike my voice, mostly through
earphones in noise) and 10 by this rule; of 322 windows with sound during their unheld lines alone, 53
still passed as mine, 48 were kept out by their recording against mine alone, 17 by their voice here
against mine here alone, 119 by both and 85 by my bars alone. Tried with it and dropped: having the recognizer finalize when the gate closes in the middle
of a turn, so that the last words sent are given at once rather than held until more sound comes and
glued onto the next line. It cut my lines in two at every close on an interjection of theirs, and the
pieces failed the voice check more often than the whole lines had: mine 841 and theirs leaked 34 with it,
against 878 and 30 without.

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

### Words the recognizer gives and takes back (2026-10-30)

`node run.mts` now keeps what the recognizer sent back, raw, next to the clip (`<clip>.wav.deepgram.run.jsonl`,
every message with `at`, the clip's clock). `python3 -I deepgram_log.py count <logs...>` counts the final results
with nothing in them, and those among them whose interim results had words; `filled <logs...>` prints each of
those with the words kept from the interim results; `list <log> [from to]` prints the final results and the
interim results with text in order between two clip times.

Read for the earphone 5694-251 set at 10 dB, where my words had fallen from 46 to 39 of 75 between two runs of
the same rules, the log showed a final result with no words at all where the interim results before it, for the
same stretch of the connection's audio, had many: 47.7-51.4 s of the clip, interim "and ugly old day, the order
was given for the whole army crew." (13 words; the line reads "and still day the order was given for the whole
army to advance"), then an interim with nothing, then the final with nothing; their second held line, 22.8-26.8 s,
interim "There will be only a period of no groups of family." (11 words of "there was the old imperious note in
his failing whisper"), then nothing, then the final sent for CloseStream with nothing; and 52.7-56.3 s, interims
"for attack the medians" and "Point of", final nothing. The same stretches every run. The other final results
with nothing (9-18 s, my second and third lines) had no words in their interim results either: plain
recognition failure at 10 dB through the channel, which nothing on this side mends. So part of what the rules
were being measured on was the recognizer giving words and taking them back, which is also what the user sees
as words in the live caption that vanish. Over the five `--turns` sets (clean, 10 dB, 5 dB), 14 of the 246
final results with nothing, of 415, had words in their interim results, 65 words in all.

The client (`shared/pipeline/stt/deepgram.ts`) now remembers the latest interim result with words for a stretch
(by its `start`) and, when the final result for that stretch has no text and no words, keeps the interim's
words as heard, those that end within the final result's stretch: the interim result that was last to have
words can run past where the final pass cut the stretch, and the words past that point come again in the next
stretch ("Point of" at 21.3-21.8 s of the connection, past a final result ending at 20.85 s, and "point of
contact, inquired the other," right after it; kept whole, the first try translated "Point of point of contact").
Whose voice said them is judged further on, as for any words: in one run the recovered line on that clip was
split and "point of contact, inquired the other," left out as not my voice; in another the split kept most of it.
Over the five sets, single runs, the committed rules → with the words kept (with the split):

| clip | my words | theirs leaked under my button | their held words |
| --- | --- | --- | --- |
| 251-5694 clean | 81 → 81 of 78 | 0 → 0 of 30 | 30 → 30 of 30 |
| 251-5694 10 dB | 79 → 79 of 78 | 1 → 1 of 30 | 30 → 30 of 30 |
| 251-5694 5 dB | 62 → 64 of 78 | 0 → 1 of 30 | 30 → 30 of 30 |
| 5536-777 clean | 89 → 89 of 95 | 0 → 0 of 40 | 41 → 41 of 41 |
| 5536-777 10 dB | 92 → 92 of 95 | 0 → 0 of 40 | 41 → 41 of 41 |
| 5536-777 5 dB | 77 → 87 of 95 | 0 → 0 of 40 | 42 → 42 of 41 |
| earphone 251-5694 clean | 82 → 82 of 78 | 6 → 6 of 30 | 20 → 20 of 30 |
| earphone 251-5694 10 dB | 54 → 56 of 78 | 14 → 14 of 30 | 19 → 19 of 30 |
| earphone 251-5694 5 dB | 21 → 27 of 78 | 0 → 4 of 30 | 6 → 6 of 30 |
| earphone 5536-777 clean | 70 → 70 of 95 | 0 → 0 of 40 | 30 → 30 of 41 |
| earphone 5536-777 10 dB | 42 → 49 of 95 | 0 → 0 of 40 | 22 → 22 of 41 |
| earphone 5536-777 5 dB | 6 → 12 of 95 | 4 → 4 of 40 | 0 → 0 of 41 |
| earphone 5694-251 clean | 62 → 62 of 75 | 0 → 0 of 29 | 29 → 29 of 28 |
| earphone 5694-251 10 dB | 46 → 60 of 75 | 5 → 5 of 29 | 15 → 26 of 28 |
| earphone 5694-251 5 dB | 15 → 15 of 75 | 0 → 0 of 29 | 0 → 0 of 28 |
| all | 878 → 925 of 1263 | 30 → 35 of 507 | 355 → 366 of 510 |

What the words kept are joined to is the recognizer's choice, as for any words: it ends a line (UtteranceEnd) by
the last word it counted, so one may still come for the words before the stretch it emptied, and nothing ends
the words kept themselves; they wait in the segmenter for the next result that ends a line, in the app at the
latest until the button is let go. On the rig, where my button stays held over a whole stretch of lines, two
recovered pieces 16 s apart ("And turned back into the arabesque", mine, and "It's about daylight on", theirs)
came out 29 s later as one 15.4 s line judged mine as a whole, 4 of the 5 words leaked more above. Making the
words kept end their line at once was tried: mine 925 → 920 of 1263, theirs leaked 35 → 38 of 507, their held
366 → 366. The pieces judged alone are a second or two long and their prints the noisier for it: "And turned
back into the arabesque" alone (2.2 s) was skipped as 0.33 like my voice here, "It's about daylight on" alone
(1.1 s) passed at 0.42, "Beautiful to attack a median" alone was skipped at 0.39 and the "Point of contact,
inquired the other." after it passed on its own. The join had been doing the voice check as much good as harm.
Dropped.

A gate change tried with it: once their voice is known, a window for me alone that is like neither voice (under
0.2 like their recording and under 0.4 like their voice here) passes as 'maybe' rather than 'other', so that
the gate does not close on my own voice changed by the noise around beyond my bars (a tenth of my own pieces
through earphones on the rig), and the words are judged as a whole line. Alone, against the committed rules,
single runs: mine 878 → 873 of 1263, theirs leaked 30 → 25 of 507, their held 355 → 376 of 510 (the whole of
the last from earphone 5536-777 at 5 dB, 0 → 21, not through the changed path: run-to-run variation), per clip
within the variation between runs; at the gate on the clean-microphone runs 305 of 306 of my windows passed
and 20 of 109 of theirs, sorted out by the line rules. With the words kept: mine 925 → 928, theirs leaked
35 → 37, their held 366 → 396 (again the two earphone 5 dB clips, 6 → 15 and 0 → 21). On the earphone 5694-251
set at 5 dB their "I tell you, it is not poison, she cried", said under my button, went through the gate and,
joined under my label into a 20.6 s line 0.69 like my voice here, was translated: 0 → 9 of 29 leaked; at 10 dB
mine 60 → 52 with 5 → 0 leaked. A wash on my words, and the leak up where it matters most. Dropped: the gate
keeps closing on a window for me alone that is unlike my voice here.

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
