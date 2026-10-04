package expo.modules.ridemonitor

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.telephony.SmsManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.UUID

data class RoutePoint(val lat: Double, val lng: Double, val t: Long, val speed: Double?, val accuracy: Float?)
data class HardBrake(val lat: Double, val lng: Double, val t: Long, val decel: Double)

data class RideConfig(
  val rideId: String,
  val detector: DetectorConfig,
  val countdownSeconds: Int,
  val contactPhones: List<String>,
  /** Alert text with {LINK} and {TIME} placeholders, rendered by the JS app. */
  val alertTemplate: String,
  val autoSms: Boolean,
  /** Shown to bystanders on the lock screen after no response. */
  val riderName: String,
  val medicalSummary: String,
  /** Same order as [contactPhones]. */
  val contactNames: List<String>,
  /** Phone the contacts (speakerphone) after the alert SMS. */
  val autoCall: Boolean,
  /** Loud siren + bystander screen after no response. */
  val siren: Boolean,
  val emergencyNumber: String,
  /** Text updated locations every few minutes after the alert. */
  val followUps: Boolean,
)

data class CrashState(
  val id: String,
  val startedAt: Long,
  val deadline: Long,
  val peakG: Double?,
  val lat: Double?,
  val lng: Double?,
  val via: String,
  /** countdown | fine | help | alerted */
  var status: String = "countdown",
  var smsSent: Int = 0,
  var smsError: String? = null,
) {
  /** Simulated (demo) crash: nothing is sent and nobody is called. */
  val isTest get() = via == "simulated"
}

/**
 * Process-wide state shared by the service, the Expo module, the lock-screen
 * activity and the notification action receiver.
 */
object RideMonitor {
  @Volatile var service: RideMonitorService? = null
  @Volatile var appInForeground = false
  var emitter: ((String, Map<String, Any?>) -> Unit)? = null

  fun emit(name: String, payload: Map<String, Any?>) {
    Handler(Looper.getMainLooper()).post { emitter?.invoke(name, payload) }
  }

  val crash: CrashState? get() = service?.crash
}

/**
 * Foreground service for an active ride. Keeps GPS logging and crash detection
 * running while the rider uses Google Maps or the screen is off.
 */
class RideMonitorService : Service(), SensorEventListener, LocationListener {
  companion object {
    const val ACTION_START = "expo.modules.ridemonitor.START"
    const val ACTION_STOP = "expo.modules.ridemonitor.STOP"
    /**
     * Default importance (but silent): Android hides "silent" low-importance
     * notifications on the lock screen, and this one is the lock-screen ride info.
     */
    private const val RIDE_CHANNEL = "ride_live_v2"
    private const val OLD_RIDE_CHANNEL = "ride_active"
    private const val NOTIFICATION_REFRESH_MS = 5_000L
    private const val CRASH_CHANNEL = "crash_alert_v1"
    private const val RIDE_NOTIFICATION_ID = 4101
    const val CRASH_NOTIFICATION_ID = 4102
    private const val ALERTED_NOTIFICATION_ID = 4103
    private const val HARD_BRAKE_MPS2 = 3.5
    private const val HARD_BRAKE_MIN_SPEED = 5.0
    private const val MAX_GOOD_ACCURACY_M = 30f
    /** Slower than this (≈2 km/h) and within [STATIONARY_JITTER_M] of the last point: standing still. */
    private const val STATIONARY_SPEED_MPS = 0.5
    private const val STATIONARY_JITTER_M = 15f
    private val ACCENT = android.graphics.Color.parseColor("#FF6B00")

    @Volatile var pendingConfig: RideConfig? = null
  }

  private val main = Handler(Looper.getMainLooper())
  private lateinit var sensorManager: SensorManager
  private lateinit var locationManager: LocationManager
  private var wakeLock: PowerManager.WakeLock? = null
  private lateinit var detector: CrashDetector

  lateinit var config: RideConfig
  var startTime = 0L
  val points = ArrayList<RoutePoint>()
  val hardBrakes = ArrayList<HardBrake>()
  var distanceM = 0.0
  var maxSpeed = 0.0
  var currentSpeed = 0.0
  var gpsAccuracy: Float? = null
  var liveG = 1.0
  var lastBump: Pair<Long, Double>? = null
  var lastBumpReason: String? = null
  var detectionSuspended = false
  /** No accelerometer on this phone: the route is logged but crashes can't be detected. */
  var noSensors = false
  var crash: CrashState? = null
  /** Active after an unanswered crash: SMS/retries, follow-ups, calls, siren. */
  var responder: EmergencyResponder? = null
    private set

