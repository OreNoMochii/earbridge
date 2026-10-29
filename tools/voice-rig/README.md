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
