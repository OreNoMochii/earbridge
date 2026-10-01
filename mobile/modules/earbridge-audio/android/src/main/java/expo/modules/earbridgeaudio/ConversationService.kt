package expo.modules.earbridgeaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Keeps a conversation going while the phone is locked or another app is open, with a
 * notification to mute or end it. The earphones' play/pause button mutes and unmutes too:
 * "playing" means listening.
 */
class ConversationService : Service() {
  companion object {
    private const val TAG = "EarBridge"
    private const val CHANNEL_ID = "earbridge.conversation"
    private const val NOTIFICATION_ID = 7342
    private const val ACTION_MUTE = "expo.modules.earbridgeaudio.MUTE"
    private const val ACTION_UNMUTE = "expo.modules.earbridgeaudio.UNMUTE"
    private const val ACTION_END = "expo.modules.earbridgeaudio.END"
    const val EXTRA_TITLE = "title"
    const val EXTRA_TEXT = "text"
    const val EXTRA_MUTED = "muted"

    /** Set by the module; receives "mute", "unmute" or "end". */
    @Volatile var onCommand: ((String) -> Unit)? = null

    /** The running service, so the module can update its notification without starting it again. */
    @Volatile var running: ConversationService? = null
  }

  private var session: MediaSession? = null

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      when (intent.action) {
        ACTION_MUTE -> onCommand?.invoke("mute")
        ACTION_UNMUTE -> onCommand?.invoke("unmute")
        ACTION_END -> onCommand?.invoke("end")
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    val filter = IntentFilter().apply {
      addAction(ACTION_MUTE)
      addAction(ACTION_UNMUTE)
      addAction(ACTION_END)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      registerReceiver(receiver, filter)
    }
    session = MediaSession(this, "EarBridge").apply {
      setCallback(object : MediaSession.Callback() {
        override fun onPlay() {
          onCommand?.invoke("unmute")
        }

        override fun onPause() {
          onCommand?.invoke("mute")
        }
      })
      isActive = true
    }
    running = this
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val title = intent?.getStringExtra(EXTRA_TITLE) ?: "EarBridge"
    val text = intent?.getStringExtra(EXTRA_TEXT) ?: ""
    val muted = intent?.getBooleanExtra(EXTRA_MUTED, false) ?: false
    try {
      val notification = build(title, text, muted)
      when {
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.R -> startForeground(
          NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK,
        )
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q ->
          startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        else -> startForeground(NOTIFICATION_ID, notification)
      }
      setPlaybackState(muted)
    } catch (error: Exception) {
      // Android refuses when the app is not in the foreground or may not record. The
      // conversation still works while the app is open.
      Log.w(TAG, "Could not keep the conversation running in the background", error)
      stopSelf()
    }
    return START_NOT_STICKY
  }

  /** Shows a new title, text or mute state. */
  fun update(title: String, text: String, muted: Boolean) {
    getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, build(title, text, muted))
    setPlaybackState(muted)
  }

  override fun onDestroy() {
    running = null
    unregisterReceiver(receiver)
    session?.release()
    session = null
    super.onDestroy()
  }

  private fun setPlaybackState(muted: Boolean) {
    session?.setPlaybackState(
      PlaybackState.Builder()
        .setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE)
        .setState(
          if (muted) PlaybackState.STATE_PAUSED else PlaybackState.STATE_PLAYING,
          PlaybackState.PLAYBACK_POSITION_UNKNOWN,
          1f,
        )
        .build(),
    )
  }

  private fun build(title: String, text: String, muted: Boolean): Notification {
    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val manager = getSystemService(NotificationManager::class.java)
      if (manager.getNotificationChannel(CHANNEL_ID) == null) {
        manager.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Conversation", NotificationManager.IMPORTANCE_LOW).apply {
            description = "Shown while EarBridge is translating"
            setShowBadge(false)
          },
        )
      }
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this).setPriority(Notification.PRIORITY_LOW)
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
      builder.setContentIntent(
        PendingIntent.getActivity(this, 0, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
      )
    }
    val icon = Icon.createWithResource(this, R.drawable.earbridge_notification)
    return builder
      .setSmallIcon(icon)
      .setContentTitle(title)
      .setContentText(if (muted) "Muted · $text" else text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setShowWhen(false)
      .setCategory(Notification.CATEGORY_SERVICE)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .addAction(
        if (muted) action(icon, "Unmute", ACTION_UNMUTE, 1) else action(icon, "Mute", ACTION_MUTE, 1),
      )
      .addAction(action(icon, "End", ACTION_END, 2))
      .build()
  }

  private fun action(icon: Icon, title: String, action: String, requestCode: Int): Notification.Action {
    val intent = PendingIntent.getBroadcast(
      this,
      requestCode,
      Intent(action).setPackage(packageName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return Notification.Action.Builder(icon, title, intent).build()
  }
}
