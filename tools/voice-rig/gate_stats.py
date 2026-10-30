#!/usr/bin/env python3
"""Counts how the gate judged the windows of rig runs (clips/<clip>.wav.run.jsonl, with the truth in
clips/<set>-truth.json) during my lines alone and during the other person's unheld lines alone, and
which part of the "rather theirs" rule fired (shared/pipeline/voices.ts, `ratherTheirs`): their
recording against mine (REC), or their voice here against mine here (HERE). "none" is a window
under both of my bars (plain unlike my voice), or, during their lines, caught by those bars alone.
The bars are CAM++'s (see `CAMPPLUS_BARS` and NEARER_MARGIN); change them below for another model.

Usage: python3 -I gate_stats.py [clips/<clip>.wav.run.jsonl ...]   (default: every real-late-turns-* run)
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ALIKE, SAME, MARGIN = 0.2, 0.4, 0.1
OVERLAP = 0.2  # a line counts for a window when they share more than this many seconds

paths = [a for a in sys.argv[1:] if not a.startswith('--')] or sorted(glob.glob(os.path.join(HERE, 'clips', 'real-late-turns-*.wav.run.jsonl')))


def who(lines, start, end):
    me = them = held = False
    for line in lines:
        if line['end'] > start + OVERLAP and line['start'] < end - OVERLAP:
            if line['speaker'] == 'me':
                me = True
            elif line.get('held'):
                held = True
            else:
                them = True
    return me, them, held


def count(path):
    clip = os.path.basename(path)[: -len('.wav.run.jsonl')]
    truth = json.load(open(os.path.join(os.path.dirname(path), clip.rsplit('-', 1)[0] + '-truth.json')))
    c = [0] * 12
    for raw in open(path):
        e = json.loads(raw)
        if e.get('type') != 'gate' or e['verdict'] == 'quiet':
            continue
        me, them, held = who(truth['lines'], e['start'], e['end'])
        v = e.get('voice') or {}
        m, mh, p, ph = (v.get(k, -1) for k in ('mine', 'mineHere', 'partner', 'partnerHere'))
        rec = p >= ALIKE and p >= m + MARGIN
        here = ph >= SAME and ph >= max(m, mh) + MARGIN
        ours = e['verdict'] in ('ours', 'maybe')
        if me and not them and not held:
            c[0] += 1
            if not ours:
                c[1] += 1
                c[2] += rec and not here
                c[3] += here and not rec
                c[4] += rec and here
                c[5] += not rec and not here
        elif them and not me and not held:
            c[6] += 1
            if ours:
                c[7] += 1
            else:
                c[8] += rec and not here
                c[9] += here and not rec
                c[10] += rec and here
                c[11] += not rec and not here
    return clip, c


def row(name, c):
    print(f'{name:42} {c[0]:6} {c[1]:5} {c[2]:4} {c[3]:4} {c[4]:4} {c[5]:4} | {c[6]:5} {c[7]:4} {c[8]:4} {c[9]:4} {c[10]:4} {c[11]:4}')


print(f"{'clip':42} {'mine':>6} {'other':>5} {'REC':>4} {'HERE':>4} {'both':>4} {'none':>4} | {'their':>5} {'ours':>4} {'REC':>4} {'HERE':>4} {'both':>4} {'none':>4}")
total = [0] * 12
for path in paths:
    clip, c = count(path)
    row(clip, c)
    total = [a + b for a, b in zip(total, c)]
if len(paths) > 1:
    row('all', total)
print('mine: windows with sound during my lines alone; other: judged someone else\'s, by which part of the rule fired (REC: their')
print('recording against mine, HERE: their voice here against mine here, none: under both of my bars). their: windows with sound')
print('during their unheld lines alone; ours: let through as mine; the rest were kept out, by what caught them (none: my bars alone).')
