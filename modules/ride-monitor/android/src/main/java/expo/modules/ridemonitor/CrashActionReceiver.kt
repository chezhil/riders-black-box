package expo.modules.ridemonitor

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Handles the "I'M FINE" button on the crash notification without opening the app. */
class CrashActionReceiver : BroadcastReceiver() {
  companion object {
    const val ACTION_FINE = "expo.modules.ridemonitor.CRASH_FINE"
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == ACTION_FINE) RideMonitor.service?.resolveCrash("fine")
  }
}
