package expo.modules.earbridgeaudio

import android.annotation.TargetApi
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File
import java.io.InputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import kotlin.math.min
import kotlin.math.sqrt

private const val SAMPLE_RATE = 16_000
private const val CHUNK_SAMPLES = SAMPLE_RATE / 10 // 100 ms
private const val CHUNK_BYTES = CHUNK_SAMPLES * 2
private const val ROUTE_TIMEOUT_MS = 3_000L
private const val TAG = "EarbridgeAudio"
private const val PREFERENCES = "earbridge_audio"

/** Outputs that mean the user is wearing earphones. */
private val EARPHONE_TYPES = setOf(
  AudioDeviceInfo.TYPE_WIRED_HEADSET,
  AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
  AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
  AudioDeviceInfo.TYPE_BLUETOOTH_SCO,
  AudioDeviceInfo.TYPE_USB_HEADSET,
  AudioDeviceInfo.TYPE_HEARING_AID,
  AudioDeviceInfo.TYPE_BLE_HEADSET,
)

class CaptureOptions : Record {
  /** Listen through the earphones' microphone when they have one; otherwise the phone's. */
  @Field val earphoneMic: Boolean = false

  /** Test builds only: a raw 16 kHz 16-bit mono file to play in place of the microphone. */
  @Field val testInputPath: String? = null

  /** Also tell which way the sound came from, when the phone can record two of its microphones. */
  @Field val directions: Boolean = false
}

class VoicesOptions : Record {
  /** The speaker model that made the prints, in the voice models' folder. */
  @Field val model: String = ""

  /** Voice prints of the voices to keep: mine and the other person's. */
  @Field val prints: List<List<Double>> = emptyList()
}

private class CaptureException(message: String, cause: Throwable? = null) :
  CodedException("ERR_CAPTURE", message, cause)

/** Where the microphone is listening, for the app to show. */
private data class Input(val kind: String, val name: String)

/**
 * Captures the microphone as 16 kHz 16-bit mono PCM in 100 ms chunks.
 *
 * With `directions`, it records two of the phone's microphones when it can, sends on one of
 * them, and tells which way each chunk came from.
 *
 * The audio library's own recorder can't choose the earphones' microphone, so this does it:
 * a Bluetooth headset's microphone is only reachable in communication mode, and in that mode
 * Android also plays everything else (the translations included) through the same headset.
 */
class EarbridgeAudioModule : Module() {
  // Starting and stopping run here, one at a time: switching to a Bluetooth headset takes a
  // second or two, and nothing else should change the routing meanwhile.
  private val worker = Executors.newSingleThreadExecutor()
  // Talk reports (test builds) are written here, one line at a time, in order.
  private val reports = Executors.newSingleThreadExecutor()

  // The capture that may send audio; 0 when stopped. Readers of older captures check it and quit.
  @Volatile private var current = 0
  private var lastId = 0
  private var recorder: AudioRecord? = null
  private var reader: Thread? = null
  private var communicationMode = false
  private var legacySco = false
  private var earphones: Boolean? = null
  private var poseWatcher: PoseWatcher? = null
  // Goes up whenever the directions heard so far stop applying: the phone moved, or recording changed.
  private val pose = AtomicInteger()
  // What happens to what is heard now; set by the app.
  @Volatile private var micMode = MicMode.OFF
  // Passes the sound on, keeping only the two people's voices once the app says whose.
  private val voices = VoiceIsolator({ appContext.reactContext }) { name, body -> sendEvent(name, body) }

  private val context: Context
    get() = appContext.reactContext ?: throw CaptureException("The app is not ready.")
  private val audio: AudioManager
    get() = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager

