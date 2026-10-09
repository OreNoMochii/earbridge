# Alo: a simpler design (prompt for Pencil)

Paste everything below the line into Pencil's AI, in an empty .pen file.

---

Design a new mobile UI for **Alo**, an Android app (iPhone later) that translates a spoken conversation live. You hear the other person in your own language in any earphones, and the phone shows them what you said, in their language. Keep **every feature listed below**, but make the app calmer, more compact and polished. Redesign the UI only: add no new capabilities, and leave nothing out.

The name **Alo** is what people say when they answer the phone in many languages (allô, aló, алло, ألو, a lô). The logo is a speech bubble with the name in it.

## Who uses it

- Many are over 65, with weaker eyesight, less precise fingers and some hearing loss. They are afraid of "breaking something".
- They don't know tech words. Never show: API, key (except on the one screen that asks for them), server, engine, hands-free, auto-detect, mute, toggle, model, room.
- They open the app, check the two languages and tap Start. Settings are set up once, often by a family member.
- In a conversation they read the translation, not the controls. **Labels, descriptions and buttons take little room. The translation gets the space.**

## Step 1: three directions, then stop

Before anything else, design **Home** (screen 2) and **Conversation, talking freely** (screen 7) in three clearly different visual directions. Use the light theme and put them side by side: six frames, labelled A, B and C. The content and the rules below stay the same; only the look changes.

- **A · Paper:** warm off-white, flat tinted surfaces, no shadows, teal accent, 16 px corners.
- **B · Soft cards:** cool light-grey background, white cards with a very soft shadow, pill-shaped buttons, deep blue accent, 24 px corners.
- **C · Bold:** the "For them" panel is a dark full-width block with big light text. Strong type contrast, very quiet chrome, a warm accent, 28 px corners.

Then **stop and ask me which direction to continue with** (or what to mix). After I answer, keep the six frames in a row at the top and build everything below in the chosen direction.

## Style

- **Content first.** On conversation screens the translation is the largest, highest-contrast thing. Bars, labels and hints are small, quiet and few.
- **Fewer boxes.** Group things with whitespace and soft tinted surfaces, not outlines.
  - No 2 px borders anywhere.
  - Use a 1 px hairline only on text fields, or where two tints would merge.
  - Never put a card inside a card.
- **One accent colour,** for the main button, the selection and "listening". Red is only for End, Leave, Delete and errors. Status colours appear only in status pills and dots.
- **Shapes:** generous rounded corners from one small family: one radius for cards and panels, one for buttons and fields. Chat bubbles have one smaller corner on the speaker's side.
- **Spacing:** a 4/8 px grid. Side padding is 16 px, so content is 328 px wide. Use 8 px inside a group and 16 to 24 px between groups.
- **Icons:** Lucide only, 20 to 24 px, 2 px stroke.
  - Every button has an icon and a text label.
  - No icon-only buttons, and no hidden swipes or long-presses, except the labelled hold-to-talk buttons.
- **Type:** Atkinson Hyperlegible (Noto Sans JP for Japanese), Regular and Bold only. Build hierarchy with size and with text versus text-muted, not with boxes.
- **Never:** all caps, centred paragraphs, gradients, glass effects or emoji as icons.

## Sizes: compact, content first

| Use | Size |
|---|---|
| Translation shown to the other person | 28 to 34 px |
| Translations in the conversation list | 19 to 20 px |
| Screen titles | 26 px bold |
| Section titles | 19 to 20 px bold |
| Language names on Home | 22 px bold |
| Button labels | 17 px bold |
| Body | 17 px |
| Descriptions and secondary text | 15 px, text-muted |
| Small labels (who said it, captions, chips) | 14 px. Nothing is smaller. |

Line height is 1.3 to 1.4.

- **Buttons:** 48 to 56 px tall, with a one-line label. Only the main "Start talking" button may have a one-line subtitle.
- **Touch targets:** at least 48 × 48 px, with 8 px or more between them.
- **Descriptions:**
  - At most one short muted line under a choice or switch.
  - Extra detail appears only under the selected choice.
  - Use the exact copy in this brief; it is already short. Don't lengthen it.
