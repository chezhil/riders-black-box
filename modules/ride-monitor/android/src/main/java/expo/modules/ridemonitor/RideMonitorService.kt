package expo.modules.ridemonitor

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
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
    private const val RIDE_CHANNEL = "ride_active"
    private const val CRASH_CHANNEL = "crash_alert_v1"
    private const val RIDE_NOTIFICATION_ID = 4101
    const val CRASH_NOTIFICATION_ID = 4102
    private const val HARD_BRAKE_MPS2 = 3.5
    private const val HARD_BRAKE_MIN_SPEED = 5.0
    private const val MAX_GOOD_ACCURACY_M = 30f

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
  var crash: CrashState? = null

  private var lastUpdateEmit = 0L
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
    createChannels()
    ServiceCompat.startForeground(
      this,
      RIDE_NOTIFICATION_ID,
      rideNotification(),
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION else 0,
    )
    RideMonitor.service = this
    startTime = System.currentTimeMillis()
    detector = CrashDetector(cfg.detector)

    val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "RidersBlackBox:ride").apply {
      setReferenceCounted(false)
      acquire(12 * 60 * 60 * 1000L)
    }

    sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
    sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)?.let {
      sensorManager.registerListener(this, it, 20_000, main)
    }
    sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)?.let {
      sensorManager.registerListener(this, it, 20_000, main)
    }

    locationManager = getSystemService(Context.LOCATION_SERVICE) as LocationManager
    startLocation()
    RideMonitor.emit("onRideUpdate", snapshot())
    return START_STICKY
  }

  @SuppressLint("MissingPermission")
  private fun startLocation() {
    if (!hasPermission(Manifest.permission.ACCESS_FINE_LOCATION)) return
    for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)) {
      if (locationManager.allProviders.contains(provider)) {
        locationManager.requestLocationUpdates(provider, 2000L, 5f, this, Looper.getMainLooper())
      }
    }
  }

  override fun onDestroy() {
    runCatching { sensorManager.unregisterListener(this) }
    runCatching { locationManager.removeUpdates(this) }
    main.removeCallbacks(countdownRunnable)
    stopAlarm()
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
        when (val e = detector.pushAccel(t, x, y, z)) {
          is DetectorEvent.Crash -> triggerCrash(e.peakG, "sensor")
          is DetectorEvent.Bump -> {
            lastBump = e.impactAt to e.peakG
            lastBumpReason = e.reason
            RideMonitor.emit("onBump", mapOf("at" to e.impactAt.toDouble(), "peakG" to e.peakG, "reason" to e.reason))
          }
          null -> {}
        }
      }
      Sensor.TYPE_GYROSCOPE -> if (!detectionSuspended) {
        detector.pushGyro(t, event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble())
      }
    }
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

  // ---- Location ------------------------------------------------------------

  override fun onLocationChanged(loc: Location) {
    // Prefer GPS; ignore coarse network fixes once GPS is flowing.
    if (loc.provider == LocationManager.NETWORK_PROVIDER && (gpsAccuracy ?: Float.MAX_VALUE) < 50f &&
      points.isNotEmpty() && loc.time - points.last().t < 10_000
    ) return

    val speed = if (loc.hasSpeed()) loc.speed.toDouble() else null
    if (::detector.isInitialized) detector.pushSpeed(System.currentTimeMillis(), speed)
    val p = RoutePoint(loc.latitude, loc.longitude, loc.time, speed, if (loc.hasAccuracy()) loc.accuracy else null)
    val prev = points.lastOrNull()
    if (prev != null && (p.accuracy ?: 0f) <= MAX_GOOD_ACCURACY_M) {
      val out = FloatArray(1)
      Location.distanceBetween(prev.lat, prev.lng, p.lat, p.lng, out)
      distanceM += out[0]
    }
    if (prev?.speed != null && speed != null) {
      val dt = (p.t - prev.t) / 1000.0
      val decel = if (dt > 0) (prev.speed - speed) / dt else 0.0
      val last = hardBrakes.lastOrNull()
      if (decel >= HARD_BRAKE_MPS2 && prev.speed >= HARD_BRAKE_MIN_SPEED && (last == null || p.t - last.t > 5000)) {
        hardBrakes.add(HardBrake(p.lat, p.lng, p.t, Math.round(decel * 10) / 10.0))
      }
    }
    points.add(p)
    currentSpeed = speed ?: 0.0
    maxSpeed = maxOf(maxSpeed, currentSpeed)
    gpsAccuracy = p.accuracy

    val now = System.currentTimeMillis()
    if (now - lastUpdateEmit > 900) {
      lastUpdateEmit = now
      RideMonitor.emit("onRideUpdate", snapshot())
    }
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
  }

  fun resumeDetection() {
    detector.reset()
    detectionSuspended = false
  }

  private fun onCountdownExpired() {
    val c = crash ?: return
    if (c.status != "countdown") return
    stopAlarm()
    c.status = "alerted"
    if (config.autoSms && !c.isTest) sendAlertSms(c)
    postAlertedNotification(c)
    RideMonitor.emit("onCrashResolved", crashMap(c))
  }

  private fun sendAlertSms(c: CrashState) {
    if (config.contactPhones.isEmpty()) {
      c.smsError = "No emergency contacts"
      return
    }
    if (!hasPermission(Manifest.permission.SEND_SMS)) {
      c.smsError = "SMS permission not granted"
      return
    }
    val lat = c.lat ?: points.lastOrNull()?.lat
    val lng = c.lng ?: points.lastOrNull()?.lng
    val link = if (lat != null && lng != null) {
      "https://www.google.com/maps/search/?api=1&query=%.6f,%.6f".format(Locale.US, lat, lng)
    } else {
      "(location unavailable)"
    }
    val time = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(c.startedAt))
    val body = config.alertTemplate.replace("{LINK}", link).replace("{TIME}", time)
    val result = SmsSender.send(this, config.contactPhones, body)
    c.smsSent = result.first
    c.smsError = result.second
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
    nm.createNotificationChannel(
      NotificationChannel(RIDE_CHANNEL, "Active ride", NotificationManager.IMPORTANCE_LOW).apply {
        description = "Shown while a ride is being recorded and crash detection is on"
        setShowBadge(false)
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

  private fun openAppIntent(): PendingIntent {
    val launch = packageManager.getLaunchIntentForPackage(packageName)!!.apply {
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    return PendingIntent.getActivity(this, 1, launch, immutable(PendingIntent.FLAG_UPDATE_CURRENT))
  }

  private fun rideNotification(): Notification =
    NotificationCompat.Builder(this, RIDE_CHANNEL)
      .setSmallIcon(android.R.drawable.ic_menu_mylocation)
      .setContentTitle("Ride in progress")
      .setContentText("Crash detection is on. Use Google Maps as normal.")
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setContentIntent(openAppIntent())
      .build()

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
    val text = when {
      c.isTest -> "Test countdown ended. In a real crash your emergency contacts would now be texted your location. Tap to continue."
      c.smsSent > 0 -> "Your location was texted to ${c.smsSent} emergency contact${if (c.smsSent > 1) "s" else ""}. Tap to get help."
      c.smsError != null -> "Couldn't text contacts: ${c.smsError}. Tap to get help."
      else -> "Tap to get help."
    }
    val n = NotificationCompat.Builder(this, CRASH_CHANNEL)
      .setSmallIcon(android.R.drawable.stat_sys_warning)
      .setContentTitle(if (c.isTest) "TEST: no response (nothing sent)" else "No response: emergency alert sent")
      .setContentText(text)
      .setStyle(NotificationCompat.BigTextStyle().bigText(text))
      .setPriority(NotificationCompat.PRIORITY_HIGH)
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setSilent(true)
      .setAutoCancel(true)
      .setContentIntent(openAppIntent())
      .build()
    notifySafely(CRASH_NOTIFICATION_ID, n)
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
