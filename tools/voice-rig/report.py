#!/usr/bin/env python3
"""Reads talk reports kept on the phone (reports/<start>.jsonl, see mobile/src/engines/talk-report.ts)
or the rig's clip runs (clips/<clip>.wav.run.jsonl) and tells what the noisy-place filters did:
each line heard with its loudness, its voice likeness and the recognizer's talker labels, the
parts left out, the gate's windows, and at the end how my held lines compare with the other
voices heard: in loudness, in likeness to my recording and to my voice here, and in labels.

Usage: python3 -I report.py [--full] [--gate] report.jsonl [more.jsonl ...]
  --full   whole texts (else cut at 90 characters)
  --gate   every gate window, not only the summary

It prints the words of everyone heard: keep the output where the report is kept."""
import json
import statistics
import sys
from collections import Counter, defaultdict

FULL = '--full' in sys.argv
GATE = '--gate' in sys.argv
PATHS = [a for a in sys.argv[1:] if not a.startswith('--')]


def cut(text, n=90):
    text = text or ''
    return text if FULL or len(text) <= n else text[: n - 1] + '…'


def r(x, d=2):
    return '–' if x is None or x == -1 else f'{x:.{d}f}'


def span(xs, d=2):
    xs = [x for x in xs if x is not None and x != -1]
    if not xs:
        return '–'
    if len(xs) == 1:
        return r(xs[0], d)
    return f'{min(xs):.{d}f}–{max(xs):.{d}f} (median {statistics.median(xs):.{d}f}, n={len(xs)})'


def labels(words):
    return Counter(w.get('speaker') or '?' for w in words or [])


def fmt_labels(c):
    return ' '.join(f'{k}×{n}' for k, n in sorted(c.items())) if c else '–'


def voice_text(v):
    if not v:
        return 'voice –'
    s = f"mine={r(v.get('mine'))} here={r(v.get('mineHere'))}"
    if v.get('partner', -1) != -1 or v.get('partnerHere', -1) != -1:
        s += f" partner={r(v.get('partner'))} partnerHere={r(v.get('partnerHere'))}"
    if v.get('unlikeMineBelow') is not None:
        s += f" bar={r(v['unlikeMineBelow'])}"
    if v.get('doubtMineBelow') is not None:
        s += f" doubt={r(v['doubtMineBelow'])}"
    return s


def load(path):
    rows = []
    for raw in open(path, encoding='utf-8'):
        raw = raw.strip()
        if not raw:
            continue
        try:
            d = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if d.get('kind') == 'message':  # the rig also keeps the app's messages; the report entries say it all
            continue
        rows.append(d)
    return rows


def overlapping(windows, start, end):
    return [w for w in windows if w['start'] < end and w['end'] > start]


