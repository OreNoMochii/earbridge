# Running EarBridge fully on the phone

The EarBridge app can send audio to a relay server, which uses Deepgram and DeepInfra, or call those services itself
with your own API keys. This page answers one question: could the phone do all three steps itself, with no server, no
internet and no API keys? The three steps are speech to text, translation, and reading the translation aloud.

This is research, done on 1 October 2026. Its Android setup is now in the app: choose **On this phone** under
**Translation**. See [How the app does it](#how-the-app-does-it). iPhone and the open models are still to do.

## Short answer

**Yes, on recent phones, with trade-offs.**

- **The phone's own engines are the light option.** iPhones (iOS 26) and Android phones (13 and later) have on-device
  speech recognition, translation and voices built in. They add little to the app, but each language is a one-time
  download of tens to hundreds of MB.
- **Open models work on every phone, but they are big.** Whisper for speech and a small language model for
  translation add up to about 3 GB, and they use more battery.
- **Quality drops.** The best small model translated 14 or 15 of 17 test sentences well. The cloud setup uses a much
  larger model (Gemma 4 31B) and Deepgram, so expect it to stay ahead on noise, slang and less common languages.
- **Fewer languages.** The app offers 34. Apple's newest speech model covers about 10, and the other options have gaps
  too.
- **Background limits.** Some on-device engines refuse to run while the screen is off.

## Recommended setup

| Step | iPhone (iOS 26 or later) | Android (13 or later) | Any phone, with open models |
|---|---|---|---|
| Speech to text | Apple SpeechAnalyzer | Android's on-device SpeechRecognizer | Whisper base or small (whisper.rn) |
| Translation | Apple's Translation framework | Google ML Kit Translation | Gemma 4 E2B (llama.rn) |
| Voice | The phone's voice (AVSpeechSynthesizer) | The phone's voice | The phone's voice (expo-speech) |
| Download | About 340 MB per language for speech, plus translation packs | About 30 MB per language for translation, plus speech packs (49–57 MB in our tests) | 2.6 GB for translation, plus 60–190 MB for speech |

Use the phone's own engines first: they are smaller and tuned for the hardware. Keep the open models for languages or
phones that the built-in engines don't cover.

For the voice, use the phone's own. Natural open voices are too slow: in published tests, Kokoro took about 2 s to
read one sentence on an iPhone 17 Pro.

## What we measured

### Translation models

The test set has 17 everyday sentences between English and 10 other languages: Spanish, French, German, Italian,
Portuguese, Russian, Arabic, Japanese, Korean and Chinese. Each model ran in llama.cpp on the GPU of an M4 Mac. The
general models were tested with the app's own translation prompt, and most also with a one-line prompt. Where a cell
shows a range, it covers both prompts. HY-MT1.5 and TranslateGemma, which are made for translation, got the prompt
their makers document.

- **Good:** correct and natural.
- **OK:** the right meaning, but stiff, too literal, or with a small slip.
- **Wrong:** meaning changed or lost, broken grammar, or the model answered the sentence instead of translating it.

| Model (4-bit) | File size | Good / OK / Wrong (of 17) | Median time per sentence (M4) | License |
|---|---|---|---|---|
| Gemma 3 1B | 0.72 GB | 8–9 / 3–5 / 4–5 | 0.17 s | Gemma terms |
| Qwen3 1.7B | 1.11 GB | 5–7 / 5–7 / 5 | 0.27–0.30 s | Apache 2.0 |
| HY-MT1.5 1.8B | 1.13 GB | 14 / 3 / 0 | 0.29 s | Tencent's license, which excludes the EU, the UK and South Korea |
| **Gemma 4 E2B**, thinking off | 2.62 GB | 14–15 / 1–2 / 1 | 0.29–0.31 s | Apache 2.0 |
| Gemma 3n E2B | 3.03 GB | 14 / 2–3 / 0–1 | 0.45 s | Gemma terms |
| Gemma 3 4B | 2.53 GB | 13 / 2 / 2 | 0.52 s | Gemma terms |
| Qwen3 4B Instruct 2507 | 2.50 GB | 11 / 4 / 2 | 0.53 s | Apache 2.0 |
| TranslateGemma 4B | 2.49 GB | 16 / 1 / 0 | 0.61–0.73 s | Gemma terms |

What this means:

- **Gemma 4 E2B is the best fit.** It is nearly as accurate as the 4B models, about as fast as the 1–2B ones, and
  openly licensed. About 1.5 GB of its 2.6 GB are lookup tables that the phone can read from storage as needed, so it
  needs less memory than its size suggests.
- **HY-MT1.5 1.8B is as good at less than half the size,** but its license doesn't allow use in the EU, the UK or South
  Korea.
- **TranslateGemma 4B was the most accurate,** but it is about twice as slow as Gemma 4 E2B and needs about 2.5 GB of
  memory. That is too much to run next to speech recognition on most phones.
- **Avoid the smallest models.** Gemma 3 1B and Qwen3 1.7B got 4 or 5 of the 17 sentences wrong. For example, Gemma 3
  1B turned "half past three" into "halb drei", which means 2:30 in German, and dropped "I lost my wallet" from another
  sentence.

These times come from an M4 Mac, not a phone. Phones are slower, and mid-range Android phones much more so.

### Speech recognition with Whisper

whisper.cpp ran on the same Mac. The test clips are one sentence in each of 7 languages, read by the Mac's built-in
voices. Real voices through a phone microphone, in a noisy place, will do worse.

| Whisper model (5-bit) | File size | Median time per sentence, M4 GPU | M4 processor (4 cores) | Errors: en / es / de / fr / it / ja / zh |
|---|---|---|---|---|
| tiny | 32 MB | 0.22 s | 0.79 s | 0 / 0 / 0 / 6 / 31 / 26 / 40 % |
| base | 60 MB | 0.25 s | 1.4 s | 0 / 13 / 0 / 6 / 15 / 21 / 40 % |
| small | 190 MB | 0.58 s | 3.8 s | 0 / 0 / 0 / 13 / 15 / 11 / 40 % |
| large-v3-turbo | 574 MB | 1.8 s | 16.6 s | 0 / 0 / 0 / 13 / 0 / 0 / 0 % |

- **Errors** are the share of words that came out wrong. For Japanese and Chinese, they are the share of characters.
- **The French and Chinese figures overstate the errors.** "Vingt heures" came out as "20 heures" or "20h". The
  tiny, base and small models wrote Traditional Chinese characters instead of Simplified ones; the words were right.
- **Every model recognized the language** in all 7 clips.
- **On Android, use the processor column.** whisper.rn uses the GPU only on iPhone. A phone's processor is also slower
  than an M4's.
- **Whisper base or small is the sensible choice.** large-v3-turbo is the most accurate, but too slow for live use on
  a phone.

### Apple's built-in engines

These ran on the Mac. macOS 26 has the same frameworks as iOS 26.

- **Speech to text (SpeechAnalyzer) ran fully offline.** When the app marks the end of each sentence itself, the final
  text arrives about 0.7 s after the speaker stops. English was exact, and Spanish was right apart from a missing
  opening "¿".
- **Speech models download without a prompt.** The Spanish model installed in 10 s. It was about 338 MB, covering
  four Spanish variants. An app can reserve at most 5 languages.
- **Arabic and Russian are missing** from the newest speech model. The older dictation model, which SpeechAnalyzer can
  also use, covers them.
- **The phone's voice is effectively instant.** It started in 0.1–0.5 s the first time each voice was used, and in
  about 20 ms after that.
- **The Translation framework was not measured.** It lists every language we tested, but each language pack needs the
  user's approval in a system sheet once, which a command-line test can't show. Its speed and quality still need
  testing on an iPhone.
- **Apple Intelligence isn't needed.** Its language model runs only on iPhone 15 Pro and newer, and it has no Arabic
  or Russian. It was turned off on the test Mac, so it wasn't measured either.

### Android's built-in engines

These ran in the app, in the Android emulator (Android 16), with test clips made by the Mac's voices. They have not
been tried on a real phone yet.

- **Speech to text:** the on-device SpeechRecognizer needs Android 13. Detecting the spoken language needs Android 14,
  so the app asks who is speaking instead, with **Me** and **Them**. Google says quality varies between phone makers.
- **Speech packs download on demand, after a prompt.** English was already installed. For Spanish and French, Android
  showed its own download dialog: 49 MB for Spanish and 57 MB for French, which then took 37 MB of storage. Android
  can also take a download over and finish it in its own time: French stopped reporting progress at 34%, and was ready
  about 3.5 minutes later.
- **Recognition is less accurate than Deepgram.** A Spanish test sentence came out right. In French, "près d'ici"
  ("near here") came out as "préjudice" in both runs, so the translation asked "Is there any damage?".
- **Translation:** ML Kit translates between 59 languages, about 30 MB each, and worked offline. Pairs without English
  go through English. Google describes it as "intended for casual and simple translations". It translates each
  sentence on its own, without the conversation around it.
- **Gemini Nano**, Google's on-device language model, refuses to run while the app is off screen, even with a
  foreground service. It can't power a locked-screen mode.

## Running with the screen off

- **Android:** this works, through the app's microphone foreground service. Since Android 14, the service must start
  while the app is on screen. It then keeps running. In the emulator, with the screen locked, **On this phone** kept
  recognizing, translating and speaking. One caveat: the phone's voice plays from the phone's text-to-speech app
  (Google's, in the emulator), not from EarBridge, and Android 16 logs that its playback "would be muted" in the
  background. It wasn't muted, but a later Android version might mute it. Having the voice write its audio to a file,
  for EarBridge to play, would avoid that.
- **iPhone:** recording must start while the app is on screen. The `audio` background mode then lets it continue.
  Whether SpeechAnalyzer and the Translation framework keep working while the phone is locked needs testing on a
  device. App Review also checks that background audio is used for its intended purpose.

## Memory

- **iPhone:** an app gets less memory than the phone has. One report measured about 3.3 GB for an app on an 8 GB
  iPhone 15 Pro Max, or about 6 GB with Apple's increased-memory entitlement. Gemma 4 E2B with Whisper base or small
  should fit on 8 GB iPhones; 6 GB iPhones will be tight. This is untested.
- **Android:** there is no fixed limit for model memory, but the system closes apps that use too much. We estimate
  about 2 GB is safe on mid-range phones.

## How the app does it

On Android, **On this phone** uses the recommended setup above. The conversation runs in the app instead of on a
server, with the same code the server uses for one-phone conversations, in `shared/pipeline/`. The screens work the
same way.

1. **Speech to text:** the app's own native module, `EarbridgeOnDeviceModule.kt`, gives the on-device
   SpeechRecognizer the audio that the app already records, through a pipe. The recognizer doesn't open a microphone
   itself, so it hears the one chosen under **Advanced → Microphone**, and it keeps working inside the app's
   foreground service while the screen is off. It listens for one language at a time, so the app asks who is
   speaking, with **Me** and **Them**.
2. **Translation:** ML Kit, through the same module. A missing language downloads the first time it is used.
3. **Voice:** the phone's own voice, through expo-speech, as in the other modes.

Still to do:

- **iPhone:** react-native-nitro-speech is the only React Native library for SpeechAnalyzer. It stops listening when
  the app goes to the background, so screen-off use needs a modified copy, or a native module like Android's.
  expo-translate-text uses Apple's Translation framework. It translates one sentence at a time.
- **Open models,** for the languages and phones that the built-in engines don't cover: whisper.rn for speech, and
  llama.rn with Gemma 4 E2B for translation.

Room mode still needs a server to connect the phones. But each phone could recognize and translate on its own, and
send only text.

Versions checked: expo-speech-recognition 57.1.0, react-native-nitro-speech 0.4.9, expo-translate-text 0.3.0,
whisper.rn 0.7.4 and llama.rn 0.12.9.

## How we tested

- **Computer:** Apple M4 with 16 GB, macOS 26.5.1, llama.cpp build 11146 and whisper.cpp 1.9.4.
- **Translation:** llama-server with a 4,096-token context, temperature 0.2, streaming. Claude, the AI assistant that
  ran the tests, graded each translation. No native speakers checked the grades.
- **Speech:** clips made with macOS's `say` voices at 16 kHz, with silence before and after each sentence.
- **Noise:** other jobs ran at the same time, so the timings are a little noisy.
