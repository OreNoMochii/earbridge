package expo.modules.earbridgeaudio

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.math.sqrt

/** Where 100 ms of sound came from, as the phone's two microphones heard it. */
data class Direction(
  /**
   * How many samples (at 16 kHz) after the first microphone the sound reached the second;
   * negative when it reached the second first. Up to about 7 for microphones 15 cm apart.
   */
  val delay: Double,
  /** How clearly it came from one place: near 0 for chatter from all around, up to 1. */
  val clarity: Double,
)

/**
 * Tells every 100 ms which way the sound came from: how much later it reached one microphone
 * than the other (GCC-PHAT). Frequencies well above the background noise count most, so a
 * voice stands out from the chatter around it.
 */
class DirectionFinder {
  private val window = DoubleArray(FRAME) { 0.5 - 0.5 * cos(2 * PI * it / FRAME) }
  private val fft = Fft(FRAME)
  /** The last frame of each microphone, written round and round from `at`. */
  private val first = DoubleArray(FRAME)
  private val second = DoubleArray(FRAME)
  private var at = 0
  private var filled = 0
  private var sinceFrame = 0
  private val re = DoubleArray(FRAME)
  private val im = DoubleArray(FRAME)
  /** The background noise at each frequency, and how many frames it was learned from. */
  private val noise = DoubleArray(BINS)
  private var frames = 0
  /** Since the last result: each frequency's direction, weighted by how far it stood out. */
  private val sumRe = DoubleArray(BINS)
  private val sumIm = DoubleArray(BINS)
  private var weight = 0.0
  private val cosines = Array(STEPS) { step -> DoubleArray(BINS) { bin -> cos(angle(bin) * delayAt(step)) } }
  private val sines = Array(STEPS) { step -> DoubleArray(BINS) { bin -> sin(angle(bin) * delayAt(step)) } }

  /**
   * Adds interleaved stereo sound, such as 100 ms of it, and tells where it came from, or
   * null when too little of it stood out from the background to tell.
   */
  fun add(stereo: ShortArray, frameCount: Int = stereo.size / 2): Direction? {
    for (i in 0 until frameCount) {
      first[at] = stereo[2 * i].toDouble()
      second[at] = stereo[2 * i + 1].toDouble()
      at = (at + 1) % FRAME
      if (filled < FRAME) filled++
      if (++sinceFrame >= HOP && filled == FRAME) {
        sinceFrame = 0
        analyze()
      }
    }
    return conclude()
  }

  private fun analyze() {
    // Both microphones in one transform: the first as the real part, the second as the imaginary.
    for (n in 0 until FRAME) {
      val index = (at + n) % FRAME
      re[n] = first[index] * window[n]
      im[n] = second[index] * window[n]
    }
    fft.transform(re, im)
    val learning = frames < LEARN_FRAMES
    for (bin in 0 until BINS) {
      val k = LOW_BIN + bin
      val ar = re[k]
      val ai = im[k]
      val br = re[FRAME - k]
      val bi = im[FRAME - k]
      val firstRe = (ar + br) / 2
      val firstIm = (ai - bi) / 2
      val secondRe = (ai + bi) / 2
      val secondIm = (br - ar) / 2
      val firstPower = firstRe * firstRe + firstIm * firstIm
      val secondPower = secondRe * secondRe + secondIm * secondIm
      val power = firstPower + secondPower
      if (learning) {
        noise[bin] += (power - noise[bin]) / (frames + 1)
        continue
      }
      // The background follows quieter moments quickly and louder ones (maybe speech) slowly.
      if (power < SPEECH_ABOVE_NOISE * noise[bin]) noise[bin] += NOISE_RATE * (power - noise[bin])
      else noise[bin] *= NOISE_RISE
      val standsOut = if (power > 0) 1 - WEIGHT_NOISE * noise[bin] / power else 0.0
      val magnitude = sqrt(firstPower * secondPower)
      if (standsOut <= 0 || magnitude <= 0) continue
      // Only the phase difference counts (PHAT), so quiet frequencies count as much as loud ones.
      sumRe[bin] += standsOut * (firstRe * secondRe + firstIm * secondIm) / magnitude
      sumIm[bin] += standsOut * (firstIm * secondRe - firstRe * secondIm) / magnitude
      weight += standsOut
    }
    frames++
  }