- **Contrast:**
  - Text is 7:1 or more on its background (WCAG AAA).
  - Field outlines, radio marks and switches are 3:1 or more.
  - Never use colour alone: every status gets a dot or icon *and* a word.
- **One main action per screen,** low down where the thumb reaches.
- **Progressive disclosure:**
  - The first-time setup asks one question per screen.
  - Home shows the languages and Start.
  - Technical things live in Settings, under "More options".

## Frames

- **Every screen frame is exactly 360 px wide,** the width of the user's phone. The width is fixed:
  - Never stretch a screen to the canvas.
  - Never set its width to fill or fit a parent.
  - Never place screens in a container that resizes them.
  - Elements inside may fill the 360 px frame.
- **Height** fits the content, and scrolling screens show their full length. The conversation screens (7, 8 and 10) are exactly **360 × 800**.
- **System bars:** an Android status bar 28 px tall at the top, and 16 px at the bottom for the gesture bar.
- **Check frame:** add one extra frame of Conversation, talking freely, at **412 × 915**, to check a wider phone. It is the only frame that isn't 360 wide.
- **Themes:** make light and dark themes from the same variables.

## Colours (variables with light and dark values)

Direction A uses these values. B and C may change the accent family (accent, on-accent, accent-soft, mine) and the bg and surface tints, but must keep the names and the contrast rules.

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

Each step has a top row with "Back" (except on step 1) and "Step N of 4" with a thin progress bar. The question is the screen title, and a "Next" button sits at the bottom.

1. **"Welcome to Alo"**, with one line under it: "Talk with anyone, each in your own language."
   - "You speak": the phone's language, pre-selected as one big row: "English (US)", with a small tag "From your phone".
   - A "Choose another" button.
2. **"They speak"**
   - A search field ("Search languages").
   - Then rows with the native name and the English name under it (日本語 / Japanese). The selected row is tinted, with a check. There are 34 languages.
   - Picking the language already used on the other side swaps the two.
3. **"How to translate"**: three choice cards, each with an icon, a title, one line and a radio mark.
   - **On this phone**, tagged "Recommended": "Free, private, works offline".
     - When selected: "One-time download, about 30 MB per language."
     - When not possible, greyed out with the reason: "Needs Android 13 or newer."
     - For Chinese (Taiwan): "Shown in simplified characters."
   - **Online, best quality**: "Your own Deepgram + DeepInfra accounts".
     - When selected: "Billed by use. Next: your account keys."
     - Next opens screen 5.
   - **Through a computer**: "Uses a computer running Alo".
     - When selected, two fields: "Computer address" (192.168.1.20:8787) and "Access code (if you have one)".
4. **"Hear translations"**
   - **In my earphones**: "They read your words on screen".
   - **Out loud on the phone**: "Pauses listening while it speaks".
   - A small line above the button: "Change anytime in Settings". The button says "Finish".

### 2. Home: every day

- A top row with the Alo logo and a "Settings" button.
- A language card:
  - "You speak", a 14 px label, over "English" in 22 px bold.
  - "They speak" over "日本語 Japanese".
  - Each one opens the language list. A compact "Swap" button sits between them.
- The main button, the biggest thing on the screen: "Start talking", with the subtitle "One phone, two people".
- A secondary button: "Group conversation".
- One wrapped row of small setup chips (icon plus 1 to 3 words), then a small "Change" button that opens Settings:
  - "On this phone", "Online" or "Through a computer"
  - "Talk freely" or "Hold to talk"
  - "Earphones" or "Phone speaker"
  - "Only our voices", when it is on
