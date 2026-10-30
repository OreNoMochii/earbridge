// Streams a 16 kHz clip through the app's real pipeline — SoloConversation with the real
// Deepgram recognizer (diarization on, gate on, as with the user's own keys) and real CAM++
// voice prints — holding the button for "Me" throughout, but for "Them" over the lines the
// clip's truth says were said holding that button, their voice recorded in an earlier talk
// when the clip set has their recording — and scores what was translated against the truth.
// Usage: node run.mts clips/clean.wav (see README.md)
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { SoloConversation } from '../../shared/pipeline/solo.ts';
import { DeepgramProvider } from '../../shared/pipeline/stt/deepgram.ts';
import { openDeepgramSocket } from '../../server/src/deepgram-socket.ts';
import { FakeTranslator } from '../../server/test/fakes.ts';
import { silentLogger } from '../../shared/pipeline/log.ts';
import { CAMPPLUS_BARS, ERES2NET_BARS } from '../../shared/pipeline/voices.ts';
import type { VoiceBars } from '../../shared/pipeline/voices.ts';

process.loadEnvFile(new URL('../../.env', import.meta.url).pathname);
const apiKey = process.env.DEEPGRAM_API_KEY;
if (!apiKey) throw new Error('DEEPGRAM_API_KEY is not set in .env');
const HERE = new URL('.', import.meta.url).pathname;
const [clip] = process.argv.slice(2);
if (!clip) throw new Error('usage: node run.mts clip.wav');

