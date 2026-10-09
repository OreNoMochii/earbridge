package expo.modules.earbridgeaudio

import java.util.Random
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin
import kotlin.math.sqrt
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

private const val RATE = 16_000
private const val CHUNK = RATE / 10

/** A voice-like sound: many tones at once, so it can be delayed by any fraction of a sample. */
private class Sound(seed: Long, tones: Int = 160) {
  private val random = Random(seed)
  private val speeds = DoubleArray(tones) { 2 * PI * (150 + random.nextDouble() * 5_350) / RATE }
  private val phases = DoubleArray(tones) { random.nextDouble() * 2 * PI }
  private val gain = 1 / sqrt(tones / 2.0)

  /** At sample `t`, about 1 on average. */
  fun at(t: Double): Double {
    var sum = 0.0
    for (i in speeds.indices) sum += sin(speeds[i] * t + phases[i])
    return sum * gain
  }
}

/** Syllables: on half the time, `rate` times a second. */
private fun syllables(n: Int, rate: Double, phase: Double): Double = max(0.0, sin(2 * PI * rate * n / RATE + phase))

/** Interleaved sound from two microphones (0 and 1), made one sample at a time. */
private fun record(seconds: Double, sample: (n: Int, mic: Int) -> Double): ShortArray =
  ShortArray((seconds * RATE).toInt() * 2) { sample(it / 2, it % 2).roundToInt().coerceIn(-32_768, 32_767).toShort() }

private fun chunks(stereo: ShortArray): List<ShortArray> =
  (0 until stereo.size / (CHUNK * 2)).map { stereo.copyOfRange(it * CHUNK * 2, (it + 1) * CHUNK * 2) }

private fun directions(stereo: ShortArray): List<Direction?> {
  val finder = DirectionFinder()
  return chunks(stereo).map { finder.add(it) }
}

private fun verdictOf(stereo: ShortArray): StereoCheck.Verdict? {
  val check = StereoCheck()
  for (chunk in chunks(stereo)) check.add(chunk)
  return check.verdict
}

class DirectionFinderTest {
  @Test
  fun findsHowMuchLaterTheSecondMicrophoneHeardAVoice() {
    for (delay in listOf(5.0, -3.25, 0.6)) {
      val voice = Sound(1)
      val hiss = Random(2)
      // A second of quiet, then a voice: the second microphone hears it `delay` samples later.
      val stereo = record(3.0) { n, mic ->
        val voiced = if (n >= RATE) 2_000 * voice.at(n - if (mic == 1) delay else 0.0) else 0.0
        voiced + hiss.nextGaussian() * 20
      }
      val heard = directions(stereo).drop(10)
      assertTrue(heard.all { it != null })
      for (direction in heard.filterNotNull()) {
        assertEquals(delay, direction.delay, 0.3)
        assertTrue("clarity ${direction.clarity}", direction.clarity > 0.8)
      }
    }
  }

  @Test
  fun findsAVoiceAmongChatter() {
    val voice = Sound(3)
    val chatter = listOf(-6.5, -4.5, -2.5, -1.0, 0.0, 1.5, 3.0, 6.5).mapIndexed { i, delay ->
      Triple(Sound(10L + i), delay, Pair(3.0 + i * 0.3, i * 0.8))
    }
    val hiss = Random(4)
    // Eight people around talk all along, together about 5 dB quieter than the voice, which starts after a second.
    val stereo = record(4.0) { n, mic ->
      var sum = hiss.nextGaussian() * 20
      for ((sound, delay, rhythm) in chatter) {
        sum += 400 * syllables(n, rhythm.first, rhythm.second) * sound.at(n - if (mic == 1) delay else 0.0)
      }
      if (n >= RATE) sum += 2_000 * syllables(n, 4.0, 0.0) * voice.at(n - if (mic == 1) 5.0 else 0.0)
      sum
    }
    val clear = directions(stereo).drop(10).filterNotNull().filter { it.clarity >= 0.2 }
    val near = clear.count { abs(it.delay - 5) < 1.5 }
    assertTrue("$near of ${clear.size} near the voice", clear.size >= 15 && near >= clear.size * 0.6)
    val delays = clear.map { it.delay }.sorted()
    assertEquals(5.0, delays[delays.size / 2], 0.5)
  }