- One muted line with an info icon: "Alo notices who is talking." For language pairs where it can't: "Tap Me or Them to show who is talking."
- **Problem banner,** at the top, in danger-soft. It has a title, one short line and one button. It shows when the last conversation ended with a problem:
  - "Can't reach the computer" · "192.168.1.20:8787. Is it on, on the same Wi-Fi?" · "Try again"
  - "Earphones disconnected" · "Start again to continue." · "Try again"
  - "No microphone access" · "Allow it in Settings › Apps › Alo › Permissions." · "Try again"
  - "Deepgram key not accepted" · "Check it, then try again." · "Change keys"
  - "On this phone isn't available" · the reason · "Choose another way"

### 3. Language list

- A full-screen sheet with a title ("You speak" or "They speak"), a "Close" button and a search field.
- Rows are 56 px tall: the native name in 17 px bold, with the English name under it in 14 px muted. The selected row is tinted, with a check.

### 4. Settings

One scrolling page of section titles and choices, with no boxes around the sections. There is a "Done" button at the top right and at the bottom.

- **Translation:** the three choices from setup step 3.
  - With Online selected: "Account keys · Saved ✓" and a "Change keys" button.
  - With Through a computer selected: the address and access code fields.
- **Talking:**
  - "Talk freely": "Best in quiet places"
  - "Hold to talk": "Best in noisy places"
- **Hear translations:** the two choices from setup step 4.
- **Noisy places** (one phone only):
  - Switch "Ignore far-away voices": "Skips other tables, TV, radio".
  - Switch "Only our two voices": "Shows and translates only you two. Needs Online." Turning it on the first time opens Record your voice (screen 6).
  - When a voice is saved: "✓ Your voice is saved on this phone", with "Record again" and "Delete".
  - One line under it: "Theirs is recorded in each talk, and forgotten when it ends."
  - One muted line: "Skipped by mistake? Tap Translate on it."
  - With On this phone, the section is greyed out with the reason: "Not with On this phone. Hold to talk helps in noise."
- **More options:** collapsed, with "Show" / "Hide".
  - Microphone: "Automatic", "Phone" or "Earphones", with the hint "With one phone, Phone works best."
  - Voice: "Natural voice" or "Phone's own voice". It is hidden with On this phone.
- **Privacy:** one line with a lock icon, depending on the translation choice:
  - On this phone: "Everything stays on this phone."
  - Online: "Voice to Deepgram, text to DeepInfra, with your keys."
  - Through a computer: "Goes to the computer running Alo."
  - Each ends with: "No recordings or transcripts kept."

### 5. Online accounts (the only screen that says "key")

- The title "Online accounts" and a "Back" button.
- Two fields: "Speech key · Deepgram" and "Translation key · DeepInfra". They are masked, each with compact "Show" and "Paste" buttons.
- One muted line: "Get them at console.deepgram.com and deepinfra.com. Billed by use."
- A lock line: "Encrypted on this phone. Sent only to those two services."
- A "Save" main button.
- An error state under a field: "Enter your DeepInfra key."

### 6. Record your voice

A sheet over Settings.

- The title "Record your voice", and one line: "Talk for about 10 seconds, like in a conversation. Say what you did today."
- A large circular progress ring with a microphone in the middle, and a live level bar.
- One status line at a time:
  - "Listening… start talking"
  - "Keep talking…"
  - "Speak up, or find a quieter spot"
  - "Got it. Downloading voice model (28 MB)… 45%" (only the first time)
  - "Saving…"
- An error state: "Couldn't hear enough. Try closer to the phone, somewhere quieter.", with "Try again".
- A "Cancel" button, and a lock line: "Only a voice print stays on this phone. The recording isn't kept."

### 7. Conversation, one phone, talking freely: the most important screen

How the 360 × 800 height is shared:

| Part | Height |
|---|---|
| Status bar | 28 px |
| Top bar | 52 px or less |
| "Voices" row (only with "Only our two voices" on) | 36 px |
| "For them" panel + conversation list | **520 px or more (65%)** |
| Bottom controls, with the gesture bar | 160 px or less |

