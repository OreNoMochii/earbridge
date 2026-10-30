# What the recognizer sent back on a rig run, from the raw log that `node run.mts` writes next to
# the clip (`<clip>.wav.deepgram.run.jsonl`: every Deepgram message, with `at`, the clip's clock).
#
#   python3 -I deepgram_log.py count clips/*.deepgram.run.jsonl
#       per clip: final results, empty ones, empty ones where the interim results for the same
#       stretch of audio had words (the cases the client fills in from the interim results), and
#       how many words those had
#   python3 -I deepgram_log.py filled clips/*.deepgram.run.jsonl
#       each of those final results, with when it came on the clip's clock, its stretch and the
#       words kept from the interim results (those ending within the stretch)
#   python3 -I deepgram_log.py list clips/<clip>.wav.deepgram.run.jsonl [from to]
#       every final result and every interim result with text, in order, between two clip times:
#       when it came, FINAL or interim, S = speech_final, F = from_finalize, the stretch of the
#       connection's audio it is for (start + duration), the talker labels on its words, the text
import json
import sys


def results(path):
    """Every message of the log, in order."""
    with open(path) as log:
        for line in log:
            yield json.loads(line)


def alternative(message):
    alt = (message.get('channel') or {}).get('alternatives') or [{}]
    return alt[0].get('transcript', ''), alt[0].get('words') or []


SLACK = 0.05  # as in the client: a word ending this little past the stretch's end is within it


def finals(path):
    """Each final result of the log: (message, the interim words kept for it when it had none, else None)."""
    interim = None
    for m in results(path):
        if m.get('type') == 'Metadata':  # a new connection
            interim = None
            continue
        if m.get('type') != 'Results':
            continue
        _, words = alternative(m)
        start = m.get('start')
        if m.get('is_final'):
            kept = None
            if not words and interim and interim[0] == start:
                end = start + m.get('duration', float('inf')) + SLACK
                kept = [w for w in interim[1] if w.get('end', 0) <= end]
            interim = None
            yield m, kept
        elif words:
            interim = (start, words)


def clip_name(path):
    return path.split('/')[-1].replace('.wav.deepgram.run.jsonl', '')


def count(paths):
    total = [0, 0, 0, 0]
    for path in paths:
        n = empty = filled = words_back = 0
        for m, kept in finals(path):
            n += 1
            _, words = alternative(m)
            if not words:
                empty += 1
            if kept:
                filled += 1
                words_back += len(kept)
        print(f"{clip_name(path):45} finals {n:3}  empty {empty:3}  with interim words {filled:2}  words {words_back:3}")
        for i, v in enumerate((n, empty, filled, words_back)):
            total[i] += v
    print(f"{'all':45} finals {total[0]:3}  empty {total[1]:3}  with interim words {total[2]:2}  words {total[3]:3}")


def filled(paths):
    for path in paths:
        for m, kept in finals(path):
            if kept:
                text = ' '.join(w.get('punctuated_word', w.get('word', '')) for w in kept)
                print(f"{clip_name(path):45} at {m.get('at', 0):6.2f} seg {m.get('start', 0):6.2f}+{m.get('duration', 0):5.2f} {len(kept):2d}w: {text}")


def listing(path, lo, hi):
    for m in results(path):
        at = m.get('at', 0)
        kind = m.get('type')
        if not (lo <= at <= hi):
            continue
        if kind == 'Metadata':
            print(f"{at:7.2f}  -- connection opened")
            continue
        if kind == 'UtteranceEnd':
            print(f"{at:7.2f}  UtteranceEnd last_word_end={m.get('last_word_end')}")
            continue
        if kind == 'SpeechStarted':
            continue
        if kind != 'Results':
            print(f"{at:7.2f}  {kind}")
            continue
        text, words = alternative(m)
        final = bool(m.get('is_final'))
        if not final and not text:
            continue
        flags = ('S' if m.get('speech_final') else '') + ('F' if m.get('from_finalize') else '')
        speakers = sorted({w.get('speaker') for w in words if 'speaker' in w})
        print(f"{at:7.2f}  {'FINAL' if final else 'interim':7} {flags:2} seg {m.get('start', 0):6.2f}+{m.get('duration', 0):5.2f} spk={speakers} {len(words):2d}w: {text}")


if __name__ == '__main__':
    if len(sys.argv) >= 3 and sys.argv[1] == 'count':
        count(sys.argv[2:])
    elif len(sys.argv) >= 3 and sys.argv[1] == 'filled':
        filled(sys.argv[2:])
    elif len(sys.argv) >= 3 and sys.argv[1] == 'list':
        listing(sys.argv[2], float(sys.argv[3]) if len(sys.argv) > 3 else 0.0, float(sys.argv[4]) if len(sys.argv) > 4 else 1e9)
    else:
        sys.exit('usage: deepgram_log.py count <logs...> | filled <logs...> | list <log> [from to]')
