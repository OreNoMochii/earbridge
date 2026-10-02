# Alo: a simpler design (prompt for Pencil)

Paste everything below the line into Pencil's AI, in an empty .pen file.

---

Design a new mobile UI for **Alo**, an Android app (iPhone later) that translates a spoken conversation live. You hear the other person in your own language in any earphones, and the phone shows them what you said, in their language. Keep **every feature listed below**, but make the app much simpler and calmer. It must be easy for **older people who are not good with technology**: a grandparent travelling abroad, or someone talking with in-laws who speak another language. Redesign the UI only: add no new capabilities, and leave nothing out.

The name **Alo** is what people say when they answer the phone in many languages (allô, aló, алло, ألو, a lô), so it needs no translation. Make the logo a speech bubble with the name in it.

## Who uses it, and what they need

- Many are over 65, with weaker eyesight, less precise fingers and some hearing loss. They are afraid of "breaking something".
- They don't know tech words. Never show: API, key (except on the one screen that asks for them), server, engine, hands-free, auto-detect, mute, toggle, model, room.
- They want to open the app, check the two languages and tap one big button. Settings are set up once, often by a family member.

## Design rules

- **Type:** the font is Atkinson Hyperlegible (Noto Sans JP for Japanese). Body 19 px or more, secondary text 17 px or more, never under 15. Screen titles 30 px bold, section titles 22 px bold. The translation shown to the other person is 32 to 36 px. Line height 1.35 to 1.45.
- **Touch:** targets at least 56 × 56 px, and main buttons 64 px tall or more. Leave 12 px or more between targets. Every action is a visible button with an icon and a text label: no icon-only buttons, no hidden swipes or long-presses, except the clearly labelled "Hold while you talk" buttons.
- **Contrast:** text 7:1 or more (WCAG AAA), and borders and controls 3:1 or more. Never use colour alone: every status gets a coloured dot or icon *and* words.
- **One main action per screen,** in the lower half where the thumb reaches. Use plain, friendly sentences: say what happens and what to do next.
- **Progressive disclosure:**
  - A first-time setup walks through one question per screen.
  - Home shows only the languages and Start.
  - Everything technical lives in Settings, under "More options".
- **Calm:** few colours, no clutter, no tiny grey text. Use cards only when they group something. Nothing important should depend on scrolling sideways.
- **Frames:** Android phone, 412 px wide, with an Android status bar 40 px tall. Let each screen's height fit its content. Use light and dark themes, made from the same variables.

## Colours (variables with light and dark values)

| Name | Light | Dark |
|---|---|---|
| bg | #F7F4EE | #0F1419 |
| surface | #FFFFFF | #182029 |
| surface-2 | #EFEAE1 | #222C37 |
| text | #14181F | #F3F1EC |
| text-muted | #444C59 | #C2C8D0 |
| border | #D9D2C5 | #2E3A47 |
| border-strong | #8A8275 | #6B7785 |
| accent | #0B5F58 | #4FD1C1 |
| on-accent | #FFFFFF | #062A26 |
| accent-soft | #D5EFEA | #123A36 |
| mine (my bubbles) | #E3F2EF | #133531 |
| danger | #B3261E | #FF8A80 |
| danger-soft | #FBE3E1 | #3D1716 |

Status colours, as text / soft background:

| Status | Light | Dark |
|---|---|---|
| live | #1E6B30 / #DDF3E2 | #6EE787 / #10301A |
| busy | #7A4F00 / #FFF0CC | #FFC94D / #3A2C08 |
| speaking | #5B3CC4 / #ECE6FF | #B9A6FF / #261D45 |
| idle | #4A525E / #E9E6E0 | #AEB6C0 / #222C37 |

## Screens to design

### 1. First-time setup: four steps, one question each

Each step has a "Step N of 4" progress indicator, a big "Back" button (except on step 1), and a big "Next" button at the bottom.

1. **"Welcome to Alo"**
   - "Which language do you speak?"
   - Suggest the phone's language as a big pre-selected answer: "English (US). From your phone's settings."
   - Below it, a "Choose another language" button.
2. **"Which language will the other person speak?"**
   - A search field, then the common languages as big rows: native name, with the English name under it (日本語 / Japanese). The selected row is tinted, with a check.
   - There are 38 languages.
   - Choosing the language already used on the other side swaps the two.
