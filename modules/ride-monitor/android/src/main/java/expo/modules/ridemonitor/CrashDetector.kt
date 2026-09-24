package expo.modules.ridemonitor

import kotlin.math.abs
import kotlin.math.acos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/**
 * Kotlin port of src/lib/crash-detector.ts, so detection keeps running while the
 * app is in the background (behind Google Maps, screen off).
 * Keep the two in sync; scripts/simulate-detector.mts exercises the TS version.
 *
 * Only ARMED while GPS says the rider moved >= minSpeedMps in the last 30 s.
 * NOT HANDLING (no burst of jolts just before) -> IMPACT (|a| >= impactG) ->
 * SETTLE (ignore tumble) -> STILLNESS (low variance, low rotation) ->
 * ORIENTATION change. Motion resuming = "bump", not a crash.
 */
data class DetectorConfig(
  val impactG: Double,
  val settleMs: Long,
  val stillMs: Long,
  val stillStdG: Double,
  val stillGyro: Double,
  val orientationDeg: Double,
  val requireMotion: Boolean,
  val minSpeedMps: Double,
  val handlingPeakG: Double,
  val handlingPeaks: Int,
)

sealed class DetectorEvent {
  data class Crash(val impactAt: Long, val peakG: Double, val orientationChangeDeg: Int) : DetectorEvent()
  /** reason: moving_again | not_moving | handling | no_fall */
  data class Bump(val impactAt: Long, val peakG: Double, val reason: String) : DetectorEvent()
}

private data class Sample(val t: Long, val x: Double, val y: Double, val z: Double) {
  val g get() = sqrt(x * x + y * y + z * z)
}

class CrashDetector(var config: DetectorConfig) {
  private val history = ArrayDeque<Sample>()
  private var inImpact = false
  private var impactAt = 0L
  private var peakG = 0.0
  private var preGravity: DoubleArray? = null
  private val window = ArrayList<Sample>()
  private val gyroWindow = ArrayList<Double>()
  private var lastMovingAt = Long.MIN_VALUE / 2
  private var lastIgnoredAt = Long.MIN_VALUE / 2

  fun reset() {
    history.clear()
    backToIdle()
  }

  /** End an impact evaluation but keep the rolling history, so a burst of jolts stays visible. */
  private fun backToIdle() {
    inImpact = false
    window.clear()
    gyroWindow.clear()
    preGravity = null
    peakG = 0.0
  }

  /** Feed GPS speed (m/s) so the detector knows whether the rider is riding. */
  fun pushSpeed(t: Long, speedMps: Double?) {
    if (speedMps != null && speedMps >= config.minSpeedMps) lastMovingAt = t
  }

  fun isArmed(t: Long) = !config.requireMotion || t - lastMovingAt <= MOTION_WINDOW_MS

  fun pushGyro(t: Long, x: Double, y: Double, z: Double) {
    if (!inImpact) return
    if (t >= impactAt + config.settleMs) gyroWindow.add(sqrt(x * x + y * y + z * z))
  }

  fun pushAccel(t: Long, x: Double, y: Double, z: Double): DetectorEvent? {
    val s = Sample(t, x, y, z)
    val g = s.g
    val c = config

    history.addLast(s)
    while (history.isNotEmpty() && t - history.first().t > PRE_WINDOW_MS + PRE_GUARD_MS) history.removeFirst()

    if (!inImpact) {
      if (g >= c.impactG) {
        if (!isArmed(t)) return ignore(t, g, "not_moving")
        if (countPeaks(t, c.handlingPeakG) >= c.handlingPeaks) return ignore(t, g, "handling")
        inImpact = true
        impactAt = t
        peakG = g
        preGravity = meanVec(history.filter { t - it.t > PRE_GUARD_MS })
        window.clear()
        gyroWindow.clear()
      }
      return null
    }

    val stillStart = impactAt + c.settleMs
    val stillEnd = stillStart + c.stillMs
    if (t < stillStart) {
      peakG = max(peakG, g)
      return null
    }

    window.add(s)
    if (window.size >= 10) {
      val recent = window.takeLast(10).map { it.g }
      if (std(recent) > c.stillStdG * 4) return finishAsBump("moving_again")
    }
    if (t < stillEnd) return null

    val mags = window.map { it.g }
    val meanG = mags.average()
    val isStill = std(mags) <= c.stillStdG &&
      abs(meanG - 1) < 0.3 &&
      (gyroWindow.isEmpty() || gyroWindow.average() <= c.stillGyro)
    if (!isStill) return finishAsBump("moving_again")

    val post = meanVec(window)
    val pre = preGravity
    val change = if (pre != null && post != null) angleDeg(pre, post) else 90.0
    val veryHard = peakG >= c.impactG * 2
    if (change >= c.orientationDeg || veryHard) {
      val event = DetectorEvent.Crash(impactAt, round1(peakG), change.toInt())
      backToIdle()
      return event
    }
    return finishAsBump("no_fall")
  }

  private fun finishAsBump(reason: String): DetectorEvent {
    val event = DetectorEvent.Bump(impactAt, round1(peakG), reason)
    backToIdle()
    return event
  }

  /** A spike we deliberately don't treat as an impact; reported at most once a second. */
  private fun ignore(t: Long, g: Double, reason: String): DetectorEvent? {
    if (t - lastIgnoredAt < 1000) return null
    lastIgnoredAt = t
    return DetectorEvent.Bump(t, round1(g), reason)
  }

  /** Separate excursions above [threshold] in the pre-impact window, excluding the impact itself. */
  private fun countPeaks(now: Long, threshold: Double): Int {
    var peaks = 0
    var above = false
    for (h in history) {
      if (now - h.t < 50) break
      val isAbove = h.g >= threshold
      if (isAbove && !above) peaks++
      above = isAbove
    }
    return peaks
  }

  companion object {
    private const val PRE_WINDOW_MS = 2000L
    private const val PRE_GUARD_MS = 250L
    private const val MOTION_WINDOW_MS = 30_000L

    private fun meanVec(samples: List<Sample>): DoubleArray? {
      if (samples.isEmpty()) return null
      return doubleArrayOf(samples.sumOf { it.x } / samples.size, samples.sumOf { it.y } / samples.size, samples.sumOf { it.z } / samples.size)
    }

    private fun angleDeg(a: DoubleArray, b: DoubleArray): Double {
      val dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
      val denom = sqrt(a.sumOf { it * it }) * sqrt(b.sumOf { it * it })
      if (denom == 0.0) return 0.0
      return Math.toDegrees(acos(max(-1.0, min(1.0, dot / denom))))
    }

    private fun std(xs: List<Double>): Double {
      val m = xs.average()
      return sqrt(xs.sumOf { (it - m) * (it - m) } / xs.size)
    }

    private fun round1(n: Double) = Math.round(n * 10) / 10.0
  }
}