  private var lastUpdateEmit = 0L
  /** Latest fix with a speed, kept even when not added to the route (hard-brake maths needs it). */
  private var lastSpeedFix: RoutePoint? = null
  private var lastGpsFixAt = 0L
  private var unlockReceiverRegistered = false
  /** Unlocking the phone = the rider is handling it (e.g. just took it out of a pocket). */
  private val unlockReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
      if (intent.action == Intent.ACTION_USER_PRESENT) noteInteraction()
    }
  }
  private var lastNotificationUpdate = 0L
  private var lastGEmit = 0L
  private val countdownRunnable = Runnable { onCountdownExpired() }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == ACTION_STOP) {
      stopSelf()
      return START_NOT_STICKY
    }
    val cfg = pendingConfig ?: run {
      stopSelf()
      return START_NOT_STICKY
    }
    if (RideMonitor.service === this && ::config.isInitialized) return START_STICKY

    config = cfg
    startTime = System.currentTimeMillis()
    createChannels()
    ServiceCompat.startForeground(
      this,
      RIDE_NOTIFICATION_ID,
      rideNotification(),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0,
    )
    RideMonitor.service = this
    detector = CrashDetector(cfg.detector)

    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RidersBlackBox:ride").apply {
      setReferenceCounted(false)
      acquire(12 * 60 * 60 * 1000L)
    }

    sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
    val accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    noSensors = accel == null
    accel?.let { sensorManager.registerListener(this, it, 20_000, main) }
    sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let {
      sensorManager.registerListener(this, it, 20_000, main)
    }

    locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    startLocation()
    if (!unlockReceiverRegistered) {
      ContextCompat.registerReceiver(this, unlockReceiver, IntentFilter(Intent.ACTION_USER_PRESENT), ContextCompat.RECEIVER_EXPORTED)
      unlockReceiverRegistered = true
    }
    RideMonitor.emit("onRideUpdate", snapshot())
    return START_STICKY
  }

  @SuppressLint("MissingPermission")
  private fun startLocation() {
    if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) return
    for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
      if (locationManager.allProviders.contains(provider)) {
        // No minimum distance: fixes keep coming while stopped, so the detector knows the rider stopped.
        locationManager.requestLocationUpdates(provider, 2000L, 0f, this, Looper.getMainLooper())
      }
    }
  }

  override fun onDestroy() {
    runCatching { sensorManager.unregisterListener(this) }
    if (unlockReceiverRegistered) runCatching { unregisterReceiver(unlockReceiver) }
    unlockReceiverRegistered = false
    runCatching { locationManager.removeUpdates(this) }
    main.removeCallbacks(countdownRunnable)
    stopAlarm()
    responder?.stop()
    wakeLock?.let { if (it.isHeld) it.release() }
    if (RideMonitor.service === this) RideMonitor.service = null
    super.onDestroy()
  }

  // ---- Sensors -------------------------------------------------------------

  override fun onSensorChanged(event: SensorEvent) {
    val t = System.currentTimeMillis()
    when (event.sensor.type) {
      Sensor.TYPE_ACCELEROMETER -> {
        val x = event.values[0] / SensorManager.GRAVITY_EARTH.toDouble()
        val y = event.values[1] / SensorManager.GRAVITY_EARTH.toDouble()
        val z = event.values[2] / SensorManager.GRAVITY_EARTH.toDouble()
        liveG = Math.sqrt(x * x + y * y + z * z)
        if (t - lastGEmit > 500 && RideMonitor.appInForeground) {
          lastGEmit = t
          RideMonitor.emit("onLiveG", mapOf("g" to liveG, "armed" to detector.isArmed(t)))
        }
        if (detectionSuspended) return
        handleDetectorEvent(detector.pushAccel(t, x, y, z))
      }
      Sensor.TYPE_GYROSCOPE -> if (!detectionSuspended) {
        detector.pushGyro(t, event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble())
      }
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  private fun handleDetectorEvent(e: DetectorEvent?) {
    when (e) {
      is DetectorEvent.Crash -> triggerCrash(e.peakG, "sensor")
      is DetectorEvent.Bump -> {
        lastBump = e.impactAt to e.peakG
        lastBumpReason = e.reason
        RideMonitor.emit("onBump", mapOf("at" to e.impactAt.toDouble(), "peakG" to e.peakG, "reason" to e.reason))
        refreshRideNotification(force = true)
      }
      null -> {}
    }
  }

  /** The rider unlocked or touched the phone: a jolt around now is handling, not a crash. */
  fun noteInteraction() {
    if (!::detector.isInitialized || detectionSuspended) return
    handleDetectorEvent(detector.noteInteraction(System.currentTimeMillis()))
  }

  // ---- Location ------------------------------------------------------------

  override fun onLocationChanged(loc: Location) {
    // Prefer GPS; ignore coarse network fixes once GPS is flowing.
    if (loc.provider == LocationManager.NETWORK_PROVIDER && (gpsAccuracy ?: Float.MAX_VALUE) < 50f &&
      loc.time - lastGpsFixAt < 10_000
    ) return
    if (loc.provider == LocationManager.GPS_PROVIDER) lastGpsFixAt = loc.time

    val speed = if (loc.hasSpeed()) loc.speed.toDouble() else null
    if (::detector.isInitialized) detector.pushSpeed(System.currentTimeMillis(), speed)
    val p = RoutePoint(loc.latitude, loc.longitude, loc.time, speed, if (loc.hasAccuracy()) loc.accuracy else null)
    val prev = points.lastOrNull()
    val step = FloatArray(1)
    if (prev != null) Location.distanceBetween(prev.lat, prev.lng, p.lat, p.lng, step)

    // Hard braking compares consecutive speed readings, including the one that says we've stopped.
    val prevFix = lastSpeedFix
    if (prevFix?.speed != null && speed != null) {
      val dt = (p.t - prevFix.t) / 1000.0
      val decel = if (dt > 0) (prevFix.speed - speed) / dt else 0.0
      val last = hardBrakes.lastOrNull()
      if (decel >= HARD_BRAKE_MPS2 && prevFix.speed >= HARD_BRAKE_MIN_SPEED && (last == null || p.t - last.t > 5000)) {
        hardBrakes.add(HardBrake(p.lat, p.lng, p.t, Math.round(decel * 10) / 10.0))
      }
    }
    if (speed != null) lastSpeedFix = p

    // Standing still: GPS jitter would otherwise add distance and scribble on the route.
    val stationary = prev != null && speed != null && speed < STATIONARY_SPEED_MPS && step[0] < STATIONARY_JITTER_M
    if (!stationary) {
      if (prev != null && (p.accuracy ?: 0f) <= MAX_GOOD_ACCURACY_M) distanceM += step[0]
      points.add(p)
    }
    currentSpeed = speed ?: 0.0
    maxSpeed = maxOf(maxSpeed, currentSpeed)
    gpsAccuracy = p.accuracy

    val now = System.currentTimeMillis()
    if (now - lastUpdateEmit > 900) {
      lastUpdateEmit = now
      RideMonitor.emit("onRideUpdate", snapshot())
    }
    refreshRideNotification()
  }

  /** Keep the lock-screen ride info current, at most every few seconds (or now, with [force]). */
  fun refreshRideNotification(force: Boolean = false) {
    val now = System.currentTimeMillis()
    if (!force && now - lastNotificationUpdate < NOTIFICATION_REFRESH_MS) return
    lastNotificationUpdate = now
    notifySafely(RIDE_NOTIFICATION_ID, rideNotification())
  }

  @Deprecated("Deprecated in Java")
  override fun onStatusChanged(provider: String?, status: Int, extras: android.os.Bundle?) {}
  override fun onProviderEnabled(provider: String) {}
  override fun onProviderDisabled(provider: String) {}

  fun snapshot(): Map<String, Any?> {
    val last = points.lastOrNull()
    return mapOf(
      "rideId" to config.rideId,
      "startTime" to startTime.toDouble(),
      "distanceM" to distanceM,
      "currentSpeed" to currentSpeed,
      "maxSpeed" to maxSpeed,
      "gpsAccuracy" to gpsAccuracy?.toDouble(),
      "liveG" to liveG,
      "armed" to detector.isArmed(System.currentTimeMillis()),
      "suspended" to detectionSuspended,
      "noSensors" to noSensors,
      "pointCount" to points.size,
      "lastPoint" to last?.let { pointMap(it) },
      "hardBrakes" to hardBrakes.map { mapOf("lat" to it.lat, "lng" to it.lng, "t" to it.t.toDouble(), "decel" to it.decel) },
      "lastBump" to lastBump?.let { mapOf("at" to it.first.toDouble(), "peakG" to it.second, "reason" to lastBumpReason) },
      "crash" to crash?.let { crashMap(it) },
    )
  }

  fun routeMaps(): List<Map<String, Any?>> = points.map { pointMap(it) }

  private fun pointMap(p: RoutePoint) =
    mapOf("lat" to p.lat, "lng" to p.lng, "t" to p.t.toDouble(), "speed" to p.speed)

  fun crashMap(c: CrashState) = mapOf(
    "id" to c.id,
    "startedAt" to c.startedAt.toDouble(),
    "deadline" to c.deadline.toDouble(),
    "peakG" to c.peakG,
    "lat" to c.lat,
    "lng" to c.lng,
    "via" to c.via,
    "status" to c.status,
    "smsSent" to c.smsSent,
    "smsError" to c.smsError,
  )

  // ---- Crash flow ----------------------------------------------------------

  fun triggerCrash(peakG: Double?, via: String) {
    if (crash?.status == "countdown") return
    detectionSuspended = true
    detector.reset()
    val now = System.currentTimeMillis()
    val last = points.lastOrNull()
    val c = CrashState(
      id = UUID.randomUUID().toString().take(12),
      startedAt = now,
      deadline = now + config.countdownSeconds * 1000L,
      peakG = peakG,
      lat = last?.lat,
      lng = last?.lng,
      via = via,
    )
    crash = c
    main.removeCallbacks(countdownRunnable)
    main.postDelayed(countdownRunnable, config.countdownSeconds * 1000L)
    startAlarm()
    postCrashNotification(c)
    RideMonitor.emit("onCrash", crashMap(c))
    refreshRideNotification(force = true)
  }

  fun resolveCrash(outcome: String) {
    val c = crash ?: return
    if (c.status != "countdown") return
    c.status = outcome
    main.removeCallbacks(countdownRunnable)
    stopAlarm()
    notificationManager().cancel(CRASH_NOTIFICATION_ID)
    if (outcome == "fine") resumeDetection()
    RideMonitor.emit("onCrashResolved", crashMap(c))
    refreshRideNotification(force = true)
  }

  fun resumeDetection() {
    // Never re-arm under a live "Are you OK?" countdown.
    if (crash?.status == "countdown") return
    detector.reset()
    detectionSuspended = false
    refreshRideNotification(force = true)
  }

  /**
   * Contacts, profile or alert settings changed mid-ride. The detector and the
   * countdown length stay as they were at ride start; an emergency already in
   * progress keeps the config it started with.
   */
  fun updateConfig(cfg: RideConfig) {
    // The service reads config on the main thread; swap it there too.
    main.post {
      config = cfg.copy(rideId = config.rideId, detector = config.detector, countdownSeconds = config.countdownSeconds)
      pendingConfig = config
    }
  }

  private fun onCountdownExpired() {
    val c = crash ?: return
    if (c.status != "countdown") return
    stopAlarm()
    c.status = "alerted"
    if (config.autoSms) {
      val r = EmergencyResponder(this, config, main) { points.lastOrNull()?.let { it.lat to it.lng } }
      responder = r
      val (sent, error) = r.begin(c)
      c.smsSent = sent
      c.smsError = error
    }
    showBystanderScreen(c)
    RideMonitor.emit("onCrashResolved", crashMap(c))
    refreshRideNotification(force = true)
  }

  /** Rider (or JS "help has arrived") ended the emergency: stop siren, calls, texts. */
  fun stopEmergency() {
    responder?.stop()
    responder = null
    notificationManager().cancel(CRASH_NOTIFICATION_ID)
    notificationManager().cancel(ALERTED_NOTIFICATION_ID)
  }

  fun emergencyMap(): Map<String, Any?> {
    val r = responder
    return mapOf(
      "active" to (r?.active == true),
      "sirenOn" to (r?.sirenOn == true),
      "callingName" to r?.callingName,
      "callsFinished" to (r?.callsFinished == true),
      "pendingRetries" to (r?.pendingRetries ?: 0),
    )
  }

  /**
   * After no response the lock-screen activity switches to the bystander view
   * (who the rider is, medical info, call buttons). Launch it directly if our
   * app is on screen, otherwise via a full-screen notification.
   */
  private fun showBystanderScreen(c: CrashState) {
    postAlertedNotification(c)
    if (RideMonitor.appInForeground) {
      runCatching {
        startActivity(
          Intent(this, CrashAlertActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
      }
    }
  }

  // ---- Alarm + notifications ----------------------------------------------

  private fun vibrator(): Vibrator =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
    } else {
      @Suppress("DEPRECATION")
      getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    }

  private fun startAlarm() {
    val pattern = longArrayOf(0, 700, 400)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      vibrator().vibrate(VibrationEffect.createWaveform(pattern, 0))
    } else {
      @Suppress("DEPRECATION")
      vibrator().vibrate(pattern, 0)
    }
  }

  private fun stopAlarm() {
    runCatching { vibrator().cancel() }
  }

  private fun notificationManager() = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = notificationManager()
    runCatching { nm.deleteNotificationChannel(OLD_RIDE_CHANNEL) }
    nm.createNotificationChannel(
      NotificationChannel(RIDE_CHANNEL, "Ride dash", NotificationManager.IMPORTANCE_DEFAULT).apply {
        description = "Live speed, distance and crash-detection status on the lock screen during a ride"
        setShowBadge(false)
        setSound(null, null)
        enableVibration(false)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      },
    )
    nm.createNotificationChannel(
      NotificationChannel(CRASH_CHANNEL, "Crash alerts", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "The \"Are you OK?\" alert after a detected crash"
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 700, 400, 700)
        lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        setSound(
          RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
          AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build(),
        )
      },
    )
  }

  private fun immutable(flags: Int) = flags or PendingIntent.FLAG_IMMUTABLE


  /** Opens a screen of the app through its deep link (ridersblackbox://<path>). */
  private fun deepLinkIntent(path: String, requestCode: Int): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("ridersblackbox://$path"))
      .setPackage(packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, requestCode, intent, immutable(PendingIntent.FLAG_UPDATE_CURRENT))
  }

  /**
   * The lock-screen ride dash in notification form: speed, detection status,
   * distance / time / top speed, and one line about crashes. Public, so it's
   * readable without unlocking (no medical info or contacts in it).
   */
  private fun rideNotification(): Notification {
    val kmh = Math.round(currentSpeed * 3.6)
    val status = when {
      !::detector.isInitialized -> "Starting"
      noSensors -> "No motion sensor: crashes can't be detected"
      detectionSuspended -> "Crash detection paused"
      detector.isArmed(System.currentTimeMillis()) -> "Crash detection armed"
      else -> "Standby: arms once you're moving"
    }
    // Ride time ticks by itself in the header (chronometer), so it stays right between GPS fixes.
    val stats = "%s · top %d km/h".format(
      Locale.US,
      if (distanceM < 1000) "${Math.round(distanceM)} m" else "%.1f km".format(Locale.US, distanceM / 1000),
      Math.round(maxSpeed * 3.6),
    )
    val crashLine = crashSummary()
    return NotificationCompat.Builder(this, RIDE_CHANNEL)
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setContentTitle("$kmh km/h · $status")
      .setContentText(stats)
      .setStyle(NotificationCompat.BigTextStyle().bigText("$stats\n$crashLine"))
      .setSubText("Ride dash")
      .setColor(ACCENT)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setSilent(true)
      .setShowWhen(true)
      .setWhen(startTime)
      .setUsesChronometer(true)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(deepLinkIntent("ride-dash", 5))
      .addAction(0, "I NEED HELP", deepLinkIntent("checkin", 6))
      .addAction(0, "OPEN DASH", deepLinkIntent("ride-dash", 7))
      .build()
  }

  /** One short line about crashes this ride, for the lock-screen notification and dash. */
  private fun crashSummary(): String {
    val fmt = SimpleDateFormat("h:mm a", Locale.getDefault())
    crash?.let { c ->
      val at = fmt.format(Date(c.startedAt))
      val test = if (c.isTest) " (test)" else ""
      return when (c.status) {
        "countdown" -> "⚠ Possible crash at $at$test: answer \"Are you OK?\""
        "fine" -> "Crash check at $at$test: you said you're OK"
        "help" -> "Crash at $at$test: you asked for help"
        else ->
          if (c.smsSent > 0) "⚠ Crash at $at$test: ${c.smsSent} contact${if (c.smsSent > 1) "s" else ""} texted"
          else "⚠ Crash at $at$test: no response"
      }
    }
    lastBump?.let { (at, g) ->
      if (System.currentTimeMillis() - at < 10 * 60_000L) {
        val why = when (lastBumpReason) {
          "moving_again" -> "you kept moving"
          "not_moving" -> "not riding"
          "handling" -> "phone handled"
          else -> "no fall"
        }
        return "Jolt %.1f g at %s, no alert (%s)".format(Locale.US, g, fmt.format(Date(at)), why)
      }
    }
    return "No crashes detected this ride"
  }

  /** The app went to the background mid-countdown: now the rider needs the notification / lock-screen alert. */
  fun onAppBackgrounded() {
    crash?.takeIf { it.status == "countdown" }?.let { postCrashNotification(it) }
  }

  private fun postCrashNotification(c: CrashState) {
    // While our own app is on screen, its "Are you OK?" screen is the alert; no heads-up on top of it.
    if (RideMonitor.appInForeground) return
    val alertActivity = Intent(this, CrashAlertActivity::class.java).apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    }
    val alertPending = PendingIntent.getActivity(this, 2, alertActivity, immutable(PendingIntent.FLAG_UPDATE_CURRENT))
    val finePending = PendingIntent.getBroadcast(
      this, 3,
      Intent(this, CrashActionReceiver::class.java).setAction(CrashActionReceiver.ACTION_FINE),
      immutable(PendingIntent.FLAG_UPDATE_CURRENT),
    )

    val builder = NotificationCompat.Builder(this, CRASH_CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle(if (c.isTest) "TEST: Are you OK? (simulated crash)" else "Are you OK? Possible crash detected")
      .setContentText(
        if (c.isTest) "Test: nothing is sent if you don't respond. No SMS, no calls."
        else "Contacts will be alerted with your location unless you respond.",
      )
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setUsesChronometer(true)
      .setChronometerCountDown(true)
      .setWhen(c.deadline)
      .setShowWhen(true)
      .setTimeoutAfter(config.countdownSeconds * 1000L + 2000)
      .setContentIntent(alertPending)
      .addAction(0, "I'M FINE", finePending)
      .addAction(0, "I NEED HELP", alertPending)
    // Full-screen over the lock screen; heads-up over Google Maps.
    builder.setFullScreenIntent(alertPending, true)
    val n = builder.build().apply { flags = flags or Notification.FLAG_INSISTENT }
    notifySafely(CRASH_NOTIFICATION_ID, n)
  }

  private fun postAlertedNotification(c: CrashState) {
    val calling = config.autoCall && !c.isTest
    val text = when {
      c.isTest -> "Test countdown ended. In a real crash your emergency contacts would now be texted and called. Tap for the bystander screen."
      c.smsSent > 0 -> "Location texted to ${c.smsSent} emergency contact${if (c.smsSent > 1) "s" else ""}${if (calling) "; calling them now" else ""}. Tap for rider info."
      c.smsError != null -> "Couldn't text contacts: ${c.smsError}. Tap for rider info."
      else -> "Tap for rider info."
    }
    val bystander = PendingIntent.getActivity(
      this, 4,
      Intent(this, CrashAlertActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
      immutable(PendingIntent.FLAG_UPDATE_CURRENT),
    )
    val n = NotificationCompat.Builder(this, CRASH_CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle(if (c.isTest) "TEST: no response (nothing sent)" else "Rider may be injured: emergency alert sent")
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setSilent(true)
      .setOngoing(!c.isTest)
      .setContentIntent(bystander)
      .setFullScreenIntent(bystander, true)
      .build()
    // Cancel (not replace) the countdown notification: its insistent alarm sound
    // otherwise keeps looping in System UI.
    notificationManager().cancel(CRASH_NOTIFICATION_ID)
    notifySafely(ALERTED_NOTIFICATION_ID, n)
  }

  private fun notifySafely(id: Int, n: Notification) {
    if (Build.VERSION.SDK_INT >= 33 && !hasPermission(Manifest.permission.POST_NOTIFICATIONS)) return
    notificationManager().notify(id, n)
  }

  private fun hasPermission(p: String) =
    ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED
}

object SmsSender {
  /** Sends [body] to each number from the phone's SIM. Returns (sentCount, error). */
  fun send(context: Context, phones: List<String>, body: String): Pair<Int, String?> {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.SEND_SMS) != PackageManager.PERMISSION_GRANTED) {
      return 0 to "SMS permission not granted"
    }
    val sms: SmsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(SmsManager::class.java)
    } else {
      @Suppress("DEPRECATION")
      SmsManager.getDefault()
    }
    var sent = 0
    var error: String? = null
    for (phone in phones.map { it.trim() }.filter { it.isNotEmpty() }) {
      try {
        val parts = sms.divideMessage(body)
        sms.sendMultipartTextMessage(phone, null, parts, null, null)
        sent++
      } catch (e: Exception) {
        error = e.message ?: e.javaClass.simpleName
      }
    }
    return sent to error
  }
}
