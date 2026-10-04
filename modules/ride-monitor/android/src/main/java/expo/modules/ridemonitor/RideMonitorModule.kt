package expo.modules.ridemonitor

import android.app.Activity
import android.app.KeyguardManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.WindowManager
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

class DetectorConfigRecord : Record {
  @Field val impactG: Double = 3.5
  @Field val settleMs: Double = 1000.0
  @Field val stillMs: Double = 3000.0
  @Field val stillStdG: Double = 0.15
  @Field val stillGyro: Double = 0.5
  @Field val orientationDeg: Double = 40.0
  @Field val requireMotion: Boolean = true
  @Field val minSpeedMps: Double = 3.0
  @Field val handlingPeakG: Double = 2.0
  @Field val handlingPeaks: Int = 3
}

class StartOptions : Record {
  @Field val rideId: String = ""
  @Field val detector: DetectorConfigRecord = DetectorConfigRecord()
  @Field val countdownSeconds: Int = 30
  @Field val contactPhones: List<String> = emptyList()
  @Field val alertTemplate: String = ""
  @Field val autoSms: Boolean = true
  @Field val riderName: String = ""
  @Field val medicalSummary: String = ""
  @Field val contactNames: List<String> = emptyList()
  @Field val autoCall: Boolean = true
  @Field val siren: Boolean = true
  @Field val emergencyNumber: String = "112"
  @Field val followUps: Boolean = true
}

private fun StartOptions.toRideConfig(): RideConfig {
  val d = detector
  return RideConfig(
    rideId = rideId,
    detector = DetectorConfig(
      d.impactG, d.settleMs.toLong(), d.stillMs.toLong(), d.stillStdG, d.stillGyro, d.orientationDeg,
      d.requireMotion, d.minSpeedMps, d.handlingPeakG, d.handlingPeaks,
    ),
    countdownSeconds = countdownSeconds,
    contactPhones = contactPhones,
    alertTemplate = alertTemplate,
    autoSms = autoSms,
    riderName = riderName,
    medicalSummary = medicalSummary,
    contactNames = contactNames,
    autoCall = autoCall,
    siren = siren,
    emergencyNumber = emergencyNumber,
    followUps = followUps,
  )
}

class RideMonitorModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

  override fun definition() = ModuleDefinition {
    Name("RideMonitor")

    Events("onRideUpdate", "onLiveG", "onBump", "onCrash", "onCrashResolved")

    OnCreate {
      RideMonitor.emitter = { name, body -> sendEvent(name, body) }
      RideMonitor.appInForeground = true
    }

    OnDestroy {
      RideMonitor.emitter = null
    }

    OnActivityEntersForeground { RideMonitor.appInForeground = true }
    OnActivityEntersBackground {
      RideMonitor.appInForeground = false
      RideMonitor.service?.onAppBackgrounded()
    }

    AsyncFunction("start") { options: StartOptions ->
      RideMonitorService.pendingConfig = options.toRideConfig()
      val intent = Intent(context, RideMonitorService::class.java).setAction(RideMonitorService.ACTION_START)
      ContextCompat.startForegroundService(context, intent)
    }

    Function("updateConfig") { options: StartOptions ->
      RideMonitor.service?.updateConfig(options.toRideConfig())
    }

    AsyncFunction("stop") {
      val service = RideMonitor.service ?: return@AsyncFunction null
      val result = service.snapshot() + mapOf("route" to service.routeMaps(), "endTime" to System.currentTimeMillis().toDouble())
      context.stopService(Intent(context, RideMonitorService::class.java))
      result
    }

    Function("isRunning") { RideMonitor.service != null }

    Function<Map<String, Any?>?>("getSnapshot") { RideMonitor.service?.snapshot() }

    Function<List<Map<String, Any?>>>("getRoute") { RideMonitor.service?.routeMaps() ?: emptyList() }

    Function<Map<String, Any?>?>("getCrash") {
      val service = RideMonitor.service
      val crash = service?.crash
      if (service != null && crash != null) service.crashMap(crash) else null
    }

    Function("simulateCrash") { RideMonitor.service?.triggerCrash(null, "simulated") }

    Function("resolveCrash") { outcome: String -> RideMonitor.service?.resolveCrash(outcome) }

    Function("resumeDetection") { RideMonitor.service?.resumeDetection() }

    /** The rider touched the app: a jolt around now is handling, not a crash. */
    Function("noteInteraction") { RideMonitor.service?.noteInteraction() }

    /** Help has arrived / rider is OK: stop the siren, auto-calls and follow-up texts. */
    Function("stopEmergency") { RideMonitor.service?.stopEmergency() }

    Function("stopSiren") { RideMonitor.service?.responder?.stopSiren() }

    Function<Map<String, Any?>?>("getEmergency") { RideMonitor.service?.emergencyMap() }

    AsyncFunction("sendSms") { phones: List<String>, body: String ->
      val (sent, error) = SmsSender.send(context, phones, body)
      mapOf("sent" to sent, "error" to error)
    }

    Function("getSystemStatus") {
      val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val pm = context.getSystemService(Context.POWER_SERVICE) as PowerManager
      mapOf(
        "notificationsEnabled" to nm.areNotificationsEnabled(),
        "fullScreenIntentAllowed" to (Build.VERSION.SDK_INT < 34 || nm.canUseFullScreenIntent()),
        "ignoringBatteryOptimizations" to pm.isIgnoringBatteryOptimizations(context.packageName),
      )
    }

    Function("openFullScreenIntentSettings") {
      val intent = if (Build.VERSION.SDK_INT >= 34) {
        Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:${context.packageName}"))
      } else {
        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
      }
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    /** Ring a (non-emergency) number directly. False if not allowed; the caller then opens the dialer. */
    Function("placeCall") { phone: String -> CallPlacer.place(context, phone) }

    // ---- Lock-screen ride dash ------------------------------------------------

    /**
     * Let the app's current screen show over the lock screen (the ride dash and
     * the crash / help screens), or stop doing so. JS decides per route.
     */
    AsyncFunction("setShowWhenLocked") { on: Boolean ->
      val activity = appContext.currentActivity ?: return@AsyncFunction
      setShowWhenLocked(activity, on)
    }.runOnQueue(Queues.MAIN)

    Function("isDeviceLocked") {
      (context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked
    }

    /** Ask the rider to unlock (PIN / fingerprint). Resolves true once unlocked, false if cancelled. */
    AsyncFunction("requestUnlock") { promise: Promise ->
      val activity = appContext.currentActivity
      val km = context.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
      if (!km.isKeyguardLocked) return@AsyncFunction promise.resolve(true)
      if (activity == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return@AsyncFunction promise.resolve(false)
      km.requestDismissKeyguard(
        activity,
        object : KeyguardManager.KeyguardDismissCallback() {
          override fun onDismissSucceeded() = promise.resolve(true)
          override fun onDismissCancelled() = promise.resolve(false)
          override fun onDismissError() = promise.resolve(false)
        },
      )
    }.runOnQueue(Queues.MAIN)

    Function("requestIgnoreBatteryOptimizations") {
      val intent = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:${context.packageName}"))
      context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}

private fun setShowWhenLocked(activity: Activity, on: Boolean) {
  if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
    activity.setShowWhenLocked(on)
  } else {
    @Suppress("DEPRECATION")
    if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
    else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED)
  }
}
