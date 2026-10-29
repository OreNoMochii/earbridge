"""Replays the app's whole-line rule for held "Me" lines (VoiceFilter.admits and the voice learned
here, shared/pipeline/voices.ts) over the prints scores.py dumped, with any bars, and counts my
words lost and the other talker's let through, in all and by kind of clip; then tries a grid of the
same / alike / unlike bars (see VoiceBars there) and lists the best, with CAM++'s bars for comparison.
usage: python -I sweep.py <scores.json> [--solo] [SAME ALIKE UNLIKE]   (--solo: lines nobody talks over only,
as the app judges the rest by their parts)"""
import itertools, json, sys
import numpy as np

data = json.load(open(sys.argv[1]))
args = sys.argv[2:]
SOLO = '--solo' in args
args = [a for a in args if a != '--solo']
if SOLO:
    data['sets'] = {name: [l for l in lines if not l['overlap']] for name, lines in data['sets'].items()}
UNLIKE_MARGIN, LEARN_MARGIN, SETTLED_PRINTS, SETTLED_SECONDS, REMEMBERED, MIN_LEARN, MAX_PRINT = 0.25, 0.1, 3, 8, 10, 1.5, 10
for s in data['sets'].values():
    for l in s:
        l['p'] = np.array(l['print'], dtype=np.float32)


class Learned:
    def __init__(self):
        self.sum, self.count, self.seconds, self.likenesses, self.print = None, 0, 0.0, [], None

    def likeness(self, p):
        return float(p @ self.print) if self.print is not None else -1.0

    @property
    def settled(self):
        return self.count >= SETTLED_PRINTS or (self.count >= 2 and self.seconds >= SETTLED_SECONDS)

    @property
    def least(self):
        return min(self.likenesses) if self.settled and len(self.likenesses) >= 2 else None

    def may_learn(self, p):
        return self.least is None or self.likeness(p) >= self.least - LEARN_MARGIN

    def unlike_below(self, same, unlike):
        return unlike if self.least is None else min(same, max(unlike, self.least - UNLIKE_MARGIN))

    def add(self, p, seconds):
        self.seconds += min(seconds, MAX_PRINT)
        if self.print is not None:
            self.likenesses = (self.likenesses + [float(p @ self.print)])[-(REMEMBERED - 1):]
        if self.sum is None:
            self.sum, self.count = p.copy(), 1
        else:
            keep = (REMEMBERED - 1) / REMEMBERED if self.count >= REMEMBERED else 1.0
            self.sum = self.sum * keep + p
            self.count = min(self.count + 1, REMEMBERED)
        self.print = self.sum / (np.linalg.norm(self.sum) + 1e-9)


def replay(lines, same, alike, unlike):
    """(my words kept, my words lost, their words let through) under the whole-line rule."""
    here = Learned()
    kept = lost = leaked = 0
    for l in lines:
        p, s, r = l['p'], l['seconds'], l['rec']
        if r >= same:
            if s >= MIN_LEARN and here.may_learn(p):
                here.add(p, s)
            ok = True
        elif r >= alike and not (here.settled and here.likeness(p) < here.unlike_below(same, unlike)):
            if here.print is None and s >= MIN_LEARN:
                here.add(p, s)
            ok = True
        else:
            ok = False
        if l['speaker'] == 'me':
            kept += l['words'] * ok
            lost += l['words'] * (not ok)
        else:
            leaked += l['words'] * ok
    return kept, lost, leaked


def kind(name):
    return ('earphone' if 'earphone' in name else 'plain') + ('-clean' if name.endswith('clean') else '-chatter')


def total(same, alike, unlike):
    by = {}
    for name, lines in data['sets'].items():
        k, l, g = replay(lines, same, alike, unlike)
        t = by.setdefault(kind(name), [0, 0, 0])
        t[0] += k; t[1] += l; t[2] += g
    return by


def show(label, same, alike, unlike):
    by = total(same, alike, unlike)
    lost = sum(v[1] for v in by.values()); leaked = sum(v[2] for v in by.values())
    parts = '  '.join(f'{k}: lost {v[1]:3} leaked {v[2]:3}' for k, v in sorted(by.items()))
    print(f'{label:34} SAME {same:.2f} ALIKE {alike:.2f} UNLIKE {unlike:.2f} | lost {lost:4} leaked {leaked:4} | {parts}')


print(f"model {data['model']}; {len(data['sets'])} clips{' (lines nobody talks over)' if SOLO else ''}; my words {sum(l['words'] for s in data['sets'].values() for l in s if l['speaker'] == 'me')}, "
      f"theirs {sum(l['words'] for s in data['sets'].values() for l in s if l['speaker'] != 'me')}")
show("CAM++'s bars", 0.4, 0.2, 0.3)
if args:
    show('asked', *map(float, args[:3]))
grid = []
for same, alike, unlike in itertools.product(np.arange(0.3, 0.71, 0.05), np.arange(0.1, 0.51, 0.05), np.arange(0.2, 0.61, 0.05)):
    if alike >= same or unlike > same:
        continue
    by = total(same, alike, unlike)
    lost = sum(v[1] for v in by.values()); leaked = sum(v[2] for v in by.values())
    grid.append((lost + leaked, leaked, lost, same, alike, unlike))
grid.sort()
print('best bars by my words lost + theirs let through:')
for cost, leaked, lost, same, alike, unlike in grid[:8]:
    show(f'  lost+leaked {cost}', same, alike, unlike)
print('fewest of theirs let through among the bars losing at most 10 more of my words than the best:')
near = [g for g in grid if g[2] <= grid[0][2] + 10]
near.sort(key=lambda g: (g[1], g[2]))
for cost, leaked, lost, same, alike, unlike in near[:3]:
    show(f'  leaked {leaked}', same, alike, unlike)
