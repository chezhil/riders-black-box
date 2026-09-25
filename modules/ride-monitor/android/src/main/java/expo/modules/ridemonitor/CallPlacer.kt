package expo.modules.ridemonitor

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.telecom.TelecomManager
import androidx.core.content.ContextCompat

/** Places ordinary (non-emergency) phone calls directly, without the dialer step. */
object CallPlacer {
  @SuppressLint("MissingPermission")
  fun place(context: Context, phone: String, speaker: Boolean = false): Boolean {
    if (ContextCompat.checkSelfPermission(context, Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
      return false
    }
    return try {
      val extras = Bundle().apply { putBoolean(TelecomManager.EXTRA_START_CALL_WITH_SPEAKERPHONE, speaker) }
      context.getSystemService(TelecomManager::class.java).placeCall(Uri.fromParts("tel", phone.trim(), null), extras)
      true
    } catch (e: Exception) {
      false
    }
  }
}
