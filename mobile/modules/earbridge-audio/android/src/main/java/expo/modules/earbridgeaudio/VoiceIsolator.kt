package expo.modules.earbridgeaudio

import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import android.content.Context
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import java.io.File
import java.nio.FloatBuffer
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.sqrt

private const val TAG = "EarbridgeVoices"
private const val SAMPLE_RATE = 16_000
private const val CHUNK = SAMPLE_RATE / 10 // samples in 100 ms
/**
 * The separation model, in the app's assets: Conv-TasNet trained to split two voices out
 * of noise (asteroid's JorisCos/ConvTasNet_Libri2Mix_sepnoisy_16k, CC BY-SA 4.0), exported
 * to ONNX: "mix" [1, samples] in, "voices" [2, samples] out. Its convolutions are 8-bit
 * (static, calibrated on bar-like mixes): twice as fast on a phone, and as good at keeping words.
 */
private const val SEPARATOR = "convtasnet.onnx"
/** Sound is split 2 s at a time, every 1.5 s; the 0.5 s they share fades from one to the next. In chunks. */
private const val BLOCK = 20
private const val HOP = 15
private const val OVERLAP = BLOCK - HOP
/**
 * A separated voice at least this much like one of the two voice prints is kept: cosine similarity
 * on the scale of the phone's speaker model (CAM++; between its `alike` and `same` bars, see
 * VoiceBars in shared/pipeline/voices.ts), to change with the model.
 */
private const val KEEP = 0.3
/** A separated voice quieter than this (RMS, full scale 1) is nothing. */
private const val FLOOR = 1e-4
/** This far behind (5 s of sound waiting), the phone is too slow: sound passes on unseparated. */
private const val MAX_WAITING = 50
/** Two of the phone's fast cores: more would bring in its slow ones. */
private const val THREADS = 2

/** What happens to the sound: sent as heard, sent as silence, or not sent. */
internal enum class MicMode { LIVE, SILENT, OFF }

/** 100 ms of sound, with how it was to be sent when it was heard. */
internal class Heard(
  /** 16-bit PCM, little-endian. */
  val pcm: ByteArray,
  val mode: MicMode,
  /** While recording two microphones (see the module's `pose`). */
  val pose: Int?,
  val direction: Direction?,
)

/**
 * Passes the microphone's sound on ("onAudio"), keeping only the voices asked for: each 2 s
 * is split into two voices by a small separation model, and each voice is kept if its voice
 * print is like one of the prints given (mine and theirs, or only the one expected to
 * talk). Everyone else, and most of the noise, drops out before the speech recognizer hears
 * it. When neither voice is like the prints, nothing passes, or the sound as heard when
 * asked (see `keep`): whoever holds a button to talk says the sound is theirs.
 *
 * Splitting needs a block of sound, so while it keeps voices the sound goes on 0.5 to 2 s
 * late, in bursts. Each chunk keeps the mode it was heard in, and when the microphone goes
 * off, what is left is split at once and "onTurnEnd" follows it: the turn can be finished.
 * Everything runs on one thread, in the order heard.
 */