  private fun conclude(): Direction? {
    if (weight < MIN_WEIGHT) {
      reset()
      return null
    }
    val values = DoubleArray(STEPS)
    var best = 0
    for (step in 0 until STEPS) {
      var value = 0.0
      val cosine = cosines[step]
      val sine = sines[step]
      for (bin in 0 until BINS) value += sumRe[bin] * cosine[bin] + sumIm[bin] * sine[bin]
      values[step] = value
      if (value > values[best]) best = step
    }
    var delay = delayAt(best)
    if (best in 1 until STEPS - 1) {
      // Between the steps: the top of a parabola through the best one and its neighbours.
      val left = values[best - 1]
      val right = values[best + 1]
      val curve = left - 2 * values[best] + right
      if (curve < 0) delay += 0.5 * (left - right) / curve * DELAY_STEP
    }
    val clarity = (values[best] / weight).coerceIn(0.0, 1.0)
    reset()
    return Direction(delay, clarity)
  }

  private fun reset() {
    sumRe.fill(0.0)
    sumIm.fill(0.0)
    weight = 0.0
  }

  companion object {
    const val FRAME = 512
    const val HOP = FRAME / 2
    /** 219 Hz to 5 kHz: below, noise rumbles and directions blur; above, speech fades. */
    const val LOW_BIN = 7
    const val HIGH_BIN = 160
    const val BINS = HIGH_BIN - LOW_BIN + 1
    /** Delays tried, in samples: further apart than any phone's microphones. */
    const val MAX_DELAY = 12.0
    const val DELAY_STEP = 0.25
    val STEPS = (2 * MAX_DELAY / DELAY_STEP).toInt() + 1
    /** The background is first learned from this many frames (130 ms). */
    const val LEARN_FRAMES = 8
    /** Louder than the background by this factor (5 dB) may be speech: the background is not learned from it. */
    const val SPEECH_ABOVE_NOISE = 3.0
    const val NOISE_RATE = 0.05
    /** Meanwhile the background may grow by 2 dB a second, in case it really got louder. */
    const val NOISE_RISE = 1.0074
    /** A frequency counts when louder than twice the background (3 dB), fully when far louder. */
    const val WEIGHT_NOISE = 2.0
    /** Too little standing out in 100 ms to tell a direction. */
    const val MIN_WEIGHT = 60.0

    private fun angle(bin: Int): Double = 2 * PI * (LOW_BIN + bin) / FRAME
    private fun delayAt(step: Int): Double = -MAX_DELAY + step * DELAY_STEP
  }
}

/**
 * Tells whether a stereo recording really comes from two microphones. Many phones fill both
 * channels from one microphone, or leave one silent, when they cannot record from two.
 */
class StereoCheck {
  enum class Verdict {
    /** Two microphones. */
    TWO,
    /** The same sound twice: one microphone. */
    SAME,
    FIRST_ONLY,
    SECOND_ONLY,
  }

  /** Null while it cannot tell yet. */
  var verdict: Verdict? = null
    private set
  /** Not one microphone twice nor a silent channel, as far as heard so far. */
  val plausible: Boolean
    get() = verdict == null || verdict == Verdict.TWO

  private var heard = 0
  private var loud = 0
  // Sums over the sound's changes from sample to sample: higher pitches, where two
  // microphones a few centimetres apart hear clearly different things.
  private var firstEnergy = 0.0
  private var secondEnergy = 0.0
  private var together = 0.0
  private var lastFirst = 0
  private var lastSecond = 0

