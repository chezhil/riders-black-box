package expo.modules.ridemonitor

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat

/**
 * Native full-screen crash screen, shown over the lock screen or over Google
 * Maps. Two modes:
 *  - COUNTDOWN: "Are you OK?" with I'M FINE / I NEED HELP (mirrors
 *    src/app/crash-alert.tsx, which handles the in-app case).
 *  - BYSTANDER: after no response. For whoever picks up the phone: who the
 *    rider is, their medical info, and one-tap calls to 112 and their contacts.
 */
class CrashAlertActivity : Activity() {
  private val handler = Handler(Looper.getMainLooper())
  private var mode: String? = null
  private var countText: TextView? = null
  private var statusText: TextView? = null
  private var sirenButton: Button? = null

  private val tick = object : Runnable {
    override fun run() {
      val c = RideMonitor.crash
      when {
        c == null || c.status == "fine" -> return finish()
        c.status == "help" -> return openAppAndFinish()
        c.status == "alerted" -> {
          if (mode != "bystander") showBystander(c)
          updateBystanderStatus(c)
        }
        else -> {
          if (mode != "countdown") showCountdown(c)
          val left = ((c.deadline - System.currentTimeMillis()) / 1000.0).coerceAtLeast(0.0)
          countText?.text = Math.ceil(left).toInt().toString()
        }
      }
      handler.postDelayed(this, 250)
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      @Suppress("DEPRECATION")
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    @Suppress("DEPRECATION")
    window.statusBarColor = BG
    @Suppress("DEPRECATION")
    window.navigationBarColor = BG
  }

  override fun onResume() {
    super.onResume()
    handler.post(tick)
  }

  override fun onPause() {
    super.onPause()
    handler.removeCallbacks(tick)
  }

  @Deprecated("Deprecated in Java")
  override fun onBackPressed() {
    // The rider must answer the countdown; bystanders may leave the info screen.
    @Suppress("DEPRECATION")
    if (mode == "bystander") super.onBackPressed()
  }

  private fun openAppAndFinish() {
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      startActivity(it)
    }
    finish()
  }

  // ---- Countdown ---------------------------------------------------------------