- **Top bar, one row:** "English ⇄ 日本語", a status pill (dot and word) and a red "End" button.
  - The pill says "Listening" (live), "Speaking" (speaking), "Paused" (idle), or "Connecting…", "Getting ready…" or "Reconnecting…" (busy).
  - While something downloads, a thin progress line under the bar says "Downloading Japanese… 40%".
  - Android Back asks "End the conversation?" ("The words on screen go away.") with "Keep talking" and "End".
- **"Voices" row,** only with "Only our two voices" on, so you can see both voices are known:
  - A 14 px "Voices" label, then pill chips 36 px tall (48 px to touch): "✓ You" on a soft green tint, then "✓ Them" (recorded), "✓ Them · learned" (grey, learned from the first thing they said) or "🎤 Record them" (outlined in the accent colour).
  - Tapping "Them" opens a small card: "Their voice is recorded" / "Only for this talk. It is forgotten when you end." with "Record again" and "Close". When learned: "Their voice was learned" / "From the first thing they said. Record it to be sure." with "Record" and "Close".
  - At the start, until their voice is known, a card takes the row's place: "Record their voice" / "So only you two are translated. Ask them to say a few words.", with "Record" and "Not now", and a lock line "Only for this talk, on this phone."
  - While recording, a card: a mic icon, "Recording their voice" and "3 / 6 s", a green progress bar, and "Let them talk. You stay quiet." with a compact "Cancel". When it goes wrong, the line turns red and bold: "That sounded like you. Let them talk." or "Can’t hear them well. Hold the phone closer to them." The microphone stays on while it records, even in hold to talk.
  - If it did not work: "Couldn’t record their voice" with "It heard mostly your voice. Let them talk, you stay quiet." (or "Too little of their voice was heard. Hold the phone closer to them."), and "Try again" and "Close".
  - When it worked: the toast "Their voice is recorded." and the row shows "✓ You ✓ Them".
- **"For them" panel,** about 200 to 240 px tall:
  - A small label, "For them · 日本語".
  - A compact "Turn around" button. It turns the whole panel upside down for someone sitting across.
  - The latest translation in their language, at 28 to 34 px. It scrolls when long.
  - When empty: "Waiting for you to speak…"
  - When failed: a ⚠ sign, not words, because the reader may not read English.
- **Conversation list,** filling the rest and following new lines:
  - Their lines, on the left: the translation at 19 to 20 px, with their original under it at 15 px, muted.
  - My lines, on the right in a tinted bubble: what I said at 19 to 20 px, with the translation under it at 15 px, muted.
  - A 14 px label ("Them · Japanese" or "You · English") appears only where the speaker changes.
  - States: "Translating…", "(nothing to translate)", "Translation failed: …" in red, and "(cut off)".
  - Live captions, in italics, while one of you is still talking.
  - When empty: "Start talking. Both sides appear here, translated."
  - **Skipped lines:** one compact row on a soft grey tint, with "Not translated · far away" (or "another voice", or "French") and a "Translate" button. Never the words: only our two voices are written out.
    - After a tap, the row shows "Translating…".
    - Several skipped lines in a row fold into "3 more not translated" / "Show fewer".
- **Bottom controls:**
  - "Who is talking?" as a 14 px caption.
  - Then one row of segments: "Automatic", "Me · English" and "Them · 日本語". Each may take two short lines, like "Me" over "English".
  - "Automatic" appears only when the language pair supports it. Otherwise the caption reads "Who is talking? Tap Me or Them."
  - One row: a mic icon, "Phone microphone" in 14 px with a small live level meter, and a "Pause" / "Resume" button at the end.
- **Toasts:** short, near the top, at most three at once, and they go away by themselves:
  - "Earphones connected"
  - "Earphones disconnected · using the phone speaker"
  - "No Japanese voice on this phone. Add one in text-to-speech settings."

### 8. Conversation, hold to talk