  private val deviceCallback = object : AudioDeviceCallback() {
    override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>) = checkEarphones()
    override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>) = checkEarphones()
  }

  override fun definition() = ModuleDefinition {
    Name("EarbridgeAudio")
    Events(
      "onAudio",
      "onLevel",
      "onTurnEnd",
      "onSeparation",
      "onIsolation",
      "onCaptureError",
      "onEarphonesChange",
      "onRemoteCommand",
    )

    OnCreate {
      audio.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
      ConversationService.onCommand = { command -> sendEvent("onRemoteCommand", mapOf("command" to command)) }
    }

    OnDestroy {
      ConversationService.onCommand = null
      hideConversation()
      audio.unregisterAudioDeviceCallback(deviceCallback)
      worker.execute { stop() }
      worker.shutdown()
      reports.shutdown()
      voices.shutdown()
    }

    Function("earphonesConnected") { hasEarphones() }

    // A notification that keeps the conversation going in the background. Returns false if Android refused.
    Function("showConversation") { title: String, text: String, muted: Boolean -> showConversation(title, text, muted) }

    Function("hideConversation") { hideConversation() }

    // "live", "silent" or "off": what happens to what is heard from now on.
    Function("setMicMode") { mode: String ->
      micMode = when (mode) {
        "live" -> MicMode.LIVE
        "silent" -> MicMode.SILENT
        else -> MicMode.OFF
      }
    }

    // Keeps only these voices in the sound passed on, from now on.
    Function("keepVoices") { options: VoicesOptions ->
      if (!Regex("[A-Za-z0-9._-]+").matches(options.model) || options.model.startsWith(".")) {
        throw CaptureException("Bad model name.")
      }
      val prints = options.prints.map { print -> FloatArray(print.size) { print[it].toFloat() } }
      voices.keep(prints, File(File(context.filesDir, "voice-models"), options.model))
    }

    // Passes every voice on from now on.
    Function("keepAllVoices") { voices.keepAll() }

    // Test builds only: a line of a talk report, in the app's external files folder (readable over USB).
    Function("appendReport") { name: String, line: String ->
      reports.execute {
        try {
          val folder = File(context.getExternalFilesDir(null), "reports")
          folder.mkdirs()
          File(folder, name).appendText(line + "\n")
        } catch (error: Exception) {
          Log.w(TAG, "Couldn’t write the talk report: ${error.message}")
        }
      }
    }

    AsyncFunction("startCapture") { options: CaptureOptions, promise: Promise ->
      worker.execute {
        try {
          val input = start(options)
          promise.resolve(mapOf("input" to input.kind, "name" to input.name))
        } catch (error: CodedException) {
          promise.reject(error)
        } catch (error: Exception) {
          promise.reject(CaptureException("Could not start the microphone: ${error.message}", error))
        }
      }
    }

    AsyncFunction("stopCapture") { promise: Promise ->
      worker.execute {
        stop()
        micMode = MicMode.OFF
        voices.release()
        promise.resolve()
      }
    }
  }

  // ---------------------------------------------------------------- background

  private fun showConversation(title: String, text: String, muted: Boolean): Boolean {
    ConversationService.running?.let {
      it.update(title, text, muted)
      return true
    }
    val intent = Intent(context, ConversationService::class.java)
      .putExtra(ConversationService.EXTRA_TITLE, title)
      .putExtra(ConversationService.EXTRA_TEXT, text)
      .putExtra(ConversationService.EXTRA_MUTED, muted)
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) context.startForegroundService(intent) else context.startService(intent)
      true
    } catch (error: Exception) {
      // Android 12 and newer only allow this while the app is on screen.
      false
    }
  }

  private fun hideConversation() {
    appContext.reactContext?.let { it.stopService(Intent(it, ConversationService::class.java)) }
  }

  // ---------------------------------------------------------------- earphones

  private fun hasEarphones(): Boolean =
    audio.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { it.type in EARPHONE_TYPES }

  private fun checkEarphones() {
    val connected = hasEarphones()
    val previous = earphones
    earphones = connected
    // The callback first reports the devices already there; only changes after that matter.
    if (previous != null && previous != connected) {
      sendEvent("onEarphonesChange", mapOf("connected" to connected))
    }
  }

  // ---------------------------------------------------------------- capture

  private fun start(options: CaptureOptions): Input {
    stop()
    val id = ++lastId
    options.testInputPath?.let { return startTestInput(id, it) }

    var input = Input("phone", "Phone microphone")
    var source = MediaRecorder.AudioSource.VOICE_RECOGNITION
    var preferred: AudioDeviceInfo? = null
    if (options.earphoneMic) {
      val headset = routeToHeadset()
      val wired = inputs().firstOrNull {
        it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET || it.type == AudioDeviceInfo.TYPE_USB_HEADSET
      }
      if (headset != null) {
        input = Input("earphones", headset.productName?.toString()?.trim().orEmpty().ifEmpty { "Bluetooth earphones" })
        source = MediaRecorder.AudioSource.VOICE_COMMUNICATION
      } else if (wired != null) {
        input = Input("earphones", "Wired earphones")
        preferred = wired
      }
    }
    if (input.kind == "phone") {
      preferred = inputs().firstOrNull { it.type == AudioDeviceInfo.TYPE_BUILTIN_MIC }
    }

    val stereo = if (options.directions && input.kind == "phone") startStereo(preferred) else null
    val record = stereo?.first ?: startMono(source, preferred)
    recorder = record
    current = id
    if (stereo != null) {
      // The phone may have been moved while it wasn't recording.
      pose.incrementAndGet()
      poseWatcher = PoseWatcher(context) { pose.incrementAndGet() }.also { it.start() }
    }
    reader = thread(name = "EarBridge microphone") { readLoop(id, record, stereo?.second, options) }
    return input
  }

  private fun startMono(source: Int, preferred: AudioDeviceInfo?): AudioRecord {
    val bufferBytes = maxOf(
      AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT),
      CHUNK_BYTES * 4,
    )
    val record = try {
      AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, bufferBytes)
    } catch (error: Exception) {
      restoreRouting()
      throw CaptureException("Could not open the microphone.", error)
    }
    if (record.state != AudioRecord.STATE_INITIALIZED) {
      record.release()
      restoreRouting()
      throw CaptureException("Could not open the microphone. Check that Alo is allowed to use it.")
    }
    if (!startRecording(record, preferred)) {
      record.release()
      restoreRouting()
      throw CaptureException("The microphone is in use by another app.")
    }
    return record
  }

  /** Records two of the phone's microphones, the first way that works; null if none does. */
  private fun startStereo(preferred: AudioDeviceInfo?): Pair<AudioRecord, Int>? {
    val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
    if (minimum <= 0) return null
    for (source in stereoSources()) {
      val record = try {
        AudioRecord(source, SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT, maxOf(minimum, CHUNK_BYTES * 2 * 4))
      } catch (error: Exception) {
        continue
      }
      if (record.state == AudioRecord.STATE_INITIALIZED && record.channelCount == 2 && startRecording(record, preferred)) {
        Log.i(TAG, "Recording two microphones from source $source")
        return record to source
      }
      record.release()
    }
    return null
  }

  /** Ways to record two microphones, best first: as for speech recognition, unprocessed, plain. */
  private fun stereoSources(): List<Int> {
    val sources = mutableListOf(MediaRecorder.AudioSource.VOICE_RECOGNITION)
    if (audio.getProperty(AudioManager.PROPERTY_SUPPORT_AUDIO_SOURCE_UNPROCESSED) == "true") {
      sources += MediaRecorder.AudioSource.UNPROCESSED
    }
    sources += MediaRecorder.AudioSource.MIC
    val known = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    return sources.filterNot { known.getString("one microphone $it", null) == Build.FINGERPRINT }
  }

  /** Many phones give one microphone twice. Remembered, so this way isn't tried again (until a system update). */
  private fun rememberOneMicrophone(source: Int, verdict: StereoCheck.Verdict) {
    Log.i(TAG, "Source $source gives one microphone: $verdict")
    appContext.reactContext?.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)?.edit()
      ?.putString("one microphone $source", Build.FINGERPRINT)?.apply()
  }

  private fun startRecording(record: AudioRecord, preferred: AudioDeviceInfo?): Boolean {
    preferred?.let { record.setPreferredDevice(it) }
    try {
      record.startRecording()
    } catch (error: IllegalStateException) {
      // Checked just below.
    }
    return record.recordingState == AudioRecord.RECORDSTATE_RECORDING
  }

  /** `stereoSource`: the source recording two microphones, or null when recording one. */
  private fun readLoop(id: Int, record: AudioRecord, stereoSource: Int?, options: CaptureOptions) {
    val channels = if (stereoSource != null) 2 else 1
    val samples = ShortArray(CHUNK_SAMPLES * channels)
    val bytes = ByteArray(CHUNK_BYTES)
    val finder = if (stereoSource != null) DirectionFinder() else null
    val check = StereoCheck()
    while (current == id) {
      var filled = 0
      while (filled < samples.size) {
        val count = record.read(samples, filled, samples.size - filled)
        if (current != id) return
        if (count < 0) {
          fail(id, "The microphone stopped working (error $count).")
          return
        }
        filled += count
      }
      var direction: Direction? = null
      var channel = 0
      if (stereoSource != null && finder != null) {
        val undecided = check.verdict == null
        check.add(samples)
        val verdict = check.verdict
        if (undecided && verdict != null && verdict != StereoCheck.Verdict.TWO) {
          rememberOneMicrophone(stereoSource, verdict)
          restart(id, options)
        }
        if (verdict == StereoCheck.Verdict.SECOND_ONLY) channel = 1
        if (check.plausible) direction = finder.add(samples)
      }
      for (index in 0 until CHUNK_SAMPLES) {
        val sample = samples[index * channels + channel].toInt()
        bytes[index * 2] = sample.toByte()
        bytes[index * 2 + 1] = (sample shr 8).toByte()
      }
      emit(id, bytes, stereoSource != null, direction)
    }
  }

  /** Records another way, after this one turned out to give one microphone twice. */
  private fun restart(id: Int, options: CaptureOptions) {
    worker.execute {
      if (current != id) return@execute
      try {
        start(options)
      } catch (error: Exception) {
        stop()
        sendEvent("onCaptureError", mapOf("message" to (error.message ?: "The microphone stopped working.")))
      }
    }
  }

  /** Test builds: plays a recording at real-time pace, then silence, as if someone spoke into the phone. */
  private fun startTestInput(id: Int, path: String): Input {
    val file = File(path).let { if (it.isAbsolute) it else File(context.getExternalFilesDir(null), path) }
    if (!file.canRead()) throw CaptureException("The test recording was not found: ${file.path}")
    current = id
    reader = thread(name = "EarBridge test microphone") {
      try {
        file.inputStream().buffered().use { stream ->
          val chunk = ByteArray(CHUNK_BYTES)
          var next = SystemClock.elapsedRealtime()
          while (current == id) {
            val count = readFully(stream, chunk)
            chunk.fill(0, count, chunk.size)
            emit(id, chunk)
            next += 100
            val wait = next - SystemClock.elapsedRealtime()
            if (wait > 0) Thread.sleep(wait)
          }
        }
      } catch (error: Exception) {
        fail(id, "The test recording could not be played: ${error.message}")
      }
    }
    return Input("test", file.name)
  }

  /**
   * `stereo`: recording two microphones, so telling directions (`direction` when it could).
   * The level goes to the app at once; the sound goes on as the app's mode says, through
   * `voices`.
   */
  private fun emit(id: Int, pcm: ByteArray, stereo: Boolean = false, direction: Direction? = null) {
    if (current != id) return
    var sum = 0.0
    for (index in 0 until pcm.size / 2) {
      val sample = (pcm[index * 2].toInt() and 0xff) or (pcm[index * 2 + 1].toInt() shl 8)
      val value = sample.toShort() / 32768.0
      sum += value * value
    }
    val level = min(1.0, sqrt(sum / (pcm.size / 2)) * 4)
    sendEvent("onLevel", mapOf("level" to level))
    val mode = micMode
    // Only what was heard says which way it came from.
    voices.hear(Heard(pcm.copyOf(), mode, if (stereo) pose.get() else null, if (mode == MicMode.LIVE) direction else null))
  }

  private fun fail(id: Int, message: String) {
    worker.execute {
      if (current != id) return@execute
      stop()
      sendEvent("onCaptureError", mapOf("message" to message))
    }
  }

  private fun stop() {
    current = 0
    poseWatcher?.stop()
    poseWatcher = null
    val record = recorder
    recorder = null
    try {
      record?.stop()
    } catch (error: IllegalStateException) {
      // It was not recording.
    }
    reader?.takeIf { it !== Thread.currentThread() }?.join(1_000)
    reader = null
    record?.release()
    restoreRouting()
    voices.endRun()
  }

  // ---------------------------------------------------------------- routing

  private fun inputs(): List<AudioDeviceInfo> = audio.getDevices(AudioManager.GET_DEVICES_INPUTS).toList()

  /** Switches to a Bluetooth headset's microphone. Returns the headset, or null if there is none or it didn't switch. */
  private fun routeToHeadset(): AudioDeviceInfo? =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) routeToCommunicationDevice() else routeToLegacySco()

  @TargetApi(Build.VERSION_CODES.S)
  private fun routeToCommunicationDevice(): AudioDeviceInfo? {
    val devices = audio.availableCommunicationDevices
    val headset = devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLE_HEADSET }
      ?: devices.firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO }
      ?: return null
    audio.mode = AudioManager.MODE_IN_COMMUNICATION
    communicationMode = true
    if (!audio.setCommunicationDevice(headset)) {
      restoreRouting()
      return null
    }
    // The headset's microphone is live once the link has switched over, which takes about a second.
    val deadline = SystemClock.elapsedRealtime() + ROUTE_TIMEOUT_MS
    while (audio.communicationDevice?.id != headset.id && SystemClock.elapsedRealtime() < deadline) {
      Thread.sleep(50)
    }
    if (audio.communicationDevice?.id != headset.id) {
      restoreRouting()
      return null
    }
    return headset
  }

  @Suppress("DEPRECATION")
  private fun routeToLegacySco(): AudioDeviceInfo? {
    val headset = inputs().firstOrNull { it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO } ?: return null
    if (!audio.isBluetoothScoAvailableOffCall) return null
    val connected = CountDownLatch(1)
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context, intent: Intent) {
        val state = intent.getIntExtra(AudioManager.EXTRA_SCO_AUDIO_STATE, AudioManager.SCO_AUDIO_STATE_ERROR)
        if (state == AudioManager.SCO_AUDIO_STATE_CONNECTED) connected.countDown()
      }
    }
    context.registerReceiver(receiver, IntentFilter(AudioManager.ACTION_SCO_AUDIO_STATE_UPDATED))
    try {
      audio.mode = AudioManager.MODE_IN_COMMUNICATION
      communicationMode = true
      audio.startBluetoothSco()
      legacySco = true
      if (!connected.await(ROUTE_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
        restoreRouting()
        return null
      }
      audio.isBluetoothScoOn = true
      return headset
    } finally {
      context.unregisterReceiver(receiver)
    }
  }

  @Suppress("DEPRECATION")
  private fun restoreRouting() {
    if (legacySco) {
      audio.isBluetoothScoOn = false
      audio.stopBluetoothSco()
      legacySco = false
    }
    if (communicationMode) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) audio.clearCommunicationDevice()
      audio.mode = AudioManager.MODE_NORMAL
      communicationMode = false
    }
  }

  private fun readFully(stream: InputStream, into: ByteArray): Int {
    var total = 0
    while (total < into.size) {
      val count = stream.read(into, total, into.size - total)
      if (count < 0) break
      total += count
    }
    return total
  }
}
