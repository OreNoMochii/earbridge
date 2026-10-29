"""An earphone microphone in a loud place, for the rig's clips (--earphone): every line is heard
through the telephone band, some of the room, and now and then the chatter louder for a
moment, differing line to line, so that my voice here is learned unevenly (the user's AirPods
lines score 0.43-0.73 like the voice learned from them, and strangers come much nearer to it).
Shared by make_clips.py (macOS voices) and make_real_clips.py (recorded voices)."""
import numpy as np

SR = 16000


def rms(x):
    return float(np.sqrt(np.mean(x * x)) + 1e-9)


def lowpass(x, hz, taps=255):
    k = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(2 * hz / SR * k) * np.hamming(taps)
    return np.convolve(x, h / h.sum(), mode='same')


def band(x, low, high):
    y = lowpass(x, high)
    return y - lowpass(y, low)


def reverb(x, rt60, wet, seed):
    rng = np.random.default_rng(seed)
    m = int(rt60 * SR)
    t = np.arange(m) / SR
    response = rng.standard_normal(m) * np.exp(-6.9 * t / rt60)
    response[0] = 0
    size = len(x) + m
    y = np.fft.irfft(np.fft.rfft(x, size) * np.fft.rfft(response, size), size)[: len(x)]
    return (1 - wet) * x + wet * y * (rms(x) / rms(y))


# (low Hz, high Hz, reverberation seconds, how much of the room, chatter on the line in dB SNR or None)
CHANNEL = {
    'A': (300, 3400, 0.3, 0.2, None),
    'B': (300, 2500, 0.5, 0.4, None),
    'C': (200, 5000, 0.3, 0.3, None),
    'D': (300, 3400, 0.5, 0.5, 5),
    'E': (300, 3400, 0.3, 0.2, 10),
}
# Which channel each line of a script goes through, in order (mine, mine, mine, mine, other, ...).
CHANNELS = ['A', 'B', 'D', 'A', 'D', 'B', 'A', 'E', 'E', 'B']


def through(x, name, seed, babble):
    """One line as heard through the named channel; `babble` is the place's chatter, to be mixed in."""
    low, high, rt60, wet, snr = CHANNEL[name]
    y = reverb(band(x, low, high), rt60, wet, seed)
    y = y * (2000.0 / rms(y))
    if snr is not None:
        at = seed * 7919 % (len(babble) - len(y))
        chatter = babble[at: at + len(y)]
        y = y + chatter * (2000.0 / rms(chatter)) / (10 ** (snr / 20))
    return y
