package expo.modules.earbridgeaudio

import android.content.Context
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractor
import com.k2fsa.sherpa.onnx.SpeakerEmbeddingExtractorConfig
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.channels.FileChannel
import java.security.MessageDigest
import java.util.concurrent.Executors
import kotlin.math.abs
import kotlin.math.sqrt

private const val CONNECT_TIMEOUT_MS = 15_000
private const val READ_TIMEOUT_MS = 30_000
private const val PROGRESS_EVERY_MS = 250L
private const val SAMPLE_RATE = 16_000
/** Two of the phone's fast cores: more would bring in its slow ones. */
private const val THREADS = 2
/** Speech is brought to this loudness (RMS, full scale 1) first: prints shift a little with it. */
private const val LOUDNESS = 0.1f

private class VoiceException(message: String, cause: Throwable? = null) :
  CodedException("ERR_VOICE", message, cause)

/**
 * Voice prints for "Only our voices": a small speaker model, downloaded once, turns
 * speech into a vector that points the same way for the same voice. Everything stays on
 * the phone.
 */
class EarbridgeVoiceModule : Module() {
  private val downloads = Executors.newSingleThreadExecutor()
  /** Loads the model and makes prints, one at a time. */
  private val prints = Executors.newSingleThreadExecutor()
  @Volatile private var cancelled = false
  /** Used on the `prints` thread only. */
  private var extractor: SpeakerEmbeddingExtractor? = null
  private var loaded: File? = null

  private val context: Context
    get() = appContext.reactContext ?: throw VoiceException("The app is not ready.")

  private val folder: File
    get() = File(context.filesDir, "voice-models")

  override fun definition() = ModuleDefinition {
    Name("EarbridgeVoice")
    Events("onModelProgress")

    OnDestroy {
      cancelled = true
      downloads.shutdownNow()
      prints.execute { unload() }
      prints.shutdown()
    }

    Function("hasModel") { file: String -> modelFile(file).isFile }

    AsyncFunction("downloadModel") { url: String, sha256: String, file: String, promise: Promise ->
      cancelled = false
      downloads.execute {
        try {
          download(URL(url), sha256.lowercase(), modelFile(file))
          promise.resolve()
        } catch (error: CodedException) {
          promise.reject(error)
        } catch (error: Exception) {
          promise.reject(VoiceException("Check the internet connection and try again.", error))
        }
      }
    }

    Function("cancelDownload") { cancelled = true }

    AsyncFunction("loadModel") { file: String, promise: Promise ->
      val model = modelFile(file)
      prints.execute {
        try {
          load(model)
          promise.resolve()
        } catch (error: CodedException) {
          promise.reject(error)
        } catch (error: Throwable) {
          promise.reject(VoiceException("Couldn’t load the voice model: ${error.message}", error))
        }
      }
    }

    AsyncFunction("voicePrint") { pcm: ByteArray, promise: Promise ->
      prints.execute {
        try {
          promise.resolve(print(pcm))
        } catch (error: CodedException) {
          promise.reject(error)
        } catch (error: Throwable) {
          promise.reject(VoiceException("Couldn’t make a voice print: ${error.message}", error))
        }
      }
    }

    Function("unloadModel") {
      prints.execute { unload() }
    }
  }

  // ---------------------------------------------------------------- download

  /** Only plain file names: the model lives in the app's own folder. */
  private fun modelFile(name: String): File {
    if (!Regex("[A-Za-z0-9._-]+").matches(name) || name.startsWith(".")) throw VoiceException("Bad model name.")
    return File(folder, name)
  }

