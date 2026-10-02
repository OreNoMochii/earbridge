package expo.modules.earbridgeaudio

import android.annotation.TargetApi
import android.content.Context
import android.content.Intent
import android.media.AudioFormat
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.speech.ModelDownloadListener
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.Log
import com.google.mlkit.common.model.DownloadConditions
import com.google.mlkit.common.model.RemoteModelManager
import com.google.mlkit.nl.translate.TranslateLanguage
import com.google.mlkit.nl.translate.TranslateRemoteModel
import com.google.mlkit.nl.translate.Translation
import com.google.mlkit.nl.translate.Translator
import com.google.mlkit.nl.translate.TranslatorOptions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.Closeable
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executor

private const val TAG = "EarBridgeOnDevice"
private const val SAMPLE_RATE = 16_000
/** Pipe writes up to this size are all or nothing, so dropping one never splits a sample. */
private const val ATOMIC_WRITE_BYTES = 4_096
/** About 8 s of audio, for while the recognizer finishes the previous turn. Linux allows up to 1 MB. */
private const val PIPE_BYTES = 256 * 1024
private const val F_SETPIPE_SZ = 1031 // Linux fcntl command; not in OsConstants
private const val RESTART_DELAY_MS = 150L
/** How long the recognizer may go quiet after the audio ended before it is stopped. */
private const val END_TIMEOUT_MS = 4_000L
private const val MAX_FAILURES = 5
/** An ended turn is retried fewer times: only its last words are at stake. */
private const val MAX_FAILURES_WHEN_ENDING = 2
private const val CHECK_TIMEOUT_MS = 15_000L
/** Partial results also carry the words the recognizer may still change (not in the public API). */
private const val UNSTABLE_TEXT = "android.speech.extra.UNSTABLE_TEXT"
private const val NEEDS_ANDROID_13 = "On-phone speech recognition needs Android 13 or newer."

private class OnDeviceException(message: String, cause: Throwable? = null) :
  CodedException("ERR_ON_DEVICE", message, cause)

/**
 * Audio on its way to the recognizer: the app writes what it records into one end, and
 * the recognizer reads the other. Writes never block; if the recognizer falls further
 * behind than the pipe holds, the newest audio is dropped.
 */
@TargetApi(Build.VERSION_CODES.TIRAMISU)
private class AudioPipe {
  val source: ParcelFileDescriptor
  private var sink: ParcelFileDescriptor?
  private var written = 0L

  init {
    val ends = ParcelFileDescriptor.createPipe()
    source = ends[0]
    sink = ends[1]
    Os.fcntlInt(ends[1].fileDescriptor, OsConstants.F_SETFL, OsConstants.O_NONBLOCK)
    try {
      Os.fcntlInt(ends[1].fileDescriptor, F_SETPIPE_SZ, PIPE_BYTES)
    } catch (error: ErrnoException) {
      // The default size, about 2 s of audio, will do.
    }
  }

  @get:Synchronized
  val bytesWritten: Long
    get() = written

  @Synchronized
  fun write(pcm: ByteArray) {
    val fd = sink?.fileDescriptor ?: return
    var offset = 0
    try {
      while (offset < pcm.size) {
        val count = Os.write(fd, pcm, offset, minOf(ATOMIC_WRITE_BYTES, pcm.size - offset))
        if (count <= 0) break
        offset += count
        written += count
      }
    } catch (error: ErrnoException) {
      // EAGAIN: the pipe is full, so this audio is dropped.
    }
  }

  /** No more audio: the recognizer reads to the end of what was written, then stops. */
  @Synchronized
  fun close() {
    sink?.let(::closeQuietly)
    sink = null
  }

  fun release() {
    close()
    closeQuietly(source)
  }
}

private fun closeQuietly(closeable: Closeable) {
  try {
    closeable.close()
  } catch (error: IOException) {
    // Already closed.
  }
}

/** One turn of speech in one language, from its first audio until its last word is recognized. */
private class RecognitionSession(val id: Int, val language: String) {
  val pipe = AudioPipe()

  // Main thread only.
  var ending = false
  var finished = false
  var ready = false
  var heard = false
  var failures = 0
}

