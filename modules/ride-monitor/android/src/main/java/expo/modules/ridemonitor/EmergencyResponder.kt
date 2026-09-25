package expo.modules.ridemonitor

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.telecom.TelecomManager
import android.telephony.PhoneStateListener
import android.telephony.SmsManager
import android.telephony.TelephonyCallback
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * What happens when the rider doesn't answer "Are you OK?", for riders who
 * can't use their phone:
 *
 *  1. SMS every emergency contact from the SIM; texts that fail (no signal)
 *     are retried every minute for 15 minutes.
 *  2. Follow-up location texts every 3 minutes for 15 minutes.
 *  3. Phone the contacts one by one on speakerphone. A call that ends within
 *     25 s was probably not answered, so the next contact is tried; a call
 *     that never starts (no signal) is skipped after 15 s. If nobody picked
 *     up, the whole list is tried once more 2 minutes later.
 *  4. A loud siren (alarm stream, max volume) so people nearby notice; it
 *     pauses during calls. The lock-screen bystander screen can stop it.
 *
 * Simulated (demo) crashes only get the siren (briefly): nothing is sent and
 * nobody is called.
 */
class EmergencyResponder(
  private val context: Context,
  private val config: RideConfig,
  private val main: Handler,
  private val currentLocation: () -> Pair<Double, Double>?,
) {
  var active = false
    private set
  var sirenOn = false
    private set
  /** Name of the contact being called right now, if any. */
  var callingName: String? = null
    private set
  var callsFinished = false
    private set
  val pendingRetries get() = retryQueue.size

  private var startedAt = 0L
  private var isTest = false

  // ---- Lifecycle -------------------------------------------------------------

  /** Returns how many alert texts were queued and an error, if any. */
  fun begin(crash: CrashState): Pair<Int, String?> {
    if (active) return 0 to null
    active = true
    startedAt = System.currentTimeMillis()
    isTest = crash.isTest

    if (isTest) {
      if (config.siren) startSiren(TEST_SIREN_MS)
      return 0 to null
    }

    val result = sendInitialAlert(crash)
    if (config.followUps) scheduleFollowUps()
    if (config.siren) startSiren(SIREN_MS)
    if (config.autoCall) startCalls()
    return result
  }

  fun stop() {
    if (!active) return
    active = false
    main.removeCallbacks(retryRunnable)
    main.removeCallbacks(followUpRunnable)
    main.removeCallbacks(callTimeoutRunnable)
    main.removeCallbacks(nextCallRunnable)
    main.removeCallbacks(nextRoundRunnable)
    callQueue.clear()
    callingName = null
    stopSiren()
    unregisterCallState()
    runCatching { if (receiverRegistered) context.unregisterReceiver(smsSentReceiver) }
    receiverRegistered = false
    outgoing.clear()
    retryQueue.clear()
  }

  // ---- SMS with retry --------------------------------------------------------

  private class Outgoing(val phone: String, val body: String, val parts: Int, var attempts: Int) {
    var results = 0
    var failed = false
  }

  private val outgoing = HashMap<String, Outgoing>()
  private val retryQueue = ArrayList<Outgoing>()
  private var receiverRegistered = false
  private var requestCode = 1000

  private val smsSentReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
      val id = intent.getStringExtra(EXTRA_ID) ?: return
      val o = outgoing[id] ?: return
      o.results++
      if (resultCode != Activity.RESULT_OK) o.failed = true
      if (o.results >= o.parts) {
        outgoing.remove(id)
        if (o.failed) queueRetry(o)
      }
    }
  }

  private fun smsManager(): SmsManager =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      context.getSystemService(SmsManager::class.java)
    } else {
      @Suppress("DEPRECATION")
      SmsManager.getDefault()
    }

  private fun ensureReceiver() {
    if (receiverRegistered) return
    ContextCompat.registerReceiver(
      context,
      smsSentReceiver,
      IntentFilter(ACTION_SMS_SENT),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
    receiverRegistered = true
  }

  /** Sends one text, tracking delivery to the network so failures get retried. */
  private fun sendTracked(phone: String, body: String, attempts: Int = 1): Boolean {
    if (!hasPermission(Manifest.permission.SEND_SMS)) return false
    ensureReceiver()
    val sms = smsManager()
    return try {
      val parts = sms.divideMessage(body)
      val id = "${System.nanoTime()}-${phone.hashCode()}"
      val o = Outgoing(phone, body, parts.size, attempts)
      outgoing[id] = o
      val sentIntents = ArrayList(
        parts.map {
          android.app.PendingIntent.getBroadcast(
            context,
            requestCode++,
            Intent(ACTION_SMS_SENT).setPackage(context.packageName).putExtra(EXTRA_ID, id),
            android.app.PendingIntent.FLAG_IMMUTABLE,
          )
        },
      )
      sms.sendMultipartTextMessage(phone, null, parts, sentIntents, null)
      true
    } catch (e: Exception) {
      queueRetry(Outgoing(phone, body, 1, attempts))
      false
    }
  }

  private fun queueRetry(o: Outgoing) {
    if (!active || o.attempts >= MAX_SMS_ATTEMPTS) return
    retryQueue.add(o)
    main.removeCallbacks(retryRunnable)
    main.postDelayed(retryRunnable, SMS_RETRY_MS)
  }

  private val retryRunnable = Runnable {
    if (!active || System.currentTimeMillis() - startedAt > EMERGENCY_WINDOW_MS) return@Runnable
    val batch = ArrayList(retryQueue)
    retryQueue.clear()
    batch.forEach { sendTracked(it.phone, it.body, it.attempts + 1) }
  }

  private fun sendInitialAlert(crash: CrashState): Pair<Int, String?> {
    val phones = config.contactPhones.map { it.trim() }.filter { it.isNotEmpty() }
    if (phones.isEmpty()) return 0 to "No emergency contacts"
    if (!hasPermission(Manifest.permission.SEND_SMS)) return 0 to "SMS permission not granted"
    val loc = if (crash.lat != null && crash.lng != null) crash.lat to crash.lng else currentLocation()
    val time = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date(crash.startedAt))
    val body = config.alertTemplate.replace("{LINK}", mapsLink(loc)).replace("{TIME}", time)
    var queued = 0
    phones.forEach { if (sendTracked(it, body)) queued++ }
    return queued to null
  }

  // ---- Follow-up location texts -----------------------------------------------

  private var followUpsSent = 0

  private fun scheduleFollowUps() {
    followUpsSent = 0
    main.postDelayed(followUpRunnable, FOLLOW_UP_EVERY_MS)
  }

  private val followUpRunnable: Runnable = object : Runnable {
    override fun run() {
      if (!active || followUpsSent >= MAX_FOLLOW_UPS) return
      followUpsSent++
      val time = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date())
      val name = config.riderName.ifBlank { "Your contact" }
      val body = "📍 Location update for $name ($time): ${mapsLink(currentLocation())} " +
        "They have not responded since the crash alert."
      config.contactPhones.map { it.trim() }.filter { it.isNotEmpty() }.forEach { sendTracked(it, body) }
      main.postDelayed(this, FOLLOW_UP_EVERY_MS)
    }
  }

  // ---- Auto-calls ------------------------------------------------------------

  private val callQueue = ArrayDeque<Pair<String, String>>()
  private var inCall = false
  private var offhookAt = 0L
  private var telephonyCallback: Any? = null
  private var anyAnswered = false
  private var roundsLeft = CALL_ROUNDS

  private fun startCalls() {
    if (!hasPermission(Manifest.permission.CALL_PHONE)) {
      callsFinished = true
      return
    }
    registerCallState()
    startCallRound(firstDelayMs = 4000) // let the alert SMS go out before the radio is busy
  }

  private fun startCallRound(firstDelayMs: Long) {
    roundsLeft--
    callQueue.clear()
    config.contactPhones.forEachIndexed { i, phone ->
      if (phone.isNotBlank()) callQueue.addLast((config.contactNames.getOrNull(i) ?: phone) to phone.trim())
    }
    main.postDelayed(nextCallRunnable, firstDelayMs)
  }

  private val nextRoundRunnable = Runnable { if (active) startCallRound(firstDelayMs = 0) }

  /** Bystander tapped "Call <name>": stop the automatic sequence and call them now. */
  fun callNow(name: String, phone: String) {
    callQueue.clear()
    roundsLeft = 0
    main.removeCallbacks(nextCallRunnable)
    main.removeCallbacks(nextRoundRunnable)
    placeCall(name, phone)
  }

  private val nextCallRunnable = Runnable { placeNextCall() }

  private fun placeNextCall() {
    if (!active) return
    val next = callQueue.removeFirstOrNull()
    if (next == null) {
      onCallsFinished()
      return
    }
    placeCall(next.first, next.second)
  }

  @SuppressLint("MissingPermission")
  private fun placeCall(name: String, phone: String) {
    if (!hasPermission(Manifest.permission.CALL_PHONE)) return
    callingName = name
    pauseSiren()
    val extras = Bundle().apply { putBoolean(TelecomManager.EXTRA_START_CALL_WITH_SPEAKERPHONE, true) }
    try {
      context.getSystemService(TelecomManager::class.java).placeCall(Uri.fromParts("tel", phone, null), extras)
    } catch (e: Exception) {
      main.postDelayed(nextCallRunnable, 1000)
      return
    }
    // Outgoing calls go off-hook as soon as dialing starts; if that doesn't
    // happen the call failed (e.g. no signal). Without call-state access we
    // can't tell, so wait longer before moving on.
    main.removeCallbacks(callTimeoutRunnable)
    main.postDelayed(callTimeoutRunnable, if (telephonyCallback != null) CALL_START_TIMEOUT_MS else CALL_TIMEOUT_MS)
  }

  private val callTimeoutRunnable = Runnable {
    if (inCall) return@Runnable
    if (callQueue.isNotEmpty()) placeNextCall() else onCallsFinished()
  }

  private fun onCallState(state: Int) {
    when (state) {
      TelephonyManager.CALL_STATE_OFFHOOK -> {
        if (!inCall) {
          inCall = true
          offhookAt = System.currentTimeMillis()
          main.removeCallbacks(callTimeoutRunnable)
        }
      }
      TelephonyManager.CALL_STATE_IDLE -> {
        if (!inCall) return
        inCall = false
        val duration = System.currentTimeMillis() - offhookAt
        if (duration >= ANSWERED_MIN_MS) {
          anyAnswered = true
          onCallsFinished()
        } else if (callQueue.isNotEmpty()) {
          // Probably rang out / declined: try the next contact.
          main.postDelayed(nextCallRunnable, 3000)
        } else {
          onCallsFinished()
        }
      }
    }
  }

  private fun onCallsFinished() {
    callQueue.clear()
    callingName = null
    resumeSiren()
    if (!anyAnswered && roundsLeft > 0 && active) {
      main.postDelayed(nextRoundRunnable, CALL_ROUND_GAP_MS)
      return
    }
    callsFinished = true
    unregisterCallState()
  }

  @SuppressLint("MissingPermission")
  private fun registerCallState() {
    if (!hasPermission(Manifest.permission.READ_PHONE_STATE) || telephonyCallback != null) return
    val tm = context.getSystemService(TelephonyManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      val cb = object : TelephonyCallback(), TelephonyCallback.CallStateListener {
        override fun onCallStateChanged(state: Int) = onCallState(state)
      }
      tm.registerTelephonyCallback(ContextCompat.getMainExecutor(context), cb)
      telephonyCallback = cb
    } else {
      @Suppress("DEPRECATION")
      val listener = object : PhoneStateListener() {
        @Deprecated("Deprecated in Java")
        override fun onCallStateChanged(state: Int, phoneNumber: String?) = onCallState(state)
      }
      @Suppress("DEPRECATION")
      tm.listen(listener, PhoneStateListener.LISTEN_CALL_STATE)
      telephonyCallback = listener
    }
  }

  private fun unregisterCallState() {
    val cb = telephonyCallback ?: return
    val tm = context.getSystemService(TelephonyManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && cb is TelephonyCallback) {
      tm.unregisterTelephonyCallback(cb)
    } else if (cb is PhoneStateListener) {
      @Suppress("DEPRECATION")
      tm.listen(cb, PhoneStateListener.LISTEN_NONE)
    }
    telephonyCallback = null
  }

  // ---- Siren -----------------------------------------------------------------

  private var player: MediaPlayer? = null
  private var savedAlarmVolume: Int? = null
  private var sirenUntil = 0L
  private val stopSirenRunnable = Runnable { stopSiren() }

  private fun startSiren(durationMs: Long) {
    val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
      ?: return
    try {
      val am = context.getSystemService(AudioManager::class.java)
      savedAlarmVolume = am.getStreamVolume(AudioManager.STREAM_ALARM)
      am.setStreamVolume(AudioManager.STREAM_ALARM, am.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
      player = MediaPlayer().apply {
        setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_ALARM)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build(),
        )
        setDataSource(context, uri)
        isLooping = true
        prepare()
        start()
      }
      sirenOn = true
      sirenUntil = System.currentTimeMillis() + durationMs
      main.postDelayed(stopSirenRunnable, durationMs)
    } catch (e: Exception) {
      stopSiren()
    }
  }

  private fun pauseSiren() {
    runCatching { if (player?.isPlaying == true) player?.pause() }
  }

  private fun resumeSiren() {
    if (sirenOn && System.currentTimeMillis() < sirenUntil) runCatching { player?.start() }
  }

  fun stopSiren() {
    main.removeCallbacks(stopSirenRunnable)
    runCatching {
      player?.stop()
      player?.release()
    }
    player = null
    sirenOn = false
    savedAlarmVolume?.let { vol ->
      runCatching { context.getSystemService(AudioManager::class.java).setStreamVolume(AudioManager.STREAM_ALARM, vol, 0) }
    }
    savedAlarmVolume = null
  }

  // ---- Helpers ---------------------------------------------------------------

  private fun hasPermission(p: String) =
    ContextCompat.checkSelfPermission(context, p) == PackageManager.PERMISSION_GRANTED

  private fun mapsLink(loc: Pair<Double, Double>?) =
    if (loc == null) "(location unavailable)"
    else "https://www.google.com/maps/search/?api=1&query=%.6f,%.6f".format(Locale.US, loc.first, loc.second)

  companion object {
    private const val ACTION_SMS_SENT = "expo.modules.ridemonitor.SMS_SENT"
    private const val EXTRA_ID = "id"
    private const val EMERGENCY_WINDOW_MS = 15 * 60_000L
    private const val SMS_RETRY_MS = 60_000L
    private const val MAX_SMS_ATTEMPTS = 15
    private const val FOLLOW_UP_EVERY_MS = 3 * 60_000L
    private const val MAX_FOLLOW_UPS = 5
    private const val ANSWERED_MIN_MS = 25_000L
    private const val CALL_TIMEOUT_MS = 120_000L
    private const val CALL_START_TIMEOUT_MS = 15_000L
    private const val CALL_ROUNDS = 2
    private const val CALL_ROUND_GAP_MS = 2 * 60_000L
    private const val SIREN_MS = 5 * 60_000L
    private const val TEST_SIREN_MS = 15_000L
  }
}
