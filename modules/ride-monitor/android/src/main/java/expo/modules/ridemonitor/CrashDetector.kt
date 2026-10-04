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
 * Only ARMED while GPS says the rider moved >= minSpeedMps in the last 30 s
 * and hasn't stopped since (below ~5 km/h for 4 s).
 * NOT HANDLING (no burst of jolts just before, nobody unlocked the phone) ->
 * IMPACT (|a| >= impactG) -> SETTLE (ignore tumble) -> STILLNESS (low
 * variance, low rotation) -> ORIENTATION change -> STOPPED (a GPS reading 3 s+
 * after the impact shows the rider no longer riding; none within ~2.5 s of the
 * stillness window: alert anyway). Motion resuming = "bump", not a crash.
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
  /** Start of the current run of slow GPS readings, or null while moving. */
  private var slowSince: Long? = null
  private var lastInteractionAt = Long.MIN_VALUE / 2
  private var lastIgnoredAt = Long.MIN_VALUE / 2
  /** A GPS reading came in late enough after the impact to judge it… */
  private var speedSeenAfterImpact = false
  /** …and it showed the rider still riding. */
  private var movedAfterImpact = false
  /** Looked like a crash; waiting for that GPS reading before alerting. Holds the orientation change. */
  private var pendingChange: Double? = null

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
    speedSeenAfterImpact = false
    movedAfterImpact = false
    pendingChange = null
  }

  /** Feed GPS speed (m/s) so the detector knows whether the rider is riding. */
  fun pushSpeed(t: Long, speedMps: Double?) {
    if (speedMps == null) return // no speed in this fix: tells us nothing
    if (inImpact && t >= impactAt + SPEED_CHECK_AFTER_MS) {
      speedSeenAfterImpact = true
      if (speedMps >= config.minSpeedMps) movedAfterImpact = true
    }
    if (speedMps >= config.minSpeedMps) lastMovingAt = t
    if (speedMps < STOP_SPEED_MPS) { if (slowSince == null) slowSince = t } else slowSince = null
  }

  /** The rider has come to a stop (slow GPS readings for a few seconds). */
  fun isStopped(t: Long) = slowSince?.let { t - it >= STOPPED_MS } ?: false

  fun isArmed(t: Long) = !config.requireMotion || (t - lastMovingAt <= MOTION_WINDOW_MS && !isStopped(t))

  /**
   * The rider unlocked or touched the phone: a spike around now is them handling it
   * (e.g. taking it out of a pocket), not a crash. Ends an impact being evaluated.
   */
  fun noteInteraction(t: Long): DetectorEvent? {
    lastInteractionAt = t
    return if (inImpact) finishAsBump("handling") else null
  }

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
        if (t - lastInteractionAt < INTERACTION_MS || countPeaks(t, c.handlingPeakG) >= c.handlingPeaks) {
          return ignore(t, g, "handling")
        }
        inImpact = true
        impactAt = t
        peakG = g
        preGravity = meanVec(history.filter { t - it.t > PRE_GUARD_MS })
        window.clear()
        gyroWindow.clear()
      }
      return null
    }

    // GPS says the rider is still riding along: a pothole or the phone shifting in a pocket.
    if (movedAfterImpact) return finishAsBump("moving_again")
    if (pendingChange != null) return confirmCrash(t)

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
      pendingChange = change
      return confirmCrash(t)
    }
    return finishAsBump("no_fall")
  }

  /**
   * It looked like a crash; alert once GPS confirms the rider stopped. No GPS reading
   * yet (weak signal, tunnel)? Wait briefly, then alert anyway: missing a crash is worse.
   */
  private fun confirmCrash(t: Long): DetectorEvent? {
    if (movedAfterImpact) return finishAsBump("moving_again")
    val stillEnd = impactAt + config.settleMs + config.stillMs
    if (config.requireMotion && !speedSeenAfterImpact && t < stillEnd + GPS_GRACE_MS) return null
    val event = DetectorEvent.Crash(impactAt, round1(peakG), (pendingChange ?: 90.0).toInt())
    backToIdle()
    return event
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
    /** Below this GPS speed (≈5 km/h) for [STOPPED_MS] the rider counts as stopped. */
    private const val STOP_SPEED_MPS = 1.5
    private const val STOPPED_MS = 4000L
    /** An impact this soon after the rider unlocked or touched the phone is them handling it. */
    private const val INTERACTION_MS = 2000L
    /** GPS readings from this long after an impact say whether the rider is still riding. */
    private const val SPEED_CHECK_AFTER_MS = 3000L
    /** How long past the stillness window to wait for that reading before alerting anyway. */
    private const val GPS_GRACE_MS = 2500L

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