/**
 * Speech recognition and translation that run on the phone itself, with no server:
 * Android's on-device speech recognizer (Android 13 and newer) and Google ML Kit's
 * downloadable translation models.
 *
 * Recognition sessions run one at a time, in the order they were started, because the
 * recognizer only listens to one thing at a time. A session that is waiting for its turn
 * keeps its audio in its pipe meanwhile, so nothing said in between is lost.
 */
class EarbridgeOnDeviceModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val mainExecutor = Executor { main.post(it) }
  private val sessions = ConcurrentHashMap<Int, RecognitionSession>()

  // Main thread only.
  private val queue = ArrayDeque<RecognitionSession>()
  private var recognizer: SpeechRecognizer? = null
  private var helper: SpeechRecognizer? = null
  private var listening = false
  private var restart: Runnable? = null
  private var watchdog: Runnable? = null
  private val translators = HashMap<String, Translator>()

  private val context: Context
    get() = appContext.reactContext ?: throw OnDeviceException("The app is not ready.")

  override fun definition() = ModuleDefinition {
    Name("EarbridgeOnDevice")
    Events("onRecognition", "onDownloadProgress")

    OnDestroy {
      main.post { shutDown() }
    }

    Function("isAvailable") {
      Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
        SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
    }

    // The languages the recognizer has installed, has scheduled to download, or can download.
    AsyncFunction("recognitionLanguages") { promise: Promise ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
        promise.reject(OnDeviceException(NEEDS_ANDROID_13))
      } else {
        checkLanguages(promise)
      }
    }.runOnQueue(Queues.MAIN)

    // Resolves "done", or "scheduled"/"requested" when Android downloads it in its own time.
    AsyncFunction("downloadRecognition") { language: String, promise: Promise ->
      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
          download(intent, language, promise)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
          helper().triggerModelDownload(intent)
          promise.resolve("requested")
        } else {
          promise.reject(OnDeviceException(NEEDS_ANDROID_13))
        }
      } catch (error: Exception) {
        promise.reject(OnDeviceException("Could not download speech recognition: ${error.message}", error))
      }
    }.runOnQueue(Queues.MAIN)

    // The audio: 16 kHz 16-bit mono PCM, written as it is recorded and ended with endAudio.
    Function("startRecognition") { session: Int, language: String ->
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) throw OnDeviceException(NEEDS_ANDROID_13)
      val created = RecognitionSession(session, language)
      sessions.put(session, created)?.pipe?.release()
      main.post { enqueue(created) }
      Unit
    }

    Function("writeAudio") { session: Int, pcm: ByteArray ->
      sessions[session]?.pipe?.write(pcm)
      Unit
    }

    // Recognizes the rest of what was written, then reports "end".
    Function("endAudio") { session: Int ->
      sessions[session]?.let { ended ->
        ended.pipe.close()
        main.post { audioEnded(ended) }
      }
      Unit
    }

    // Stops at once; reports "end" too.
    Function("cancelRecognition") { session: Int ->
      sessions[session]?.let { cancelled ->
        cancelled.pipe.close()
        main.post { cancel(cancelled) }
      }
      Unit
    }

    // ML Kit language codes ("en", "es", "zh"...) of the translation models already downloaded.
    AsyncFunction("translationModels") { promise: Promise ->
      RemoteModelManager.getInstance().getDownloadedModels(TranslateRemoteModel::class.java)
        .addOnSuccessListener { models -> promise.resolve(models.map { it.language }) }
        .addOnFailureListener { error -> promise.reject(OnDeviceException("Could not list the translation models: ${error.message}", error)) }
    }.runOnQueue(Queues.MAIN)

    // Downloads the models a language pair needs (about 30 MB per language), unless it has them.
    AsyncFunction("prepareTranslation") { source: String, target: String, promise: Promise ->
      try {
        translator(source, target).downloadModelIfNeeded(DownloadConditions.Builder().build())
          .addOnSuccessListener { promise.resolve() }
          .addOnFailureListener { error ->
            promise.reject(OnDeviceException("The translation could not be downloaded: ${error.message}", error))
          }
      } catch (error: CodedException) {
        promise.reject(error)
      }
    }.runOnQueue(Queues.MAIN)

    AsyncFunction("translate") { source: String, target: String, text: String, promise: Promise ->
      try {
        translator(source, target).translate(text)
          .addOnSuccessListener { result -> promise.resolve(result) }
          .addOnFailureListener { error -> promise.reject(OnDeviceException("Translation failed: ${error.message}", error)) }
      } catch (error: CodedException) {
        promise.reject(error)
      }
    }.runOnQueue(Queues.MAIN)

    // Frees the memory the translation models take.
    Function("closeTranslation") {
      main.post { closeTranslators() }
      Unit
    }
  }

  // ---------------------------------------------------------------- languages and downloads

  /** For language checks and downloads, so they never disturb a recognition in progress. */
  @TargetApi(Build.VERSION_CODES.TIRAMISU)
  private fun helper(): SpeechRecognizer =
    helper ?: SpeechRecognizer.createOnDeviceSpeechRecognizer(context).also {
      it.setRecognitionListener(QuietListener)
      helper = it
    }

  @TargetApi(Build.VERSION_CODES.TIRAMISU)
  private fun checkLanguages(promise: Promise) {
    var settled = false
    val timeout = Runnable {
      if (!settled) {
        settled = true
        promise.reject(OnDeviceException("Android did not say which languages it can recognize."))
      }
    }
    main.postDelayed(timeout, CHECK_TIMEOUT_MS)
    val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    helper().checkRecognitionSupport(intent, mainExecutor, object : RecognitionSupportCallback {
      override fun onSupportResult(support: RecognitionSupport) {
        if (settled) return
        settled = true
        main.removeCallbacks(timeout)
        promise.resolve(
          mapOf(
            "installed" to support.installedOnDeviceLanguages,
            "pending" to support.pendingOnDeviceLanguages,
            "supported" to support.supportedOnDeviceLanguages,
          ),
        )
      }

      override fun onError(error: Int) {
        if (settled) return
        settled = true
        main.removeCallbacks(timeout)
        promise.reject(OnDeviceException("Android could not say which languages it can recognize (error $error)."))
      }
    })
  }

  @TargetApi(Build.VERSION_CODES.UPSIDE_DOWN_CAKE)
  private fun download(intent: Intent, language: String, promise: Promise) {
    var settled = false
    helper().triggerModelDownload(intent, mainExecutor, object : ModelDownloadListener {
      override fun onProgress(completedPercent: Int) {
        if (!settled) sendEvent("onDownloadProgress", mapOf("language" to language, "percent" to completedPercent))
      }

      override fun onSuccess() = settle("done")

      override fun onScheduled() = settle("scheduled")

      override fun onError(error: Int) {
        if (settled) return
        settled = true
        promise.reject(OnDeviceException("Speech recognition could not be downloaded (error $error)."))
      }

      private fun settle(result: String) {
        if (settled) return
        settled = true
        promise.resolve(result)
      }
    })
  }

  // ---------------------------------------------------------------- recognition (main thread)

  private fun enqueue(session: RecognitionSession) {
    if (session.finished) return
    queue.addLast(session)
    if (queue.size == 1) begin(session)
  }

  /** Has the recognizer listen to the session at the head of the queue (again). */
  @TargetApi(Build.VERSION_CODES.TIRAMISU)
  private fun begin(session: RecognitionSession) {
    if (queue.firstOrNull() !== session || session.finished || listening) return
    if (session.ending && session.pipe.bytesWritten == 0L) {
      finish(session)
      return
    }
    session.ready = false
    session.heard = false
    listening = true
    try {
      val speech = recognizer ?: SpeechRecognizer.createOnDeviceSpeechRecognizer(context).also {
        it.setRecognitionListener(listener)
        recognizer = it
      }
      speech.startListening(intentFor(session))
    } catch (error: Exception) {
      Log.w(TAG, "session ${session.id}: could not start", error)
      listening = false
      dropRecognizer()
      fatal(session, SpeechRecognizer.ERROR_CLIENT)
      return
    }
    Log.d(TAG, "session ${session.id}: listening")
    if (session.ending) armWatchdog(session)
  }

  @TargetApi(Build.VERSION_CODES.TIRAMISU)
  private fun intentFor(session: RecognitionSession): Intent =
    Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
      .putExtra(RecognizerIntent.EXTRA_LANGUAGE, session.language)
      .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
      .putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
      .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE, session.pipe.source)
      .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_CHANNEL_COUNT, 1)
      .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_ENCODING, AudioFormat.ENCODING_PCM_16BIT)
      .putExtra(RecognizerIntent.EXTRA_AUDIO_SOURCE_SAMPLING_RATE, SAMPLE_RATE)
      // One continuous session that ends only when the audio does, instead of after each sentence.
      .putExtra(RecognizerIntent.EXTRA_SEGMENTED_SESSION, RecognizerIntent.EXTRA_AUDIO_SOURCE)
      .putExtra(RecognizerIntent.EXTRA_ENABLE_FORMATTING, RecognizerIntent.FORMATTING_OPTIMIZE_LATENCY)
      .putExtra(RecognizerIntent.EXTRA_MASK_OFFENSIVE_WORDS, false)

  private val listener = object : RecognitionListener {
    override fun onReadyForSpeech(params: Bundle?) {
      active()?.let(::ready)
    }

    override fun onBeginningOfSpeech() {
      active()?.let(::ready)
    }

    override fun onRmsChanged(rmsdB: Float) {}

    override fun onBufferReceived(buffer: ByteArray?) {}

    override fun onEndOfSpeech() {}

    override fun onPartialResults(partialResults: Bundle?) {
      val session = active() ?: return
      ready(session)
      progress(session)
      val stable = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull().orEmpty()
      val unstable = partialResults?.getStringArrayList(UNSTABLE_TEXT)?.firstOrNull().orEmpty()
      val text = (stable + unstable).trim()
      if (text.isNotEmpty()) emit(session, "partial", text)
    }

    override fun onSegmentResults(segmentResults: Bundle) {
      val session = active() ?: return
      ready(session)
      progress(session)
      bestText(segmentResults)?.let { text ->
        session.heard = true
        emit(session, "segment", text)
      }
    }

    override fun onEndOfSegmentedSession() {
      active()?.let { runEnded(it, readAll = true) }
    }

    override fun onResults(results: Bundle?) {
      val session = active() ?: return
      bestText(results)?.let { text ->
        session.heard = true
        emit(session, "segment", text)
      }
      runEnded(session, readAll = false)
    }

    override fun onError(error: Int) {
      active()?.let { failed(it, error) }
    }

    override fun onEvent(eventType: Int, params: Bundle?) {}
  }

  /** The session the recognizer is listening to, if it is. */
  private fun active(): RecognitionSession? = if (listening) queue.firstOrNull() else null

  private fun ready(session: RecognitionSession) {
    if (session.ready) return
    session.ready = true
    emit(session, "ready")
  }

  /** The recognizer is still at work: recovered from any earlier failure, and not stuck. */
  private fun progress(session: RecognitionSession) {
    session.failures = 0
    if (session.ending) armWatchdog(session)
  }

  /**
   * The recognizer stopped listening. `readAll` means it read the audio to its end; otherwise
   * (it stopped after one sentence, or heard nothing) there may be more audio waiting.
   */
  private fun runEnded(session: RecognitionSession, readAll: Boolean) {
    listening = false
    disarmWatchdog()
    if (session.ending && (readAll || !session.heard)) {
      finish(session)
    } else {
      schedule(session, RESTART_DELAY_MS)
    }
  }

  private fun failed(session: RecognitionSession, error: Int) {
    listening = false
    disarmWatchdog()
    Log.d(TAG, "session ${session.id}: error $error")
    when (error) {
      // Nothing (more) was said.
      SpeechRecognizer.ERROR_SPEECH_TIMEOUT, SpeechRecognizer.ERROR_NO_MATCH -> {
        if (session.ending) finish(session) else schedule(session, RESTART_DELAY_MS)
        return
      }
      SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS,
      SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
      SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> {
        fatal(session, error)
        return
      }
    }
    session.failures += 1
    if (session.ending && session.failures >= MAX_FAILURES_WHEN_ENDING) {
      emit(session, "error", code = error, fatal = false)
      finish(session)
      return
    }
    if (session.failures >= MAX_FAILURES) {
      fatal(session, error)
      return
    }
    emit(session, "error", code = error, fatal = false)
    // A recognizer that lost its service, or still thinks it is busy, is replaced.
    if (error == SpeechRecognizer.ERROR_SERVER_DISCONNECTED || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY ||
      error == SpeechRecognizer.ERROR_CLIENT
    ) {
      dropRecognizer()
    }
    schedule(session, minOf(RESTART_DELAY_MS shl session.failures, 3_000L))
  }

  private fun fatal(session: RecognitionSession, error: Int) {
    emit(session, "error", code = error, fatal = true)
    finish(session)
  }

  private fun audioEnded(session: RecognitionSession) {
    if (session.finished || session.ending) return
    session.ending = true
    // A session still waiting for its turn starts its watchdog when it runs.
    if (listening && queue.firstOrNull() === session) armWatchdog(session)
  }

  private fun cancel(session: RecognitionSession) {
    if (session.finished) return
    if (listening && queue.firstOrNull() === session) {
      recognizer?.cancel()
      listening = false
    }
    finish(session)
  }

  private fun finish(session: RecognitionSession) {
    if (session.finished) return
    session.finished = true
    val wasRunning = queue.firstOrNull() === session
    queue.remove(session)
    sessions.remove(session.id, session)
    session.pipe.release()
    emit(session, "end")
    if (wasRunning) {
      listening = false
      disarmWatchdog()
      cancelRestart()
      queue.firstOrNull()?.let { schedule(it, RESTART_DELAY_MS) }
    }
  }

  private fun schedule(session: RecognitionSession, delayMs: Long) {
    cancelRestart()
    val task = Runnable {
      restart = null
      begin(session)
    }
    restart = task
    main.postDelayed(task, delayMs)
  }

  private fun cancelRestart() {
    restart?.let(main::removeCallbacks)
    restart = null
  }

  /** Stops a recognizer that never finishes after the audio ended. */
  private fun armWatchdog(session: RecognitionSession) {
    disarmWatchdog()
    val task = Runnable {
      watchdog = null
      if (session.finished || !listening || queue.firstOrNull() !== session) return@Runnable
      Log.d(TAG, "session ${session.id}: no end after the audio ended")
      recognizer?.cancel()
      listening = false
      finish(session)
    }
    watchdog = task
    main.postDelayed(task, END_TIMEOUT_MS)
  }

  private fun disarmWatchdog() {
    watchdog?.let(main::removeCallbacks)
    watchdog = null
  }

  private fun dropRecognizer() {
    recognizer?.destroy()
    recognizer = null
  }

  private fun shutDown() {
    cancelRestart()
    disarmWatchdog()
    if (listening) recognizer?.cancel()
    listening = false
    queue.clear()
    for (session in sessions.values) session.pipe.release()
    sessions.clear()
    dropRecognizer()
    helper?.destroy()
    helper = null
    closeTranslators()
  }

  private fun emit(session: RecognitionSession, type: String, text: String? = null, code: Int? = null, fatal: Boolean? = null) {
    val event = mutableMapOf<String, Any>("session" to session.id, "type" to type)
    text?.let { event["text"] = it }
    code?.let { event["code"] = it }
    fatal?.let { event["fatal"] = it }
    // Never the words themselves: they stay on the phone, out of the logs.
    if (type != "partial") Log.d(TAG, "session ${session.id}: $type${code?.let { " $it" } ?: ""}${text?.let { " (${it.length} chars)" } ?: ""}")
    sendEvent("onRecognition", event)
  }

  private fun bestText(results: Bundle?): String? =
    results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim()?.takeIf { it.isNotEmpty() }

  // ---------------------------------------------------------------- translation (main thread)

  private fun translator(source: String, target: String): Translator {
    val from = TranslateLanguage.fromLanguageTag(source)
      ?: throw OnDeviceException("On-phone translation doesn't support \"$source\".")
    val to = TranslateLanguage.fromLanguageTag(target)
      ?: throw OnDeviceException("On-phone translation doesn't support \"$target\".")
    return translators.getOrPut("$from>$to") {
      Translation.getClient(TranslatorOptions.Builder().setSourceLanguage(from).setTargetLanguage(to).build())
    }
  }

  private fun closeTranslators() {
    for (translator in translators.values) translator.close()
    translators.clear()
  }
}

/** Errors of the helper recognizer surface through the calls that use it. */
private object QuietListener : RecognitionListener {
  override fun onReadyForSpeech(params: Bundle?) {}
  override fun onBeginningOfSpeech() {}
  override fun onRmsChanged(rmsdB: Float) {}
  override fun onBufferReceived(buffer: ByteArray?) {}
  override fun onEndOfSpeech() {}
  override fun onError(error: Int) {}
  override fun onResults(results: Bundle?) {}
  override fun onPartialResults(partialResults: Bundle?) {}
  override fun onEvent(eventType: Int, params: Bundle?) {}
}
