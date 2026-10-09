package expo.modules.earbridgeaudio

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import kotlin.math.PI
import kotlin.math.cos

/**
 * Tells when the phone was turned or moved to lie another way: the directions voices came
 * from until then no longer apply.
 */
class PoseWatcher(context: Context, private val onMove: () -> Unit) : SensorEventListener {
  private val sensors = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
  // Without the compass, which a metal table or the phone's own speaker can throw off.
  private val sensor = sensors.getDefaultSensor(Sensor.TYPE_GAME_ROTATION_VECTOR)
    ?: sensors.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
  private val rotation = FloatArray(9)
  private var settled: FloatArray? = null

  fun start() {
    settled = null
    sensor?.let { sensors.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL) }
  }

  fun stop() {
    sensors.unregisterListener(this)
  }

  override fun onSensorChanged(event: SensorEvent) {
    SensorManager.getRotationMatrixFromVector(rotation, event.values)
    val before = settled
    if (before == null) {
      settled = rotation.copyOf()
      return
    }
    // How far it turned since: the trace of one rotation times the other's inverse is 1 + 2·cos(angle).
    var trace = 0f
    for (i in rotation.indices) trace += before[i] * rotation[i]
    if ((trace - 1) / 2 < MOVED) {
      settled = rotation.copyOf()
      onMove()
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  private companion object {
    /** Turned by more than 25°: a nudge doesn't count. */
    val MOVED = cos(25 * PI / 180).toFloat()
  }
}
