# EarBridge

Live conversation translation for **any** earphones: AirPods, other Bluetooth buds, or wired ones.

Apple built live translation into AirPods. EarBridge does the same for any earphones. It is a web app: open it in
your phone's browser, put your earphones in and talk. Deepgram turns speech into text, Claude translates it, and the
phone's built-in voice reads the translation into your ears. The earphones need nothing special, because the app uses
whatever microphone and audio output the phone is already using.

## How it works

```
 phone (browser)                           relay server (this repo)
┌──────────────────────────┐  WebSocket  ┌──────────────────────────┐
│ microphone → 16 kHz PCM  │ ──────────► │ one session per phone    │ ──► Deepgram: streaming speech-to-text
│                          │             │ rooms, recent context    │
│ transcript + translation │ ◄────────── │                          │ ──► Claude: translation, streamed
│ spoken → your earphones  │    text     └──────────────────────────┘
└──────────────────────────┘
```

1. The phone streams its microphone to the relay server as 16 kHz audio over a WebSocket.
2. The relay forwards the audio to Deepgram. Deepgram sends back a live transcript and marks where each sentence ends.
3. Each finished sentence goes to Claude, along with the last few lines of the conversation to help with names,
   pronouns and misheard words. The translation streams back to the phones as Claude writes it.
4. Each phone reads the translation aloud in its listener's language with the phone's text-to-speech. The sound goes
   wherever the phone is playing sound, which is your earphones.

The API keys stay on the relay server. The browser never sees them.

## Two ways to use it

### One phone

This mode is for two people sharing one phone. You wear the earphones, and the other person looks at the screen.

- **What you hear:** what they say, translated, in your earphones.
- **What they see:** what you say, translated, on the screen. **Flip ↻** turns that text around for someone sitting
  across from you. If you choose **On the phone speaker** instead, the phone reads both translations aloud.
- **Who is speaking:** detected automatically when both languages are among English, Spanish, French, German, Hindi,
  Russian, Portuguese, Japanese, Italian and Dutch. This uses Deepgram's multilingual mode. For other pairs, tap
  **Me** or **Them** to show who is talking.

### Room

In this mode, everyone uses their own phone and earphones. They can sit at the same table or be in different places on
a call.

- **Inviting people:** start a room, then share the invite as a 6-character code, a QR code or a link.
- **What you hear:** everyone else, in your own language. Each sentence is translated once for each language in the
  room.
- **Size:** up to 10 people.
- **Dropped connections:** a phone that loses its connection rejoins the same room on its own.

### Talking and listening

| Setting   | Choices |
|-----------|---------|
| Talking   | **Hands-free**: the microphone stays on. Best in quiet places. |
|           | **Hold to talk**: the microphone is on only while you hold the button (in a room on a computer, you can also hold the space bar). Best in noisy places, and in rooms where people sit together. |
| Listening | **In my earphones**: you hear the translations of the other person, or of the others in a room. |
|           | **On the phone speaker**: the phone reads translations aloud, for when nobody wears earphones. The microphone pauses while the phone speaks, so the app does not translate its own voice. |

## Which microphone?

The app uses whichever microphone the phone gives it. To choose one yourself, open **Advanced → Microphone**.

- **One phone: use the phone's own microphone,** held between you. It hears you both, and Bluetooth earphones keep
  their full sound quality. Earbud microphones are designed to pick up only the wearer's voice, so they can miss the
  other person.
- **Room: use the earphones' microphone.** Each phone only needs to hear its owner, and the earbuds' noise filtering
  keeps other people's voices out.
- Wired earphones with a microphone work too.

When any app opens a Bluetooth headset's microphone, the phone switches the headset to its hands-free profile (HFP).
That profile lowers the sound to phone-call quality until the microphone closes again. It is a Bluetooth limitation,
and a web app cannot change it.

## Getting started

You need:

