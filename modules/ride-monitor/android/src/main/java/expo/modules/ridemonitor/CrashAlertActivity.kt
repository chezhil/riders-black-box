package expo.modules.ridemonitor

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Native full-screen "Are you OK?" alert. Shown over the lock screen or over
 * Google Maps when a crash is detected while the app is in the background.
 * Mirrors src/app/crash-alert.tsx, which handles the in-app case.
 */
class CrashAlertActivity : Activity() {
  private val handler = Handler(Looper.getMainLooper())
  private lateinit var countText: TextView
  private lateinit var subText: TextView

  private val tick = object : Runnable {
    override fun run() {
      val c = RideMonitor.crash
      if (c == null || c.status == "fine") return finish()
      if (c.status == "alerted" || c.status == "help") return openAppAndFinish()
      val left = ((c.deadline - System.currentTimeMillis()) / 1000.0).coerceAtLeast(0.0)
      countText.text = Math.ceil(left).toInt().toString()
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
    window.statusBarColor = BG
    window.navigationBarColor = BG
    setContentView(buildUi())
    if (RideMonitor.crash?.isTest == true) {
      subText.text = "TEST (simulated crash). If you don't respond, only your emergency contacts get a test text."
    }
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
    // Deliberately ignored: the rider must answer.
  }

  private fun openAppAndFinish() {
    packageManager.getLaunchIntentForPackage(packageName)?.let {
      it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      startActivity(it)
    }
    finish()
  }

  private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()

  private fun rounded(color: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
    setColor(color)
    cornerRadius = dp(radius).toFloat()
    stroke?.let { setStroke(dp(2), it) }
  }

  private fun buildUi() = LinearLayout(this).apply {
    orientation = LinearLayout.VERTICAL
    setBackgroundColor(BG)
    setPadding(dp(24), dp(48), dp(24), dp(32))
    gravity = Gravity.CENTER_HORIZONTAL

    addView(TextView(context).apply {
      text = "⚠"
      setTextColor(RED)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 40f)
      gravity = Gravity.CENTER
    })
    addView(TextView(context).apply {
      text = "Are you OK?"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 40f)
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    })
    subText = TextView(context).apply {
      text = "We detected a possible crash. If you don't respond, your emergency contacts will be texted your location."
      setTextColor(Color.parseColor("#9AA3AF"))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
      gravity = Gravity.CENTER
      setPadding(0, dp(8), 0, 0)
    }
    addView(subText)

    countText = TextView(context).apply {
      text = ""
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 110f)
      typeface = Typeface.DEFAULT_BOLD
      gravity = Gravity.CENTER
    }
    addView(countText, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f).apply { gravity = Gravity.CENTER })

    addView(Button(context).apply {
      text = "I'M FINE"
      setTextColor(Color.parseColor("#04140A"))
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 32f)
      typeface = Typeface.DEFAULT_BOLD
      background = rounded(GREEN, 28)
      setOnClickListener {
        RideMonitor.service?.resolveCrash("fine")
        finish()
      }
    }, LinearLayout.LayoutParams(MATCH_PARENT, dp(120)))

    addView(Button(context).apply {
      text = "I NEED HELP"
      setTextColor(Color.WHITE)
      setTextSize(TypedValue.COMPLEX_UNIT_SP, 20f)
      typeface = Typeface.DEFAULT_BOLD
      background = rounded(BG, 18, RED)
      setOnClickListener {
        RideMonitor.service?.resolveCrash("help")
        openAppAndFinish()
      }
    }, LinearLayout.LayoutParams(MATCH_PARENT, dp(64)).apply { topMargin = dp(12) })
  }

  companion object {
    private val BG = Color.parseColor("#140607")
    private val RED = Color.parseColor("#EF4444")
    private val GREEN = Color.parseColor("#22C55E")
  }
}