  fun add(stereo: ShortArray, frameCount: Int = stereo.size / 2) {
    if (verdict != null) return
    var firstSum = 0.0
    var secondSum = 0.0
    var both = 0.0
    var firstChanges = 0
    var secondChanges = 0
    var peak = 0
    for (i in 0 until frameCount) {
      val a = stereo[2 * i].toInt()
      val b = stereo[2 * i + 1].toInt()
      val da = (a - lastFirst).toDouble()
      val db = (b - lastSecond).toDouble()
      if (a != lastFirst) firstChanges++
      if (b != lastSecond) secondChanges++
      lastFirst = a
      lastSecond = b
      firstSum += da * da
      secondSum += db * db
      both += da * db
      peak = max(peak, max(kotlin.math.abs(a), kotlin.math.abs(b)))
    }
    // Digital silence, e.g. as recording starts, says nothing.
    if (firstChanges == 0 && secondChanges == 0) return
    firstEnergy += firstSum
    secondEnergy += secondSum
    together += both
    heard++
    if (peak >= LOUD) loud++
    if (heard < QUICK_CHUNKS) return
    val correlation = if (firstEnergy > 0 && secondEnergy > 0) together / sqrt(firstEnergy * secondEnergy) else 0.0
    verdict = when {
      secondEnergy == 0.0 -> Verdict.FIRST_ONLY
      firstEnergy == 0.0 -> Verdict.SECOND_ONLY
      correlation >= IDENTICAL -> Verdict.SAME
      loud < LOUD_CHUNKS -> null
      secondEnergy < firstEnergy * DEAD -> Verdict.FIRST_ONLY
      firstEnergy < secondEnergy * DEAD -> Verdict.SECOND_ONLY
      correlation >= SAME_SOUND -> Verdict.SAME
      else -> Verdict.TWO
    }
  }

  companion object {
    /** A first look, from this many chunks with any sound: copies are exact, and silent channels silent. */
    const val QUICK_CHUNKS = 3
    const val IDENTICAL = 0.999
    /** Then, after this many chunks with sound clearly louder than the microphones' hiss (2 s)… */
    const val LOUD_CHUNKS = 20
    const val LOUD = 300
    /** …a channel 40 dB quieter than the other is dead… */
    const val DEAD = 1e-4
    /** …and two microphones never hear high pitches this much alike. */
    const val SAME_SOUND = 0.995
  }
}

/** A fast Fourier transform of a power-of-two size. */
internal class Fft(private val size: Int) {
  private val cosTable = DoubleArray(size / 2) { cos(2 * PI * it / size) }
  private val sinTable = DoubleArray(size / 2) { sin(2 * PI * it / size) }
  private val reversed: IntArray

  init {
    require(size >= 2 && size and (size - 1) == 0) { "The size must be a power of two." }
    val bits = Integer.numberOfTrailingZeros(size)
    reversed = IntArray(size) { Integer.reverse(it) ushr (32 - bits) }
  }

  /** In place: X[k] = Σ x[n]·e^(−2πikn/N). */
  fun transform(re: DoubleArray, im: DoubleArray) {
    for (i in 0 until size) {
      val j = reversed[i]
      if (j > i) {
        val r = re[i]
        re[i] = re[j]
        re[j] = r
        val m = im[i]
        im[i] = im[j]
        im[j] = m
      }
    }
    var half = 1
    while (half < size) {
      val step = size / (half * 2)
      var start = 0
      while (start < size) {
        for (k in 0 until half) {
          val c = cosTable[k * step]
          val s = sinTable[k * step]
          val i = start + k
          val j = i + half
          val tr = re[j] * c + im[j] * s
          val ti = im[j] * c - re[j] * s
          re[j] = re[i] - tr
          im[j] = im[i] - ti
          re[i] += tr
          im[i] += ti
        }
        start += half * 2
      }
      half *= 2
    }
  }
}