  private fun download(url: URL, sha256: String, target: File) {
    if (target.isFile) return
    folder.mkdirs()
    val part = File(folder, "${target.name}.part")
    val connection = url.openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = CONNECT_TIMEOUT_MS
      connection.readTimeout = READ_TIMEOUT_MS
      connection.instanceFollowRedirects = true
      val status = connection.responseCode
      if (status != HttpURLConnection.HTTP_OK) throw VoiceException("The download server answered $status. Try again later.")
      val total = connection.contentLengthLong
      if (total > 0 && folder.usableSpace < total + 50L * 1024 * 1024) {
        throw VoiceException("There isn’t enough free space on the phone.")
      }
      val digest = MessageDigest.getInstance("SHA-256")
      var received = 0L
      var reported = 0L
      connection.inputStream.use { input ->
        part.outputStream().use { output ->
          val buffer = ByteArray(64 * 1024)
          while (true) {
            if (cancelled) throw VoiceException("Cancelled.")
            val count = input.read(buffer)
            if (count < 0) break
            output.write(buffer, 0, count)
            digest.update(buffer, 0, count)
            received += count
            val now = System.currentTimeMillis()
            if (now - reported >= PROGRESS_EVERY_MS) {
              reported = now
              sendEvent("onModelProgress", mapOf("received" to received.toDouble(), "total" to total.coerceAtLeast(0).toDouble()))
            }
          }
        }
      }
      val actual = digest.digest().joinToString("") { "%02x".format(it) }
      if (actual != sha256) throw VoiceException("The download was damaged. Try again.")
      fixAveragePools(part)
      sendEvent("onModelProgress", mapOf("received" to received.toDouble(), "total" to received.toDouble()))
      if (!part.renameTo(target)) throw IOException("Could not save the model.")
      // Older models are of no use any more.
      folder.listFiles()?.filter { it != target }?.forEach { it.delete() }
    } finally {
      connection.disconnect()
      part.delete()
    }
  }

  // ---------------------------------------------------------------- voice prints

  private fun load(model: File) {
    if (extractor != null && loaded == model) return
    unload()
    if (!model.isFile) throw VoiceException("The voice model is missing. Try again to download it.")
    extractor = SpeakerEmbeddingExtractor(config = SpeakerEmbeddingExtractorConfig(model = model.path, numThreads = THREADS))
    loaded = model
  }

  /** Empty when there is too little sound to print. */
  private fun print(pcm: ByteArray): FloatArray {
    val extractor = extractor ?: throw VoiceException("The voice model isn’t loaded.")
    val shorts = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
    val samples = FloatArray(shorts.remaining()) { shorts.get(it) / 32768f }
    if (!normalizeLoudness(samples)) return FloatArray(0)
    val stream = extractor.createStream()
    try {
      stream.acceptWaveform(samples, SAMPLE_RATE)
      stream.inputFinished()
      return if (extractor.isReady(stream)) extractor.compute(stream) else FloatArray(0)
    } finally {
      stream.release()
    }
  }

  private fun unload() {
    extractor?.release()
    extractor = null
    loaded = null
  }

  // ---------------------------------------------------------------- the model's fix

  /**
   * Makes the model's AveragePool layers average real frames only, as in training. They
   * average speech in 2-second blocks, the last one partial; the ONNX Runtime in sherpa-onnx
   * 1.13.8 (1.28) divides a partial block by the full block size when `count_include_pad`
   * is 1 (fixed in 1.29, microsoft/onnxruntime#29629), which skews the prints of most
   * lengths. With no padding, 0 means the same and avoids the bug. A one-byte change per
   * layer, made in place: the value 1 becomes 0.
   */
  private fun fixAveragePools(model: File) {
    RandomAccessFile(model, "rw").use { file ->
      val bytes = file.channel.map(FileChannel.MapMode.READ_WRITE, 0, file.length())
      val graph = fields(bytes, 0, bytes.limit()).firstOrNull { it.number == MODEL_GRAPH }
        ?: throw VoiceException("This isn’t a voice model Alo knows.")
      for (node in fields(bytes, graph.start, graph.end)) {
        if (node.number != GRAPH_NODE) continue
        val nodeFields = fields(bytes, node.start, node.end)
        if (nodeFields.none { it.number == NODE_OP_TYPE && bytes.text(it) == "AveragePool" }) continue
        val attributes = nodeFields.filter { it.number == NODE_ATTRIBUTE }.associate { attribute ->
          val attributeFields = fields(bytes, attribute.start, attribute.end)
          val name = attributeFields.first { it.number == ATTRIBUTE_NAME }
          bytes.text(name) to attributeFields
        }
        val padded = attributes["pads"].orEmpty().any { it.number == ATTRIBUTE_INTS && !bytes.isZero(it) }
        val countIncludePad = attributes["count_include_pad"]?.firstOrNull { it.number == ATTRIBUTE_I }
        if (padded || countIncludePad == null || bytes.varint(countIncludePad.start).first != 1L) continue
        bytes.put(countIncludePad.start, 0)
      }
      bytes.force()
    }
  }
}

/**
 * Brings speech to the loudness prints are made at, in place (the separated voices too).
 * False for silence.
 */
internal fun normalizeLoudness(samples: FloatArray): Boolean {
  var sum = 0.0
  var peak = 0f
  for (sample in samples) {
    sum += sample * sample
    peak = maxOf(peak, abs(sample))
  }
  if (peak == 0f) return false
  val gain = minOf(LOUDNESS / sqrt(sum / samples.size).toFloat(), 1f / peak)
  for (i in samples.indices) samples[i] *= gain
  return true
}

// The few ONNX protobuf fields the fix reads (onnx.proto).
private const val MODEL_GRAPH = 7
private const val GRAPH_NODE = 1
private const val NODE_OP_TYPE = 4
private const val NODE_ATTRIBUTE = 5
private const val ATTRIBUTE_NAME = 1
private const val ATTRIBUTE_I = 3
private const val ATTRIBUTE_INTS = 8

/** A field of a protobuf message: its number, and where its value is. */
private class Field(val number: Int, val start: Int, val end: Int)

/** The fields of the protobuf message from `start` to `end`. */
private fun fields(bytes: ByteBuffer, start: Int, end: Int): List<Field> {
  val fields = mutableListOf<Field>()
  var at = start
  while (at < end) {
    val (key, value) = bytes.varint(at)
    val number = (key ushr 3).toInt()
    val field = when ((key and 7).toInt()) {
      0 -> Field(number, value, bytes.varint(value).second)
      1 -> Field(number, value, value + 8)
      2 -> bytes.varint(value).let { (length, data) -> Field(number, data, data + length.toInt()) }
      5 -> Field(number, value, value + 4)
      else -> throw VoiceException("This isn’t a voice model Alo knows.")
    }
    fields += field
    at = field.end
  }
  if (at != end) throw VoiceException("This isn’t a voice model Alo knows.")
  return fields
}

/** The varint at `at`, and where what follows it starts. */
private fun ByteBuffer.varint(at: Int): Pair<Long, Int> {
  var value = 0L
  var shift = 0
  var next = at
  while (true) {
    val byte = get(next++).toInt()
    value = value or ((byte and 0x7f).toLong() shl shift)
    if (byte and 0x80 == 0) return value to next
    shift += 7
    if (shift >= 64) throw VoiceException("This isn’t a voice model Alo knows.")
  }
}

private fun ByteBuffer.text(field: Field): String = String(ByteArray(field.end - field.start) { get(field.start + it) })

/** Whether a number, or all the packed numbers, are 0. */
private fun ByteBuffer.isZero(field: Field): Boolean = (field.start until field.end).all { get(it) == 0.toByte() }