  @Test
  fun soundFromAllAroundHasNoClearDirection() {
    val noise = Random(5)
    // Each microphone hears something different: no direction.
    val stereo = record(3.0) { n, _ -> noise.nextGaussian() * if (n >= RATE) 2_000 else 20 }
    val heard = directions(stereo).drop(10).filterNotNull()
    assertTrue(heard.size >= 15)
    for (direction in heard) assertTrue("clarity ${direction.clarity}", direction.clarity < 0.2)
  }

  @Test
  fun tellsNothingFromSilenceOrSteadyHiss() {
    assertTrue(directions(ShortArray(RATE * 2 * 2)).all { it == null })
    val hiss = Random(6)
    val steady = directions(record(5.0) { _, _ -> hiss.nextGaussian() * 30 })
    assertTrue(steady.all { it == null || it.clarity < 0.2 })
  }
}

class StereoCheckTest {
  private val voice = Sound(7)
  private val hiss = Random(8)

  @Test
  fun hearsTwoMicrophones() {
    val two = record(3.0) { n, mic -> 2_000 * voice.at(n - if (mic == 1) 5.0 else 0.0) + hiss.nextGaussian() * 20 }
    assertEquals(StereoCheck.Verdict.TWO, verdictOf(two))
  }

  @Test
  fun hearsOneMicrophoneTwice() {
    assertEquals(StereoCheck.Verdict.SAME, verdictOf(record(1.0) { n, _ -> 2_000 * voice.at(n.toDouble()) }))
    // Copies hardly different, e.g. after a little processing, are still one microphone.
    val nearly = record(3.0) { n, mic -> 2_000 * voice.at(n.toDouble()) + if (mic == 1) hiss.nextGaussian() else 0.0 }
    assertEquals(StereoCheck.Verdict.SAME, verdictOf(nearly))
  }

  @Test
  fun hearsASilentChannel() {
    assertEquals(StereoCheck.Verdict.FIRST_ONLY, verdictOf(record(1.0) { n, mic -> if (mic == 0) 2_000 * voice.at(n.toDouble()) else 0.0 }))
    assertEquals(StereoCheck.Verdict.SECOND_ONLY, verdictOf(record(1.0) { n, mic -> if (mic == 1) 2_000 * voice.at(n.toDouble()) else 0.0 }))
    // 50 dB quieter: nothing but leaks.
    val faint = record(3.0) { n, mic -> voice.at(n - if (mic == 1) 5.0 else 0.0) * if (mic == 0) 2_000 else 6 }
    assertEquals(StereoCheck.Verdict.FIRST_ONLY, verdictOf(faint))
  }

  @Test
  fun waitsForSound() {
    assertEquals(null, verdictOf(ShortArray(RATE * 2 * 2)))
    // Quiet hiss alone: too soon to tell two microphones from one.
    assertEquals(null, verdictOf(record(3.0) { _, _ -> hiss.nextGaussian() * 20 }))
  }
}

class FftTest {
  @Test
  fun transformsLikeTheDefinition() {
    val random = Random(9)
    val size = 64
    val re = DoubleArray(size) { random.nextGaussian() }
    val im = DoubleArray(size) { random.nextGaussian() }
    val expectedRe = DoubleArray(size)
    val expectedIm = DoubleArray(size)
    for (k in 0 until size) {
      for (n in 0 until size) {
        val angle = -2 * PI * k * n / size
        expectedRe[k] += re[n] * cos(angle) - im[n] * sin(angle)
        expectedIm[k] += re[n] * sin(angle) + im[n] * cos(angle)
      }
    }
    Fft(size).transform(re, im)
    for (k in 0 until size) {
      assertEquals(expectedRe[k], re[k], 1e-9)
      assertEquals(expectedIm[k], im[k], 1e-9)
    }
  }
}
