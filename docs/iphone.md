# Building Alo for iPhone

The phone app in [`mobile/`](../mobile) is set up for iPhone, but it has not been built or tested on one yet. This
is what it takes, and what to expect. Nothing here needs any secret in the repository: your Apple account, signing
certificates and API keys stay on your Mac, on Apple's servers, or on the phone.

## What works on iPhone, and what doesn't yet

| Feature | Android | iPhone |
| --- | --- | --- |
| Translation with **My own API keys** or an **EarBridge server** | Yes | Yes |
| **On this phone** (offline engines) | Android 13 or newer | No: iOS has its own engines, see [on-device.md](on-device.md) |
| Earphones, their microphone and play/pause button | Yes | Set up (`react-native-audio-api`), untested |
| Translating with the screen off | Yes, with a notification | Set up (the `audio` background mode), untested |
| **Voices**: telling the two voices from everyone else's, *Separate voices*, and leaving out what someone else said over a held line | Yes | **No.** The speaker model (CAM++) and the separator run in a Kotlin module, `mobile/modules/earbridge-audio`, which has no Swift side yet. The app hides these settings when the module is missing (`canCheckVoices()` in `mobile/src/engines/voices.ts`). |
| Talk reports (`EXPO_PUBLIC_TALK_REPORT=1`) | Read over USB with `adb pull` | Written to the app's documents folder, but the app does not share it with Finder yet |

Porting the voice checks means writing the three modules of `expo-module.config.json` in Swift with sherpa-onnx's
iOS framework and ONNX Runtime for the separator. Until then, iPhone users should use **Hold to talk** in noisy places.

## Path 1: build it on a Mac, install it over a cable

This is free, with any Apple ID. The app then runs for 7 days; after that, build and install it again.

### You need

- A Mac with **Xcode 16 or newer** from the App Store. Xcode needs roughly 25 GB of free disk space to install;
  the Command Line Tools alone are not enough (`xcode-select -p` must print a path inside `Xcode.app`).
- **CocoaPods**: `brew install cocoapods` (or `sudo gem install cocoapods`).
- **Node.js 22.18 or newer**, as for Android.
- An iPhone on **iOS 15.1 or newer**, with **Developer Mode** turned on: Settings → Privacy & Security → Developer
  Mode (it appears once the phone has been plugged into a Mac with Xcode). Plug it in with a cable and tap **Trust**
  on the phone.
- Open Xcode once, accept the licence, and sign in with your Apple ID under Xcode → Settings → Accounts.

### Build and install

Get the code first. The repository is private: ask its owner for access, or for a copy.

```sh
git clone https://github.com/OreNoMochii/earbridge.git
cd earbridge/mobile
npm install
npx expo prebuild --platform ios      # generates mobile/ios (git-ignored) and runs pod install
npx expo run:ios --device --configuration Release
```

`expo run:ios --device` lists the connected iPhones; pick yours. The first build takes a while.

**Signing.** The first time, Xcode has to know which team signs the app:

1. Open `mobile/ios/Alo.xcworkspace` in Xcode.
2. Select the **Alo** target → **Signing & Capabilities**, tick **Automatically manage signing**, and choose your
   team (with a free Apple ID this is "Your Name (Personal Team)").
3. If Xcode says the bundle identifier is not available, somebody else's team registered it already: change
   `expo.ios.bundleIdentifier` in `mobile/app.json` to something of your own, such as `com.yourname.alo`, and run
   `npx expo prebuild --platform ios --clean` again.
4. Run `npx expo run:ios --device --configuration Release` again.

To keep the team across prebuilds, add it to `mobile/app.json` instead: `"ios": { "appleTeamId": "ABCDE12345" }`.
A team id is not a secret, but keep it out of the repository anyway unless the repository is yours alone.

**On the phone.** With a free account, iOS refuses to open the app until you trust the developer: Settings →
General → VPN & Device Management → your Apple ID → Trust. Then open Alo, pick your languages, and choose **My own API
keys** or **EarBridge server** under *Translation*. Type the keys on the phone; they are kept in the iPhone's keychain.
When the app first reaches a server on your Wi-Fi, iOS asks to allow the local network.

**Limits of a free account:** the app expires after 7 days, at most 3 such apps on a phone at once, and 10 new
bundle identifiers a week. The paid Apple Developer Program ($99 a year) lifts them to a year.

### Options

- `EXPO_PUBLIC_SERVER_URL=http://192.168.1.20:8787 npx expo run:ios --device --configuration Release` builds the
  server's address in, as for Android.
- `EXPO_PUBLIC_TALK_REPORT=1` writes talk reports, but see the table above for reading them.
- Never build API keys into the app, with `EXPO_PUBLIC_…` variables or otherwise: anyone with the app could read them.

## Path 2: EAS Build, in the cloud

With an **Apple Developer Program** membership, [EAS Build](https://docs.expo.dev/build/introduction/) builds the app
on Expo's Macs, so no Xcode is needed, and can hand it out through TestFlight.

```sh
npm install -g eas-cli
git clone https://github.com/OreNoMochii/earbridge.git
cd earbridge/mobile
npm install
eas login                     # an Expo account; free for a few builds a month
eas build:configure           # writes mobile/eas.json (safe to commit: it holds no secrets)
eas build --platform ios --profile preview
```

The first build asks for your Apple ID and makes the certificates and provisioning profile for you; EAS keeps them
in your Expo account, not in the repository. For a `preview` build to install on your own phones, register each
phone once with `eas device:create`. For TestFlight, use the `production` profile and `eas submit --platform ios`.

If you ever use `credentials.json` to hand EAS your own certificates, it holds a `.p12` and a `.mobileprovision`:
all three are already git-ignored in `mobile/.gitignore`. Check with `git status` before committing.

## Checking that nothing secret is committed

```sh
git status --short                        # no .env, no credentials.json, no *.p12/*.p8/*.mobileprovision
git ls-files | grep -iE '\.env$|credentials|\.p12$|\.p8$|\.mobileprovision$|\.jks$'   # prints only .env.example
```

The Android build is signed with the debug keystore that Android Studio generates (`mobile/android/app/debug.keystore`
after prebuild, password `android`), which is not a secret. The server's keys live in `.env`, which is git-ignored;
`.env.example` shows the names only.