function pcmOf(path: string): Int16Array {
  const file = readFileSync(path);
  let at = 12;
  while (at + 8 <= file.length) {
    const id = file.toString('ascii', at, at + 4);
    const size = file.readUInt32LE(at + 4);
    if (id === 'data') return new Int16Array(file.buffer.slice(file.byteOffset + at + 8, file.byteOffset + at + 8 + size));
    at += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${path}`);
}

// The phone's voice-print module, stood in for by the same model on this Mac (or by another
// speaker model, to try one: VOICE_MODEL=<path to its .onnx>), with the bars that go with
// the model (see VoiceBars), known by its file name, or given: VOICE_BARS=same,alike,unlike.
const model = process.env.VOICE_MODEL ?? `${HERE}model/campplus.onnx`;
const bars: VoiceBars = barsOf(process.env.VOICE_BARS, model);
console.log(`model ${model.split('/').pop()}, bars same ${bars.same} alike ${bars.alike} unlike ${bars.unlike}`);

function barsOf(given: string | undefined, modelPath: string): VoiceBars {
  if (!given) return /eres2net/i.test(modelPath) ? ERES2NET_BARS : CAMPPLUS_BARS;
  const [same, alike, unlike] = given.split(',').map(Number);
  if ([same, alike, unlike].some((bar) => bar === undefined || !Number.isFinite(bar))) throw new Error('VOICE_BARS must be three numbers: same,alike,unlike');
  return { same: same!, alike: alike!, unlike: unlike! };
}
const python = spawn(`${HERE}venv/bin/python`, [`${HERE}printer.py`, model], { stdio: ['pipe', 'pipe', 'inherit'] });
let pending: Array<(print: Float32Array | undefined) => void> = [];
let incoming = Buffer.alloc(0);
python.stdout.on('data', (data: Buffer) => {
  incoming = Buffer.concat([incoming, data]);
  while (incoming.length >= 4) {
    const n = incoming.readUInt32LE(0);
    if (incoming.length < 4 + n * 4) return;
    const print = n > 0 ? new Float32Array(incoming.buffer.slice(incoming.byteOffset + 4, incoming.byteOffset + 4 + n * 4)) : undefined;
    incoming = incoming.subarray(4 + n * 4);
    pending.shift()!(print);
  }
});
let queue: Promise<unknown> = Promise.resolve();
function print(samples: Int16Array): Promise<Float32Array | undefined> {
  const job = queue.then(
    () =>
      new Promise<Float32Array | undefined>((resolve) => {
        pending.push(resolve);
        const header = Buffer.alloc(4);
        header.writeUInt32LE(samples.byteLength, 0);
        python.stdin.write(Buffer.concat([header, Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength)]));
      }),
  );
  queue = job.catch(() => undefined);
  return job;
}

// My recording: the clip set's own (clips/<set>recording.wav, a real voice's) when there is one, else the stand-in.
const recordingFile = `${HERE}clips/${clip.replace(/.*\//, '').replace(/(clean|snr\d+)\.wav$/, 'recording.wav')}`;
const mine = await print(pcmOf(existsSync(recordingFile) ? recordingFile : `${HERE}recording.wav`));
if (!mine) throw new Error('no print of the recording');
// Their voice: as recorded in an earlier talk, from the clip set's own recording of it (clips/<set>partner.wav)
// when there is one, unless RIG_PARTNER=none; else learned from what they say for themselves, if at all.
const partnerFile = recordingFile.replace(/recording\.wav$/, 'partner.wav');
const theirs = process.env.RIG_PARTNER !== 'none' && existsSync(partnerFile) ? await print(pcmOf(partnerFile)) : undefined;
if (process.env.RIG_PARTNER !== 'none' && existsSync(partnerFile) && !theirs) throw new Error('no print of their recording');

const truthFile = clip.replace(/.*\//, '').replace(/(clean|snr\d+)\.wav$/, 'truth.json');
if (truthFile === clip.replace(/.*\//, '')) throw new Error(`no truth file is known for ${clip}`);
const truth = JSON.parse(readFileSync(`${HERE}clips/${truthFile}`, 'utf8')).lines as Array<{ speaker: string; start: number; end: number; text: string; held?: string }>;
// Who holds the button: "Them" over the lines said holding it, from a little before to a little after, as a person would; else "Me".
const HOLD_MARGIN = 0.5;
const heldForThem = truth.filter((line) => line.held === 'them');
const holder = (at: number): 'me' | 'them' => (heldForThem.some((line) => at >= line.start - HOLD_MARGIN && at <= line.end + HOLD_MARGIN) ? 'them' : 'me');

const messages: any[] = [];
const entries: any[] = [];
let ids = 0;
// What the recognizer sent back, raw, with when it came on the clip's clock: for looking into
// what became of some words (written to <clip>.deepgram.run.jsonl).
const heardBack: string[] = [];
const loggedSocket: typeof openDeepgramSocket = (url, key, events) =>
  openDeepgramSocket(url, key, {
    ...events,
    message: (text) => {
      heardBack.push(JSON.stringify({ at: Number(((Date.now() - started) / 1000).toFixed(2)), ...JSON.parse(text) }));
      events.message(text);
    },
  });
const solo = new SoloConversation({
  myLang: 'en-US',
  theirLang: 'en-US', // the other talker reads English too: the stream for "Them" is opened in their language
  voiceLangs: [],
  stt: new DeepgramProvider({ apiKey, model: 'nova-3', fallbackModel: 'nova-2', openSocket: loggedSocket, keyHint: 'key' }),
  translator: new FakeTranslator(),
  synthesizer: undefined,
  send: (message) => messages.push({ t: Date.now(), ...message }),
  onFatal: (error) => {
    console.error('fatal', error);
    process.exit(1);
  },
  log: silentLogger,
  newId: () => `u${++ids}`,
  voices: { mine, print, bars },
  metered: true,
  report: (entry) => entries.push(entry),
});
solo.start();
if (theirs && !solo.usePartner(theirs)) throw new Error('their recording could not be used');
console.log(`their voice: ${theirs ? 'recorded' : 'to be learned from what they say for themselves'}`);
solo.setTalkMode('hold');
let holding: 'me' | 'them' = 'me';
solo.setSpeaker(holding);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const samples = pcmOf(clip);
const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
const CHUNK = 3200; // 100 ms
const started = Date.now();
let sent = 0;
for (let at = 0; at < bytes.length; at += CHUNK) {
  const side = holder(at / 2 / 16000);
  if (side !== holding) {
    holding = side;
    solo.setSpeaker(side);
  }
  solo.sendAudio(bytes.slice(at, at + CHUNK));
  sent++;
  const due = started + sent * 100;
  const wait = due - Date.now();
  if (wait > 0) await sleep(wait);
}
for (let i = 0; i < 20; i++) {
  solo.sendAudio(new Uint8Array(CHUNK));
  await sleep(100);
}
solo.flush();
await sleep(5000);
solo.close();
await sleep(500);
python.stdin.end();

const out = `${clip}.run.jsonl`;
writeFileSync(out, [...entries.map((e) => JSON.stringify({ kind: 'report', ...e })), ...messages.map((m) => JSON.stringify({ kind: 'message', ...m }))].join('\n') + '\n');
writeFileSync(`${clip}.deepgram.run.jsonl`, heardBack.join('\n') + '\n');

// ---- Scoring against the truth.
const who = (s: number, e: number) => {
  let best: string | undefined;
  let cover = 0;
  for (const line of truth) {
    const c = Math.max(0, Math.min(e, line.end) - Math.max(s, line.start));
    if (c > cover) [best, cover] = [line.speaker, c];
  }
  return best;
};
const r = (x: number | undefined) => (x === undefined ? '-' : x.toFixed(2));
// Words said under my button, by talker; and the other talker's said holding "Them", kept as theirs or let through as mine.
const totals = { me: 0, other: 0 };
const held = { total: 0, kept: 0, mine: 0 };
for (const line of truth) {
  if (line.held === 'them') held.total += line.text.split(/\s+/).length;
  else totals[line.speaker as 'me' | 'other'] += line.text.split(/\s+/).length;
}
const before = { me: 0, other: 0 };
const after = { me: 0, other: 0 };
const partsOf = new Map(entries.filter((e) => e.type === 'parts').map((e) => [e.id, e.parts]));
console.log(`\n=== ${clip}`);
for (const line of entries.filter((e) => e.type === 'line')) {
  const v = line.voice ?? {};
  console.log(`[${line.at.toFixed(1)}s] ${line.side === 'them' ? 'for them: ' : ''}${line.outcome}${line.reason ? ` (${line.reason})` : ''} mine=${r(v.mine)} here=${r(v.mineHere)}${(v.partner ?? -1) >= 0 || (v.partnerHere ?? -1) >= 0 ? ` theirs=${r(v.partner)} theirsHere=${r(v.partnerHere)}` : ''}${v.unlikeMineBelow !== undefined ? ` bar=${r(v.unlikeMineBelow)}` : ''}${v.doubtMineBelow !== undefined ? ` doubt=${r(v.doubtMineBelow)}` : ''} ${line.seconds?.toFixed(1)}s: ${JSON.stringify(line.text)}${line.kept !== undefined ? `\n        kept: ${JSON.stringify(line.kept)}` : ''}`);
  const parts = partsOf.get(line.id);
  for (const part of parts ?? []) console.log(`        part ${part.speaker}${part.apart ? ' (apart)' : ''} ${part.kept ? 'kept' : 'left out'} mine=${r(part.voice?.mine)} here=${r(part.voice?.mineHere)}${(part.voice?.partner ?? -1) >= 0 ? ` theirs=${r(part.voice?.partner)}` : ''} ${part.seconds.toFixed(1)}s: ${JSON.stringify(part.text)}`);
  if (!line.words) continue;
  if (line.side === 'them') {
    // Said holding "Them": theirs, kept as theirs; mine let through as theirs is a slip of the button.
    for (const word of line.words) {
      const t = who(word.start, word.end);
      const keptNow = line.outcome === 'translated' && (!parts || new Set((parts ?? []).filter((p: any) => p.kept).flatMap((p: any) => p.starts as number[])).has(word.start));
      if (!keptNow) continue;
      if (t === 'other') held.kept++;
      else if (t === 'me') held.mine++;
    }
    continue;
  }
  // As the whole line would have been judged (held for me: somewhat like my recording, or like my voice here).
  const wholeAdmitted = (v.mine ?? -1) >= 0.2 || (v.mineHere ?? -1) >= 0.4;
  const keptStarts = new Set((parts ?? []).filter((p: any) => p.kept).flatMap((p: any) => p.starts as number[]));
  for (const word of line.words) {
    const t = who(word.start, word.end) as 'me' | 'other' | undefined;
    if (!t) continue;
    if (wholeAdmitted) before[t]++;
    const keptNow = line.outcome === 'translated' && (!parts || keptStarts.has(word.start));
    if (keptNow) after[t]++;
  }
}
const gates = entries.filter((e) => e.type === 'gate');
const sentEntry = entries.find((e) => e.type === 'sent');
console.log(`gate: ${gates.length} entries, ${gates.filter((g) => g.open).length} open; sent ${sentEntry?.sent?.toFixed(1)} of ${sentEntry?.heard?.toFixed(1)} s`);
console.log(
  `words translated — whole-line rule: ${before.me}/${totals.me} mine, ${before.other}/${totals.other} theirs leaked; with the split: ${after.me}/${totals.me} mine, ${after.other}/${totals.other} theirs leaked` +
    (held.total > 0 ? `; held for them: ${held.kept}/${held.total} theirs${held.mine > 0 ? `, ${held.mine} mine` : ''}` : ''),
);
console.log(`skipped lines offered: ${messages.filter((m) => m.type === 'skipped').length}; wrote ${out}`);
process.exit(0);