- Node.js 22.18 or newer.
- A [Deepgram](https://console.deepgram.com) API key.
- An [Anthropic](https://platform.claude.com) API key. Instead of a key, you can log in with `ant auth login`.
- A computer and a phone on the same Wi-Fi network.

```sh
npm install
cp .env.example .env    # then add DEEPGRAM_API_KEY and ANTHROPIC_API_KEY
npm run dev
```

`npm run dev` starts two servers:

- the relay server, on port 8787;
- the app's development server, on port 5173. It uses HTTPS with a self-signed certificate, because phones only allow
  the microphone on HTTPS pages.

To try it on your phone:

1. Open the Network address that Vite prints, such as `https://192.168.1.20:5173`. You can also use
   `https://<computer-name>.local:5173`.
2. Accept the certificate warning. It appears because the development certificate is self-signed.
3. Allow the microphone, pick your languages and tap **Start**.

To try a room, other people open your invite link on their phones. While you use `npm run dev`, they must be on the
same Wi-Fi.

## Deploying

```sh
npm run build   # builds the app into client/dist
npm start       # serves the app and the WebSocket (/ws) on PORT
```

Phones need HTTPS. Do one of the following:

- Set `TLS_CERT` and `TLS_KEY` to your certificate and key (PEM files).
- Run the server behind an HTTPS reverse proxy, such as Caddy, nginx or a tunnel, that forwards WebSocket upgrades on
  `/ws`. If the proxy changes the Host header, add your public address to `ALLOWED_ORIGINS`.

Set `ACCESS_TOKEN` on any server that can be reached from the internet. Without it, anyone who finds the server can
spend your API credits. People enter the code under **Advanced → Access code**.

Rooms are kept in memory. That means one server process only, and a restart ends every room. A room with nobody in it
stays open for 10 minutes, so people can rejoin.

## Configuration

Set these in `.env`, or in the server's environment.

| Variable             | Default                             | Description |
|----------------------|-------------------------------------|-------------|
| `DEEPGRAM_API_KEY`   | *(required)*                        | Deepgram key, for speech recognition. |
| `ANTHROPIC_API_KEY`  |                                     | Claude key. Optional after `ant auth login`. `ANTHROPIC_AUTH_TOKEN` also works. |
| `TRANSLATION_MODEL`  | `claude-opus-5`                     | Claude model that translates. |
| `TRANSLATION_EFFORT` | `low`                               | `low`, `medium`, `high`, `xhigh` or `max`. Lower is faster, and `low` suits live conversation. |
| `DEEPGRAM_MODEL`     | `nova-3`                            | Switches to `nova-2` on its own for languages `nova-3` doesn't support. |
| `DEEPGRAM_URL`       | `wss://api.deepgram.com/v1/listen`  | Change it for a regional or self-hosted Deepgram endpoint. |
| `PORT`               | `8787`                              | Port the server listens on. |
| `ACCESS_TOKEN`       |                                     | Shared secret that people must enter to use the server. |
| `TLS_CERT`, `TLS_KEY`|                                     | Paths to a PEM certificate and key, to serve HTTPS directly. Set both or neither. |
| `ALLOWED_ORIGINS`    |                                     | Extra page origins allowed to open the WebSocket, separated by commas. |

**Refusal fallbacks are on.** Translation requests use the `server-side-fallback-2026-07-01` beta with
`fallbacks: 'default'`. If a safety classifier declines a sentence, the API runs the request again on Anthropic's
recommended fallback model instead of returning a refusal. If that is declined too, the app shows *"The translation
service declined to translate this utterance."*

## Languages

The app offers 34 languages, from English, Spanish, Chinese and Arabic to Catalan and Slovak. The full list is in
[`shared/languages.ts`](shared/languages.ts). Recognition quality depends on the language and on the Deepgram model.

## Limitations

- **Bluetooth microphones lower the sound quality** while they are in use. See [Which microphone?](#which-microphone).
- **The app cannot choose where sound plays.** Phones don't let web pages pick an audio output. Sound plays wherever
  the phone sends it: to the earphones when they are connected, otherwise to the speaker. **On the phone speaker**
  means "read everything aloud". It does not force the sound to the speaker.
- **Locked screens pause translation.** The app asks the phone to keep the screen on during a conversation. If the
  phone locks anyway, the browser pauses the page until you come back. The connection then returns on its own. If the
  phone stopped the microphone in the meantime, the app tells you so.
- **iPhone is untested.** So far the app has been tested only in Chrome. iOS may also play speech through the earpiece
  instead of the loudspeaker while the microphone is on.
- **Phones in the same room hear each other.** When a room's members sit at one table, a phone can pick up a neighbour's
  voice and translate it as its owner's words. Use earphone microphones, or **Hold to talk**.
- **Translation waits for a pause.** It starts when the speaker stops talking. Until then, you see the live
  transcript.
- **Home screen icon:** the app can be added to the home screen, but it ships only an SVG icon, and iOS expects a PNG.

## Privacy

- **Where audio goes:** from the phone to your relay server, then to Deepgram for speech recognition.
- **Where text goes:** the recognized text goes to Anthropic for translation, along with the last ten lines of the
  conversation as context.
- **Provider policies:** Deepgram's and Anthropic's data policies apply to what they receive.
- **What the server keeps:** nothing is stored. There are no recordings, transcripts or accounts. Conversations and
  rooms exist in memory only while they are active, and the logs never contain what people say.
- **What the phone keeps:** your settings, in the browser's local storage. These are your languages, mode, name,
  microphone and access code.

## Security

- **API keys:** they never leave the server.
- **`ACCESS_TOKEN`:** keeps strangers from using your server. It is compared in constant time.
- **WebSocket origin check:** the WebSocket accepts only pages served from the server's own address or from
  `ALLOWED_ORIGINS`. Other websites cannot use your server through their visitors' browsers.
- **Content Security Policy:** it is strict, with no inline scripts or styles.
- **Size limits:** messages, audio chunks, names and rooms all have a maximum size.

## Project layout

```
server/src/
  index.ts          entry point: reads the configuration and starts the server
  app.ts            HTTP(S) server, static files, WebSocket upgrades, Origin and access checks
  session.ts        one phone's connection: hello, audio, messages
  solo.ts           one-phone conversations: who is speaking, Me / Them
  rooms.ts          rooms: codes, participants, one translation per language
  stt/              speech-to-text: the SttProvider interface, Deepgram, sentence segmentation
  translate/        the Translator interface, the Claude translator and its prompt
client/src/
  setup-view.ts     start screen
  live-view.ts      conversation screen
  live-session.ts   connects the microphone, the server and the spoken translations
  connection.ts     WebSocket that reconnects on its own
  audio/            microphone capture, resampling to 16 kHz
  tts.ts            text-to-speech with the phone's voices
client/public/      audio worklet, web app manifest, icon
shared/             protocol, languages, room codes (used by both sides)
server/test/, client/test/
```

## Development

| Command             | What it does |
|---------------------|--------------|
| `npm run dev`       | Starts the relay server, which restarts when files change, and the app's HTTPS development server. |
| `npm test`          | Runs the unit and integration tests. Speech recognition and translation are faked, so no keys are needed. |
| `npm run typecheck` | Type-checks the server and the app. |
| `npm run build`     | Builds the app for production. |
| `npm start`         | Runs the production server. |

The server runs TypeScript directly with Node's type stripping, so it has no build step. Only erasable TypeScript
syntax is allowed: for example, no `enum` and no constructor parameter properties.

### Another speech recognizer or translator

To use another service, implement one of these interfaces and pass it to `createApp` in `server/src/index.ts`:

- `SttProvider` in [`server/src/stt/types.ts`](server/src/stt/types.ts), for speech recognition;
- `Translator` in [`server/src/translate/types.ts`](server/src/translate/types.ts), for translation.

The tests use fake versions of both, in `server/test/fakes.ts`.

Automatic speaker detection in One phone mode relies on Deepgram's multilingual mode, which tags the language of each
word. See `AUTO_DETECT_BASES` in `shared/languages.ts`.

## Roadmap

- A native app wrapper, for example with Capacitor, to keep listening while the screen is locked and to choose the
  audio output.
- More natural cloud voices, in place of the phone's built-in ones.
- More speech recognizers, through `SttProvider`.
- PNG icons for the iOS home screen.

## License

MIT