  private fun showCountdown(c: CrashState) {
    mode = "countdown"
    val root = column().apply { setPadding(dp(24), dp(48), dp(24), dp(32)) }
    root.addView(text("⚠", 40f, RED))
    root.addView(text("Are you OK?", 40f, Color.WHITE, bold = true))
    root.addView(
      text(
        if (c.isTest) "TEST (simulated crash). Nothing is sent if you don't respond: no SMS, no calls."
        else "We detected a possible crash. If you don't respond, your emergency contacts will be texted your location and called.",
        16f, DIM,
      ).apply { setPadding(0, dp(8), 0, 0) },
    )
    countText = text("", 110f, Color.WHITE, bold = true)
    root.addView(countText, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f))
    root.addView(
      button("I'M FINE", GREEN, Color.parseColor("#04140A"), 32f) {
        RideMonitor.service?.resolveCrash("fine")
        finish()
      },
      LinearLayout.LayoutParams(MATCH_PARENT, dp(120)),
    )
    root.addView(
      button("I NEED HELP", BG, Color.WHITE, 20f, stroke = RED) {
        RideMonitor.service?.resolveCrash("help")
        openAppAndFinish()
      },
      LinearLayout.LayoutParams(MATCH_PARENT, dp(64)).apply { topMargin = dp(12) },
    )
    setContentView(root)
  }

  // ---- Bystander ---------------------------------------------------------------

  private fun showBystander(c: CrashState) {
    mode = "bystander"
    val service = RideMonitor.service
    val cfg = service?.config
    val root = column().apply { setPadding(dp(20), dp(40), dp(20), dp(28)) }

    if (c.isTest) root.addView(text("TEST · SIMULATED CRASH · NOTHING IS SENT", 13f, INFO, bold = true))
    root.addView(text("⚠ THIS RIDER MAY BE INJURED", 26f, RED, bold = true).apply { setPadding(0, dp(8), 0, 0) })
    root.addView(
      text("A crash was detected and they didn't respond. Please check on them and call for help.", 16f, Color.WHITE)
        .apply { setPadding(0, dp(6), 0, dp(14)) },
    )

    statusText = text("", 14f, DIM).apply { gravity = Gravity.START }
    root.addView(statusText)

    // Who they are / medical info for first responders.
    val card = column().apply {
      gravity = Gravity.START
      background = rounded(CARD, 16)
      setPadding(dp(16), dp(14), dp(16), dp(14))
    }
    card.addView(label("RIDER"))
    card.addView(text(cfg?.riderName?.ifBlank { "Unknown" } ?: "Unknown", 22f, Color.WHITE, bold = true).apply { gravity = Gravity.START })
    if (!cfg?.medicalSummary.isNullOrBlank()) {
      card.addView(label("MEDICAL INFO").apply { setPadding(0, dp(10), 0, 0) })
      card.addView(text(cfg!!.medicalSummary, 17f, Color.WHITE).apply { gravity = Gravity.START })
    }
    root.addView(card, LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = dp(12) })

    val number = cfg?.emergencyNumber?.ifBlank { null } ?: "112"
    root.addView(
      button("CALL $number (EMERGENCY)", RED, Color.WHITE, 22f) { callEmergency(number, c.isTest) },
      LinearLayout.LayoutParams(MATCH_PARENT, dp(76)).apply { topMargin = dp(16) },
    )

    cfg?.contactPhones?.forEachIndexed { i, phone ->
      if (phone.isBlank()) return@forEachIndexed
      val name = cfg.contactNames.getOrNull(i)?.ifBlank { null } ?: phone
      root.addView(
        button("Call $name (emergency contact)", CARD, Color.WHITE, 17f, stroke = BORDER) {
          if (c.isTest) toast("Test: not calling $name")
          else service?.responder?.callNow(name, phone) ?: dial(phone)
        },
        LinearLayout.LayoutParams(MATCH_PARENT, dp(60)).apply { topMargin = dp(10) },
      )
    }

    sirenButton = button("Stop siren", CARD, Color.WHITE, 16f, stroke = BORDER) {
      service?.responder?.stopSiren()
    }
    root.addView(sirenButton, LinearLayout.LayoutParams(MATCH_PARENT, dp(52)).apply { topMargin = dp(18) })

    root.addView(
      button("I'm the rider: close", BG, DIM, 15f) { openAppAndFinish() },
      LinearLayout.LayoutParams(MATCH_PARENT, dp(52)).apply { topMargin = dp(6) },
    )

    setContentView(ScrollView(this).apply { setBackgroundColor(BG); addView(root) })
  }

  private fun updateBystanderStatus(c: CrashState) {
    val r = RideMonitor.service?.responder
    val lines = mutableListOf<String>()
    when {
      c.isTest -> lines += "Test: in a real crash, emergency contacts would be texted and called now."
      c.smsSent > 0 -> lines += "✓ Emergency contacts were texted the rider's location."
      c.smsError != null -> lines += "✗ Couldn't text emergency contacts (${c.smsError})."
    }
    r?.callingName?.let { lines += "📞 Calling $it on speakerphone…" }
    if ((r?.pendingRetries ?: 0) > 0) lines += "Some texts failed (weak signal?). Retrying every minute."
    statusText?.text = lines.joinToString("\n")
    sirenButton?.visibility = if (r?.sirenOn == true) View.VISIBLE else View.GONE
  }

  private fun callEmergency(number: String, isTest: Boolean) {
    if (isTest) {
      toast("Test: not calling $number")
      return
    }
    // Ordinary apps can't place emergency calls directly; Android opens the
    // dialer with the number filled in (usable from the lock screen).
    val canCall = ContextCompat.checkSelfPermission(this, Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
    runCatching {
      startActivity(Intent(if (canCall) Intent.ACTION_CALL else Intent.ACTION_DIAL, Uri.parse("tel:$number")))
    }.onFailure { dial(number) }
  }

  private fun dial(phone: String) {
    runCatching { startActivity(Intent(Intent.ACTION_DIAL, Uri.parse("tel:$phone"))) }
  }

  // ---- View helpers ------------------------------------------------------------

  private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

  private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

  private fun rounded(color: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radius).toFloat()
    stroke?.let { setStroke(dp(2), it) }
  }

  private fun column() = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    setBackgroundColor(BG)
    gravity = Gravity.CENTER_HORIZONTAL
  }

  private fun text(value: String, sp: Float, color: Int, bold: Boolean = false) = TextView(this).apply {
    text = value
    setTextColor(color)
    setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
    if (bold) typeface = Typeface.DEFAULT_BOLD
    gravity = Gravity.CENTER
  }

  private fun label(value: String) = text(value, 12f, DIM, bold = true).apply {
    gravity = Gravity.START
    letterSpacing = 0.08f
  }

  private fun button(label: String, bg: Int, fg: Int, sp: Float, stroke: Int? = null, onClick: () -> Unit) =
    Button(this).apply {
      text = label
      isAllCaps = false
      setTextColor(fg)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, sp)
      typeface = Typeface.DEFAULT_BOLD
      background = rounded(bg, 18, stroke)
      setOnClickListener { onClick() }
    }

  companion object {
    private val BG = Color.parseColor("#140607")
    private val CARD = Color.parseColor("#1E232A")
    private val BORDER = Color.parseColor("#2A3038")
    private val RED = Color.parseColor("#EF4444")
    private val GREEN = Color.parseColor("#22C55E")
    private val INFO = Color.parseColor("#38BDF8")
    private val DIM = Color.parseColor("#9AA3AF")
  }
}