- Same screen as 7, with the "For them" panel shown turned around.
- **Bottom controls,** 160 px or less:
  - One small line with the microphone name and level. Until the first use, it shows the hint "Hold a button to talk. Let go when done." instead.
  - Two hold buttons side by side, 72 to 88 px tall:
    - a mic icon and "Me · English"
    - a mic icon and "Them · 日本語"
  - Nothing else is written on the buttons.
  - Show "Me" pressed: filled with the live tint, with "Listening…" under the name and the level moving.
- The status pill says "Hold to talk".

### 9. Group conversation: start or join

- The title "Group conversation", a "Back" button and one line: "Everyone on their own phone and earphones."
- Fields:
  - "Your name", with the helper "Shown to the others" and the error "Enter your name."
  - "You speak".
- The main button: **"Start a new group"**.
- **"Join a group":** six boxes for a code like ABC 234, then "Join". Error: "Codes have 6 letters and numbers, like ABC 234."
- **"The computer running Alo":** the address and access code fields, with the hint "Groups always need one."
- **Invited state,** after opening an invite link:
  - a tinted line: "Joining group ABC 234 on 192.168.1.20"
  - the main button "Join group"
  - and "Start a new group instead"

### 10. Group conversation

360 × 800. The conversation list gets 70% of the height or more.

- **Top bar, one row:**
  - "Group ABC 234", with its status (a small dot and a word) under it.
  - An "Invite" button that opens and closes the invite panel.
  - A red "Leave" button. Back asks "Leave the group?" ("The others can keep talking.") with "Stay" and "Leave".
- **Invite panel,** dropping down over the list:
  - A QR code and the big code "ABC 234".
  - One line: "Scan with the camera, or type the code."
  - The link, with "Share link" and "Copy link" buttons. Copying shows the toast "Link copied".
- **People chips,** in one scrolling row: "You · English", "Kenji · 日本語", "María · Español". Each language is written in its own words. Toasts say "Kenji joined" and "Kenji left".
- The same conversation list, labelled by name.
- **Bottom:**
  - The microphone line with "Pause".
  - Or, in hold-to-talk mode, one wide hold button, 72 to 88 px tall, with a mic icon and "Hold to talk".

### 11. States board

These frames are 360 px wide too, in both themes. They show:

- Every status pill.
- The Home problem banners.
- The End and Leave dialogs.
- Toasts.
- The microphone permission message.
- "Downloading Japanese for on-phone translation… 40%", and its failure: "Couldn't download Japanese. Connect to the internet once, then try again."
- Disabled choices with their reasons.
- The "Voices" row in each state: "Record them", "✓ Them · learned", "✓ Them", and the record, recording (with and without a red hint), and failed cards.

## Deliverables

1. Step 1 comes first: the three directions. Then stop and ask.
2. After my answer, make the variables, with light and dark modes.
3. Then the components:
   - status bar, top bar, and buttons (primary, secondary, danger, compact)
   - choice card, switch row, section title, language row and setup chip
   - chat bubbles: mine, theirs, skipped and live caption
   - the "Voices" row and its cards: record their voice, recording, failed, recorded
   - the "For them" panel, status pill, segmented control, hold button and microphone line
   - toast, banner and dialog
4. Screens 1 to 10 in light, left to right in the order of use, 80 px apart.
5. Below them, in dark: Home, Settings, and Conversation screens 7 and 8.
6. The 412 × 915 check frame.
7. The states board.

Use realistic English and Japanese text.

## Check before you finish

- Every frame is 360 px wide, except the one 412 check frame, and none is stretched.
- Nothing is clipped or overlapping at 360 px.
- Text is 14 px or more everywhere, and touch targets are 48 × 48 px or more.
- On screens 7 and 8, the "For them" panel and the conversation list take 65% of the height or more (70% without the "Voices" row). On screen 10, the list does.
- The bottom controls are 160 px or less.
- No description is longer than one short line, and every button label fits on one line.
- Contrast meets the numbers above, in both themes.
- Every feature in this brief appears somewhere.