3. **"How should Alo translate?"** Three big choice cards, each with an icon, a title, one or two lines and a radio mark:
   - **On this phone** (Recommended): "Free and private. Works without internet after a one-time download, about 80 MB per language."
     - When not possible, it is greyed out with the reason, e.g. "Needs Android 13 or newer."
     - Chinese (Taiwan) shows the note "Translated into simplified characters".
   - **Online, best quality:** "Uses your own Deepgram and DeepInfra accounts. They charge for what you use. A family member can set this up." Choosing it leads to the account keys screen (screen 5).
   - **Through a computer:** "A computer at home or at work runs Alo for you." It asks for the computer's address (e.g. 192.168.1.20:8787) and an access code, "only if you were given one".
4. **"Where do you want to hear translations?"**
   - **In my earphones:** "You hear the other person in your earphones. They read your words on the screen."
   - **Out loud on the phone:** "The phone speaks both translations. It stops listening while it speaks."
   - The button says "Finish".

### 2. Home: every day

- The app name and a labelled "Settings" button.
- A big language card with "You speak: English" and "They speak: 日本語 Japanese". Each opens the language list, and a big "Swap" button sits between them.
- One huge main button: "Start talking. One phone, the two of you."
- A second, quieter button: "Group conversation. Everyone on their own phone."
- A short summary in plain words, with icons, and "Change" opening Settings:
  - "Translating online, best quality"
  - "Microphone stays on"
  - "You hear them in your earphones"
  - "Only your two voices"
- One line: "Who is talking is noticed automatically." For language pairs where it can't be: "Tap Me or Them to show who is talking."
- **State:** a red message box at the top when the last conversation ended with a problem, with a "Try again" button. Example messages:
  - "Couldn't reach the computer at 192.168.1.20:8787. Check that it is on, and that this phone is on the same Wi-Fi."
  - "The earphones were disconnected. Start again to continue."
  - "Alo isn't allowed to use the microphone. Allow it in Settings › Apps › Alo › Permissions."
  - "Check your Deepgram key in Settings."

### 3. Language list

- Full screen, with a title ("I speak" or "The other person speaks"), a "Close" button and a search field.
- Rows 64 px tall or more, showing the native name and the English name. The selected row has a check.

### 4. Settings

One scrolling page of big sections.

- **Translation:** the same three choices as setup step 3.
  - With Online selected: "Account keys: saved ✓" and a "Change keys" button.
  - With Through a computer selected: the address and access code fields.
- **Talking:**
  - "Talk freely": the microphone stays on, best in quiet places.
  - "Press and hold to talk": best in noisy places.
- **Hearing translations:** the two choices from setup step 4.
- **Noisy places:** only for one phone. Greyed out, with the reason, when it can't work: "Not available with On this phone. Press and hold to talk works best in noisy places."
  - Switch "Ignore far-away voices": "Skips speech much quieter than you two, like other tables, a TV or a radio."
  - Switch "Only our two voices": "Translates only you and the person you talk with. Needs Online, best quality." Turning it on the first time opens Record your voice (screen 6).
  - When a voice is saved: "✓ Your voice is saved on this phone", with "Record again" and "Delete" buttons.
  - The note "Anything skipped by mistake can still be translated: tap Translate on it."
- **More options:** collapsed.
  - Microphone: "Automatic", "Phone" or "Earphones", with the hint "With one phone, the phone's own microphone usually works best."
  - Voice: "Natural voice" or "The phone's own voice". Hidden when translating on this phone.
- **Privacy:** one short paragraph that depends on the translation choice:
  - On this phone: "What you say stays on this phone."
  - Online: "Your voice goes to Deepgram and the text to DeepInfra, with your keys."
  - All choices end with "Alo keeps no recordings or transcripts."

### 5. Online accounts (the only screen that says "key")

- Two fields: "Speech service key (Deepgram)" and "Translation service key (DeepInfra)".
- The fields are masked, with big "Show" and "Paste" buttons.
- Help: "Create them at console.deepgram.com and deepinfra.com. Each bills you for what you use."
- "Stored encrypted, only on this phone, and sent only to those two services."
- A "Save" button.
- An error state under a field: "Enter your DeepInfra key."

### 6. Record your voice

Opens over Settings.

- "Talk normally for about 10 seconds. Hold the phone as you will in conversations. For example, say what you did today, in both your languages if you can."
- A large circular progress with a microphone in the middle, and a live sound-level bar.
- Status lines:
  - "Listening… start talking."
  - "Keep talking…"
  - "Speak up a little, or move somewhere quieter."
  - "Got it. Downloading the voice model (28 MB)… 45%". This only appears the first time.
  - "Saving your voice…"
- An error state with "Try again", e.g. "Couldn't hear enough of your voice. Try again closer to the phone, somewhere quieter."
- A "Cancel" button, and a lock icon with "Only a voice print is kept, on this phone. The recording isn't kept or sent anywhere."

### 7. Conversation, one phone, talking freely: the most important screen