def talk(path):
    rows = load(path)
    by_id = defaultdict(dict)
    for d in rows:
        if 'id' in d and d.get('type') in ('line', 'windows', 'parts', 'translation', 'translated-after-all'):
            by_id[d['id']][d['type']] = d
    print(f'=== {path}')
    first = rows[0] if rows else {}
    if first.get('time'):
        print(f"started {first['time']}  ({len(rows)} entries, last {rows[-1].get('time', '?')})")
    for d in rows:
        t = d.get('type')
        if t == 'start':
            print('settings:', json.dumps(d.get('settings'), ensure_ascii=False))
        elif t == 'mic':
            print(f"mic {d.get('change') or 'at start'}: {json.dumps(d.get('input'), ensure_ascii=False)}")
        elif t == 'voices':
            print('voices:', json.dumps({k: v for k, v in d.items() if k not in ('type', 'time', 'kind')}, ensure_ascii=False))
        elif t == 'my-voice-here':
            print(f"my voice here: {d.get('prints')} prints taken up")
        elif t in ('loud', 'unlike-recording', 'end'):
            print(f"{t}{': ' + str(d.get('reason')) if d.get('reason') else ''} at {d.get('time', '?')}")
        elif t == 'talk-mode':
            print(f"talk mode: {d.get('mode')}")
        elif t == 'speaker':
            print(f"speaker: {d.get('selection')}")
    iso = [d for d in rows if d.get('type') == 'isolation']
    sep = [d for d in rows if d.get('type') == 'separation']
    if iso:
        keys = sorted({k for d in iso for k in d} - {'type', 'time'})
        print(f'isolation entries: {len(iso)}, first: ' + json.dumps({k: iso[0].get(k) for k in keys}, ensure_ascii=False)[:300])
    if sep:
        keys = sorted({k for d in sep for k in d} - {'type', 'time'})
        print(f'separation entries: {len(sep)}, keys {keys}, first: ' + json.dumps({k: sep[0].get(k) for k in keys}, ensure_ascii=False)[:300])

    print('\n--- lines')
    held_lines, other_lines = [], []
    kept_levels, out_levels = [], []  # gate/window levels under kept words and under words left out
    for d in rows:
        if d.get('type') != 'line':
            continue
        v = d.get('voice') or {}
        lab = labels(d.get('words'))
        margin = d.get('margin')
        print(
            f"[{d.get('at', 0):7.1f}s] {'held' if d.get('held') else 'free'} {d.get('side'):5} {d.get('outcome'):10}"
            f"{(' (' + str(d.get('reason')) + ')') if d.get('reason') else '':12}"
            f" {r(d.get('level'), 1):>6} dB margin {r(margin.get('db'), 1) if margin else '–':>5}"
            f"  {voice_text(v)}  {r(d.get('seconds'), 1)}s  labels {fmt_labels(lab)}"
        )
        print(f"           {json.dumps(cut(d.get('text')), ensure_ascii=False)}")
        if d.get('kept') is not None and d.get('kept') != d.get('text'):
            print(f"           kept: {json.dumps(cut(d['kept']), ensure_ascii=False)}")
        parts = by_id[d['id']].get('parts', {}).get('parts') or []
        windows = by_id[d['id']].get('windows', {}).get('windows') or []
        for p in parts:
            starts = p.get('starts') or []
            lv = [w.get('level') for w in overlapping(windows, min(starts), max(starts) + 0.5)] if starts and windows else []
            lv = [x for x in lv if x is not None]
            (kept_levels if p.get('kept') else out_levels).extend(lv)
            print(
                f"           part {p.get('speaker')}{' (apart)' if p.get('apart') else ''} {'kept    ' if p.get('kept') else 'left out'}"
                f" {voice_text(p.get('voice'))} {r(p.get('seconds'), 1)}s"
                f"{(' level ' + span(lv, 1)) if lv else ''}: {json.dumps(cut(p.get('text')), ensure_ascii=False)}"
            )
        if windows:
            print(
                f"           windows {len(windows)}: here {span([w['voice'].get('mineHere') for w in windows if w.get('voice')])}"
                f", mine {span([w['voice'].get('mine') for w in windows if w.get('voice')])}"
                f", level {span([w.get('level') for w in windows], 1)} dB"
            )
        after = by_id[d['id']].get('translated-after-all')
        if after:
            print(f"           translated after all: {after.get('why')}")
        (held_lines if d.get('held') else other_lines).append(d)

    gates = [d for d in rows if d.get('type') == 'gate']
    if gates:
        print('\n--- gate')
        if GATE:
            for g in gates:
                print(f"  {g['start']:7.1f}–{g['end']:6.1f}s {g.get('verdict'):6} {'open' if g.get('open') else 'shut'} {r(g.get('level'), 1):>6} dB {voice_text(g.get('voice'))}")
        by_verdict = defaultdict(list)
        for g in gates:
            by_verdict[g.get('verdict')].append(g)
        for verdict, gs in by_verdict.items():
            print(
                f"  {verdict:6} {len(gs):4} windows, {sum(g['end'] - g['start'] for g in gs):6.1f}s: level {span([g.get('level') for g in gs], 1)} dB,"
                f" mine {span([g['voice'].get('mine') for g in gs if g.get('voice')])}, here {span([g['voice'].get('mineHere') for g in gs if g.get('voice')])}"
            )
        shut = [g for g in gates if not g.get('open') and g.get('verdict') != 'quiet']
        if shut:
            print(f"  shut after {len(shut)} speaking windows: " + ', '.join(f"{g['start']:.1f}–{g['end']:.1f}" for g in shut[:30]) + (' …' if len(shut) > 30 else ''))
    for d in rows:
        if d.get('type') == 'sent':
            print(f"  sent {d.get('sent', 0):.1f} of {d.get('heard', 0):.1f} s heard")

    print('\n--- summary')
    for name, lines in (('held (mine)', held_lines), ('not held', other_lines)):
        if not lines:
            continue
        outcomes = Counter(f"{l.get('outcome')}{(' ' + str(l.get('reason'))) if l.get('reason') else ''}" for l in lines)
        lab = Counter()
        for l in lines:
            lab.update(labels(l.get('words')))
        print(f"{name}: {len(lines)} lines: " + ', '.join(f'{k} {n}' for k, n in outcomes.items()))
        print(f"   vs recording {span([(l.get('voice') or {}).get('mine') for l in lines])}")
        print(f"   vs my voice here {span([(l.get('voice') or {}).get('mineHere') for l in lines])}")
        print(f"   level {span([l.get('level') for l in lines], 1)} dB, margin {span([(l.get('margin') or {}).get('db') for l in lines], 1)} dB")
        print(f"   labels on their words: {fmt_labels(lab)}")
    if kept_levels or out_levels:
        print(f"windows under my kept parts: level {span(kept_levels, 1)} dB; under parts left out: {span(out_levels, 1)} dB")
    print()


if not PATHS:
    sys.exit(__doc__)
for p in PATHS:
    talk(p)
