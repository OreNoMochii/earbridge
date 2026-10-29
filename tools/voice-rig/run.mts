// Streams a 16 kHz clip through the app's real pipeline — SoloConversation with the real
// Deepgram recognizer (diarization on, gate on, as with the user's own keys) and real CAM++
// voice prints — holding the button for "Me" throughout, and scores what was translated
// against the clip's truth. Usage: node run.mts clips/clean.wav (see README.md)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { SoloConversation } from '../../shared/pipeline/solo.ts';
import { DeepgramProvider } from '../../shared/pipeline/stt/deepgram.ts';
import { openDeepgramSocket } from '../../server/src/deepgram-socket.ts';
import { FakeTranslator } from '../../server/test/fakes.ts';
import { silentLogger } from '../../shared/pipeline/log.ts';

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

// The phone's voice-print module, stood in for by the same model on this Mac.
const python = spawn(`${HERE}venv/bin/python`, [`${HERE}printer.py`, `${HERE}model/campplus.onnx`], { stdio: ['pipe', 'pipe', 'inherit'] });
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

const mine = await print(pcmOf(`${HERE}recording.wav`));
if (!mine) throw new Error('no print of the recording');

const messages: any[] = [];
const entries: any[] = [];
let ids = 0;
const solo = new SoloConversation({
  myLang: 'en-US',
  theirLang: 'ja',
  voiceLangs: [],
  stt: new DeepgramProvider({ apiKey, model: 'nova-3', fallbackModel: 'nova-2', openSocket: openDeepgramSocket, keyHint: 'key' }),
  translator: new FakeTranslator(),
  synthesizer: undefined,
  send: (message) => messages.push({ t: Date.now(), ...message }),
  onFatal: (error) => {
    console.error('fatal', error);
    process.exit(1);
  },
  log: silentLogger,
  newId: () => `u${++ids}`,
  voices: { mine, print },
  metered: true,
  report: (entry) => entries.push(entry),
});
solo.start();
solo.setTalkMode('hold');
solo.setSpeaker('me');

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const samples = pcmOf(clip);
const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
const CHUNK = 3200; // 100 ms
const started = Date.now();
let sent = 0;
for (let at = 0; at < bytes.length; at += CHUNK) {
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

// ---- Scoring against the truth.
const truthFile = clip.replace(/.*\//, '').startsWith('late-') ? 'late-truth.json' : 'truth.json';
const truth = JSON.parse(readFileSync(`${HERE}clips/${truthFile}`, 'utf8')).lines as Array<{ speaker: string; start: number; end: number; text: string }>;
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
const totals = { me: 0, other: 0 };
for (const line of truth) totals[line.speaker as 'me' | 'other'] += line.text.split(/\s+/).length;
const before = { me: 0, other: 0 };
const after = { me: 0, other: 0 };
const partsOf = new Map(entries.filter((e) => e.type === 'parts').map((e) => [e.id, e.parts]));
console.log(`\n=== ${clip}`);
for (const line of entries.filter((e) => e.type === 'line')) {
  const v = line.voice ?? {};
  console.log(`[${line.at.toFixed(1)}s] ${line.outcome}${line.reason ? ` (${line.reason})` : ''} mine=${r(v.mine)} here=${r(v.mineHere)} ${line.seconds?.toFixed(1)}s: ${JSON.stringify(line.text)}${line.kept !== undefined ? `\n        kept: ${JSON.stringify(line.kept)}` : ''}`);
  const parts = partsOf.get(line.id);
  for (const part of parts ?? []) console.log(`        part ${part.speaker}${part.apart ? ' (apart)' : ''} ${part.kept ? 'kept' : 'left out'} mine=${r(part.voice?.mine)} here=${r(part.voice?.mineHere)} ${part.seconds.toFixed(1)}s: ${JSON.stringify(part.text)}`);
  if (!line.words) continue;
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
console.log(`words translated — whole-line rule: ${before.me}/${totals.me} mine, ${before.other}/${totals.other} theirs leaked; with the split: ${after.me}/${totals.me} mine, ${after.other}/${totals.other} theirs leaked`);
console.log(`skipped lines offered: ${messages.filter((m) => m.type === 'skipped').length}; wrote ${out}`);
process.exit(0);