internal class VoiceIsolator(
  private val context: () -> Context?,
  private val send: (name: String, body: Map<String, Any?>) -> Unit,
) {
  private val thread = Executors.newSingleThreadExecutor { Thread(it, "EarBridge voices") }
  /** Chunks heard and not yet taken. */
  private val waiting = AtomicInteger()

  // Used on `thread` only.
  private var prints: List<FloatArray> = emptyList()
  /** A block with no voice like the prints passes on as heard, rather than as nothing. */
  private var passUnmatched = false
  private var separator: OrtSession? = null
  private var printer: SpeakerEmbeddingExtractor? = null
  private var printerModel: File? = null
  /** The phone could not keep up: sound passes on as heard until the conversation ends. */
  private var slow = false
  /** Chunks that came while the models loaded, still waiting: not the phone being too slow. */
  private var allowance = 0
  private var lastMode = MicMode.OFF
  /** The stretch of sound being split, from chunk number `first` on. */
  private val run = ArrayDeque<Heard>()
  private var first = 0
  /** The first chunk not passed on yet. */
  private var done = 0
  /** Where the next block starts. */
  private var next = 0
  /** The last block's voices for the part it shares with the next, from `next` on. */
  private var carry: FloatArray? = null

  private val keeping: Boolean
    get() = prints.isNotEmpty() && separator != null && printer != null && !slow

  /** From the microphone's thread. */
  fun hear(heard: Heard) {
    waiting.incrementAndGet()
    execute {
      waiting.decrementAndGet()
      take(heard)
    }
  }

  /**
   * Keeps only voices like these prints from now on; `model` is the speaker model that made
   * them. With `passUnmatched`, a block with no voice like them passes on as heard, rather
   * than as nothing. Already keeping voices with that model, it just takes the prints, from
   * the next block on: as a voice is learned further, its print changes with most lines.
   */
  fun keep(voices: List<FloatArray>, model: File, passUnmatched: Boolean) = execute {
    this.passUnmatched = passUnmatched
    if (keeping && printerModel == model) {
      if (voices.size != prints.size || !voices.indices.all { voices[it].contentEquals(prints[it]) }) prints = voices.map { it.copyOf() }
      return@execute
    }
    finishRun()
    try {
      load(model)
      prints = voices.map { it.copyOf() }
      allowance = waiting.get()
      send("onIsolation", mapOf("state" to if (slow) "slow" else "on"))
    } catch (error: Throwable) {
      Log.w(TAG, "Couldn’t start separating voices", error)
      prints = emptyList()
      send("onIsolation", mapOf("state" to "failed", "message" to (error.message ?: error.toString())))
    }
  }

  /** Passes every voice on from now on. */
  fun keepAll() = execute {
    if (prints.isEmpty()) return@execute
    finishRun()
    prints = emptyList()
    send("onIsolation", mapOf("state" to "off"))
  }

  /** The microphone stopped (maybe to start again another way): what is left is passed on. */
  fun endRun() = execute { finishRun() }

  /** The conversation is over: forgets the voices and frees the models. */
  fun release() = execute {
    finishRun()
    prints = emptyList()
    slow = false
    lastMode = MicMode.OFF
    unload()
  }

  fun shutdown() {
    release()
    thread.shutdown()
  }

  private fun execute(task: () -> Unit) {
    try {
      thread.execute {
        try {
          task()
        } catch (error: Throwable) {
          Log.w(TAG, "Separating voices failed", error)
        }
      }
    } catch (error: java.util.concurrent.RejectedExecutionException) {
      // Shut down: the app is closing.
    }
  }

  // ---------------------------------------------------------------- the sound

  private fun take(heard: Heard) {
    val mode = heard.mode
    val wasOff = lastMode == MicMode.OFF
    lastMode = mode
    if (mode == MicMode.OFF) {
      if (!wasOff) {
        finishRun()
        send("onTurnEnd", emptyMap())
      }
      return
    }
    // Silence in place of what was heard, e.g. the phone reading a translation aloud.
    val chunk = if (mode == MicMode.SILENT) Heard(ByteArray(heard.pcm.size), mode, heard.pose, null) else heard
    if (!keeping) {
      pass(chunk)
      return
    }
    run.addLast(chunk)
    if (first + run.size >= next + BLOCK) separateBlock()
    val behind = waiting.get()
    allowance = minOf(allowance, behind)
    if (behind > allowance + MAX_WAITING) giveUp()
  }

  /** Splits the block at `next`, and passes on what no later block will change. */
  private fun separateBlock() {
    val voices = separate(samples(next, next + BLOCK))
    passSeparated(voices, 0, HOP)
    carry = voices.copyOfRange(HOP * CHUNK, BLOCK * CHUNK)
    next += HOP
    // A last block may reach this far back.
    while (first < next - BLOCK) {
      run.removeFirst()
      first++
    }
  }

  /** Splits and passes on whatever is left, e.g. at the end of a turn. */
  private fun finishRun() {
    if (run.isEmpty()) return
    val end = first + run.size
    if (end > done && keeping) {
      // A whole block where there is enough sound: more to tell the voices by.
      val start = maxOf(first, end - BLOCK)
      passSeparated(separate(samples(start, end)), (done - start) * CHUNK, end - done)
    } else {
      while (done < end) pass(run[done++ - first])
    }
    run.clear()
    carry = null
    first = 0
    done = 0
    next = 0
  }

  /** Passes on `count` chunks from `done`, separated: `voices` from `offset` on, faded in from `carry`. */
  private fun passSeparated(voices: FloatArray, offset: Int, count: Int) {
    val previous = carry
    val fade = OVERLAP * CHUNK
    for (k in 0 until count) {
      val heard = run[done - first + k]
      val pcm = ByteArray(CHUNK * 2)
      // Silence stays silence.
      if (heard.mode == MicMode.LIVE) {
        for (i in 0 until CHUNK) {
          val at = k * CHUNK + i
          var value = voices[offset + at]
          if (previous != null && at < fade) {
            val share = at.toFloat() / fade
            value = previous[at] * (1 - share) + value * share
          }
          val sample = (value * 32768f).toInt().coerceIn(-32768, 32767)
          pcm[i * 2] = sample.toByte()
          pcm[i * 2 + 1] = (sample shr 8).toByte()
        }
      }
      pass(Heard(pcm, heard.mode, heard.pose, heard.direction))
    }
    done += count
    carry = null
  }

  /** Too slow: passes on what waits as it was heard, and everything after. */
  private fun giveUp() {
    slow = true
    while (done < first + run.size) pass(run[done++ - first])
    run.clear()
    carry = null
    first = 0
    done = 0
    next = 0
    send("onIsolation", mapOf("state" to "slow"))
  }

  private fun pass(heard: Heard) {
    val event = mutableMapOf<String, Any?>("pcm" to Base64.encodeToString(heard.pcm, Base64.NO_WRAP))
    heard.pose?.let { event["pose"] = it }
    heard.direction?.let {
      event["delay"] = it.delay
      event["clarity"] = it.clarity
    }
    send("onAudio", event)
  }

  /** Chunks `from` until `to` of the run, from -1 to 1. */
  private fun samples(from: Int, to: Int): FloatArray {
    val out = FloatArray((to - from) * CHUNK)
    for (k in from until to) {
      val pcm = run[k - first].pcm
      val base = (k - from) * CHUNK
      for (i in 0 until CHUNK) {
        val sample = (pcm[i * 2].toInt() and 0xff) or (pcm[i * 2 + 1].toInt() shl 8)
        out[base + i] = sample.toShort() / 32768f
      }
    }
    return out
  }

  // ---------------------------------------------------------------- the voices

  /** The voices in `sound` that are like the prints, together; with none, nothing, or `sound` itself when asked. */
  private fun separate(sound: FloatArray): FloatArray {
    val n = sound.size
    val kept = FloatArray(n)
    if (sound.all { it == 0f }) return kept
    val started = SystemClock.elapsedRealtime()
    val environment = OrtEnvironment.getEnvironment()
    val voices = OnnxTensor.createTensor(environment, FloatBuffer.wrap(sound), longArrayOf(1, n.toLong())).use { input ->
      separator!!.run(mapOf("mix" to input)).use { result ->
        @Suppress("UNCHECKED_CAST")
        result[0].value as Array<FloatArray>
      }
    }
    val split = SystemClock.elapsedRealtime()
    // The model's voices have no set loudness: together, they are brought to the sound's.
    var cross = 0.0
    var power = 0.0
    for (i in 0 until n) {
      val both = (voices[0][i] + voices[1][i]).toDouble()
      cross += sound[i] * both
      power += both * both
    }
    val gain = (cross / (power + 1e-12)).toFloat()
    val scores = mutableListOf<Double>()
    val keep = mutableListOf<Boolean>()
    for (voice in voices) {
      var sum = 0.0
      for (i in 0 until n) {
        voice[i] *= gain
        sum += voice[i] * voice[i]
      }
      val likeness = if (sqrt(sum / n) < FLOOR) null else likeness(voice)
      val ours = likeness != null && likeness >= KEEP
      if (ours) for (i in 0 until n) kept[i] += voice[i]
      scores += likeness ?: -1.0
      keep += ours
    }
    // Neither voice is like the prints: whoever holds a button says the sound is theirs all the same.
    val passed = passUnmatched && keep.none { it }
    val finished = SystemClock.elapsedRealtime()
    send(
      "onSeparation",
      mapOf(
        "seconds" to n.toDouble() / SAMPLE_RATE,
        "splitMs" to (split - started).toDouble(),
        "printMs" to (finished - split).toDouble(),
        "scores" to scores,
        "kept" to keep,
        "passed" to passed,
        "waiting" to waiting.get().toDouble() / 10,
      ),
    )
    return if (passed) sound else kept
  }

  /** How alike the voice is to the closer of the two prints, from -1 to 1; null if it can't be printed. */
  private fun likeness(voice: FloatArray): Double? {
    val samples = voice.copyOf()
    if (!normalizeLoudness(samples)) return null
    val printer = printer!!
    val stream = printer.createStream()
    val print = try {
      stream.acceptWaveform(samples, SAMPLE_RATE)
      stream.inputFinished()
      if (printer.isReady(stream)) printer.compute(stream) else return null
    } finally {
      stream.release()
    }
    return prints.maxOf { cosine(print, it) }
  }

  private fun cosine(a: FloatArray, b: FloatArray): Double {
    if (a.size != b.size) return -1.0
    var dot = 0.0
    var aa = 0.0
    var bb = 0.0
    for (i in a.indices) {
      dot += a[i] * b[i]
      aa += a[i] * a[i]
      bb += b[i] * b[i]
    }
    return if (aa == 0.0 || bb == 0.0) -1.0 else dot / sqrt(aa * bb)
  }

  // ---------------------------------------------------------------- the models

  private fun load(model: File) {
    if (separator == null) {
      val context = context() ?: throw IllegalStateException("The app is not ready.")
      val bytes = context.assets.open(SEPARATOR).use { it.readBytes() }
      val options = OrtSession.SessionOptions().apply {
        setIntraOpNumThreads(THREADS)
        setInterOpNumThreads(1)
        setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT)
      }
      separator = options.use { OrtEnvironment.getEnvironment().createSession(bytes, it) }
    }
    if (printer == null || printerModel != model) {
      printer?.release()
      printer = null
      if (!model.isFile) throw IllegalStateException("The voice model is missing.")
      printer = SpeakerEmbeddingExtractor(config = SpeakerEmbeddingExtractorConfig(model = model.path, numThreads = THREADS))
      printerModel = model
    }
  }

  private fun unload() {
    separator?.close()
    separator = null
    printer?.release()
    printer = null
    printerModel = null
  }
}
