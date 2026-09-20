package com.fitstealer.overlay

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.util.Log

class ScreenRecordConsentActivity : Activity() {

    companion object {
        private const val REQUEST_CODE = 1001
        private const val TAG = "FitStealer.Consent"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        
        Log.i(TAG, "Requesting MediaProjection consent")
        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CODE)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_CODE) {
            if (resultCode == RESULT_OK && data != null) {
                Log.i(TAG, "MediaProjection consent granted")
                val serviceIntent = Intent(this, ScreenRecordService::class.java).apply {
                    action = ScreenRecordService.ACTION_INIT
                    putExtra(ScreenRecordService.EXTRA_RESULT_CODE, resultCode)
                    putExtra(ScreenRecordService.EXTRA_RESULT_DATA, data)
                }
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    startForegroundService(serviceIntent)
                } else {
                    startService(serviceIntent)
                }
            } else {
                Log.w(TAG, "MediaProjection consent denied")
                val denied = Intent(ScreenRecordService.ACTION_CONSENT_DENIED).apply {
                    setPackage(packageName)
                }
                sendBroadcast(denied)
            }
        }
        finish()
    }
}
