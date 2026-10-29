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
talkers' voices to their own in real places.

A run prints each line as the app judged it (translated or skipped, how alike my recording and my voice here it was,
its parts when the recognizer heard two talkers and what was left out), then counts: of my words and the other
talker's, how many would have been translated under the whole-line rule alone, and with the parts. It writes the
talk report and the messages to `clips/<clip>.wav.run.jsonl`.

Nothing generated is committed (see `.gitignore`), and the key is read from `.env` only.