- **Top bar:**
  - "English ⇄ 日本語".
  - A status pill with a dot and words: "Listening" (live), "Speaking…" (speaking), "Paused" (idle), "Connecting…", "Getting ready…", "Downloading Japanese speech recognition…" or "Connection lost. Reconnecting…" (busy).
  - A big red "End" button. Android Back asks "End the conversation?" with "Keep talking" and "End".
- **"For them" panel:**
  - The latest translation in their language, very large (32 to 36 px), labelled "日本語 · for the other person".
  - A big "Turn around" button turns the panel upside down for someone sitting across.
  - When empty: "Waiting for you to speak…"
- **Conversation list,** following new lines:
  - Their lines, on the left: the translation big, their original small under it, labelled "Them · Japanese".
  - My lines, on the right in a tinted bubble: what I said, with the translation under it, labelled "You · English".
  - Translation states: "Translating…", "(nothing to translate)", "Translation failed: …" in red, and "(cut off)".
  - Live captions in italics while someone is still talking.
  - When empty: "Start talking. Everything you both say appears here, translated."
  - **Skipped lines,** in a dashed box: "Not translated · far away" (or "another voice", or "French"), the words, and a big "Translate" button. Several skipped lines in a row fold into "3 more not translated" / "Show fewer". After a tap, the line shows "Translating…".
- **Bottom panel:**
  - The microphone name with a small live sound-level bar, e.g. "Phone microphone".
  - "Who is talking?" with three big segments: "Automatic", "Me · English", "Them · 日本語". "Automatic" only appears when the language pair supports it. "Tap Them when someone new starts talking."
  - A big "Pause" / "Resume" button.
- **Toasts:** short messages near the top that go away by themselves, at most three. For example:
  - "Earphones connected. Translations play in them."
  - "The earphones were disconnected, so translations play on the phone speaker."
  - "No Japanese voice is installed on this phone. You can add voices in the phone's text-to-speech settings."

### 8. Conversation, press and hold to talk

- Same screen as 7, with the "For them" panel shown turned around.
- The bottom has two huge hold buttons, at least 120 px tall:
  - "Me", "English", "Hold while you talk"
  - "Them", "日本語", "Hold while they talk"
- Show one of them pressed: filled, "Listening…".
- The status says "Hold a button to talk".

### 9. Group conversation: start or join

- "Everyone uses their own phone and earphones, and hears the others in their own language."
- Fields:
  - "Your name, shown to the others". Error: "Enter your name, so the others know who is talking."
  - "You speak".
- **"Start a new group"** is the main button.
- **"Join a group":** six big boxes for a code like ABC 234, then "Join". Error: "Group codes have 6 letters and numbers, like ABC 234."
- **"The computer running Alo":** the address and access code fields. Groups always need one.
- **Invited state:** after opening an invite link, a tinted box says "You're joining group ABC 234 on 192.168.1.20", with "Start a new group instead".

### 10. Group conversation

- **Top bar:**
  - "Group ABC 234" and its status.
  - An "Invite" button that opens and closes the invite panel.
  - A red "Leave" button. Back asks "Leave the group?"
- **Invite panel:**
  - A QR code and the big code "ABC 234".
  - "Others scan this with their camera, or type the code, then pick their language and put in their earphones."
  - The link, with "Share link" and "Copy link" buttons. Copying shows the toast "Link copied."
- **People chips:** "You · English", "Kenji · 日本語", "María · Español" (the language in its own words, not a code). Toasts announce "Kenji joined." and "Kenji left."
- The same conversation list, labelled by name.
- **Bottom:**
  - The microphone name and level.
  - A big "Pause" button, or, in press-and-hold mode, one huge "Hold to talk. Let go when you're done."

### 11. States board

A frame showing the pieces in both themes:

- Every status pill.
- The four Home error messages.
- The end and leave confirmation dialogs.
- Toasts.
- The microphone permission message.
- "Downloading Japanese for on-phone translation… 40%", plus its failure: "The translation for Japanese could not be downloaded. Connect to the internet once to download it."
- Disabled choices with their reasons.

## Deliverables

- Variables first, with light and dark modes. Then reusable components: status bar, big button (primary, secondary, danger), choice card, switch row, section title, language row, chat bubbles (mine, theirs, skipped), status pill, hold button and toast.
- Screens 1 to 10 in light, laid out left to right in the order of use. Then Home, Settings and both conversation screens again in dark.
- Then the states board.
- Use realistic English and Japanese text.
- Check each screen:
  - Nothing is clipped.
  - Text is 15 px or more, and touch targets are 56 px or more.
  - Contrast meets the numbers above.
  - Every feature in this brief appears somewhere.
