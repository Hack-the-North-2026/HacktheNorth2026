package com.fitstealer.overlay

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.Gravity
import android.view.LayoutInflater
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.Toast
import androidx.annotation.RequiresApi
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID

/**
 * FitStealerAccessibilityService
 *
 * Draws a floating bubble over the OS using TYPE_ACCESSIBILITY_OVERLAY.
 *
 * Features:
 *  - Drag-to-delete: drag the bubble to the bottom "X" zone to dismiss it
 *    (stops the service so the bubble disappears entirely).
 *  - Lock screen exclusion: bubble is hidden whenever the screen is off or the
 *    lock screen is showing, and restored when the user unlocks the device.
 *
 * Flow on tap:
 *   1. takeScreenshot()  — API 30+
 *   2. Compress to JPEG  — background thread
 *   3. POST /api/identify multipart
 *   4. Parse job_id from response JSON
 *   5. Fire fit-stealer://job/<job_id> deep link
 */
class FitStealerAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "FitStealer.Overlay"

        private val API_BASE: String by lazy {
            try {
                val clazz = Class.forName("com.fitstealer.app.BuildConfig")
                val field = clazz.getField("FIT_STEALER_API_URL")
                val value = field.get(null) as? String
                if (!value.isNullOrBlank()) value else "http://10.0.2.2:4000"
            } catch (_: Exception) {
                "http://10.0.2.2:4000"
            }
        }

        private const val BUBBLE_SIZE_DP = 54f
        private const val BUBBLE_MARGIN_DP = 16f

        /** Delete zone is visible when bubble centre is within this many px of the bottom. */
        private const val DELETE_ZONE_HEIGHT_DP = 96f
    }

    private var windowManager: WindowManager? = null

    // The draggable bubble.
    private var bubbleView: View? = null
    private var bubbleParams: WindowManager.LayoutParams? = null

    // The full-width delete zone anchored to the screen bottom.
    private var deleteZoneView: View? = null
    private var deleteZoneParams: WindowManager.LayoutParams? = null

    private val mainHandler = Handler(Looper.getMainLooper())

    // Tracks whether the bubble should be visible (hidden on lock screen).
    private var isBubbleVisible = true

    // -----------------------------------------------------------------------
    // Lock-screen broadcast receiver
    // -----------------------------------------------------------------------

    private val lockScreenReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_SCREEN_OFF,
                Intent.ACTION_USER_PRESENT -> {
                    // ACTION_SCREEN_OFF  → screen turned off (lock screen imminent)
                    // ACTION_USER_PRESENT → device fully unlocked
                    val shouldShow = intent.action == Intent.ACTION_USER_PRESENT
                    mainHandler.post { setBubbleVisible(shouldShow) }
                }
            }
        }
    }

    // -----------------------------------------------------------------------
    // AccessibilityService lifecycle
    // -----------------------------------------------------------------------

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "Service connected — adding overlay bubble")

        serviceInfo = serviceInfo?.also { info ->
            info.eventTypes = AccessibilityServiceInfo.FEEDBACK_GENERIC
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            info.flags = AccessibilityServiceInfo.DEFAULT
        }

        // Register screen-off / unlock receiver so we can hide on lock screen.
        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
        }
        registerReceiver(lockScreenReceiver, filter)

        showBubble()
    }

    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) {
        // Overlay-only; we don't consume accessibility events.
    }

    override fun onInterrupt() {
        Log.w(TAG, "Service interrupted")
    }

    override fun onDestroy() {
        super.onDestroy()
        try { unregisterReceiver(lockScreenReceiver) } catch (_: Exception) {}
        removeBubble()
        removeDeleteZone()
        Log.i(TAG, "Service destroyed — bubble removed")
    }

    // -----------------------------------------------------------------------
    // Bubble visibility (lock-screen hiding)
    // -----------------------------------------------------------------------

    private fun setBubbleVisible(visible: Boolean) {
        if (isBubbleVisible == visible) return
        isBubbleVisible = visible
        val wm = windowManager ?: return
        val view = bubbleView ?: return
        val params = bubbleParams ?: return

        if (visible) {
            // Restore normal interactive flags.
            params.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
        } else {
            // Make view invisible but keep it in window hierarchy so we can
            // flip it back quickly — or simply remove and re-add.
            params.flags = WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        }
        view.visibility = if (visible) View.VISIBLE else View.GONE
        try { wm.updateViewLayout(view, params) } catch (_: Exception) {}
    }

    // -----------------------------------------------------------------------
    // Bubble management
    // -----------------------------------------------------------------------

    private fun showBubble() {
        val wm = getSystemService(WINDOW_SERVICE) as? WindowManager ?: return
        windowManager = wm

        val density = resources.displayMetrics.density
        val sizePx = (BUBBLE_SIZE_DP * density).toInt()
        val marginPx = (BUBBLE_MARGIN_DP * density).toInt()
        val deleteZoneHeightPx = (DELETE_ZONE_HEIGHT_DP * density).toInt()

        // ---- Bubble params ----
        val params = WindowManager.LayoutParams(
            sizePx,
            sizePx,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.TOP or Gravity.END
            x = marginPx
            y = marginPx * 6
        }
        bubbleParams = params

        val inflater = LayoutInflater.from(this)
        val view = inflater.inflate(
            resources.getIdentifier("overlay_bubble", "layout", packageName),
            null,
        )

        // ---- Delete zone params (hidden initially) ----
        val dzParams = WindowManager.LayoutParams(
            WindowManager.LayoutParams.MATCH_PARENT,
            deleteZoneHeightPx,
            WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT,
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
        }
        deleteZoneParams = dzParams

        val dzView = inflater.inflate(
            resources.getIdentifier("overlay_delete_zone", "layout", packageName),
            null,
        )
        deleteZoneView = dzView

        // Add delete zone first so it renders beneath the bubble.
        wm.addView(dzView, dzParams)
        wm.addView(view, params)
        bubbleView = view

        // ---- Touch / drag logic ----
        var initialX = 0
        var initialY = 0
        var touchX = 0f
        var touchY = 0f
        var moved = false

        // Screen dimensions used for delete-zone hit test.
        val screenHeight = resources.displayMetrics.heightPixels

        view.setOnTouchListener { _, event ->
            when (event.action) {
                MotionEvent.ACTION_DOWN -> {
                    initialX = params.x
                    initialY = params.y
                    touchX = event.rawX
                    touchY = event.rawY
                    moved = false
                    true
                }

                MotionEvent.ACTION_MOVE -> {
                    val dx = (event.rawX - touchX).toInt()
                    val dy = (event.rawY - touchY).toInt()
                    if (!moved && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) {
                        moved = true
                        // Reveal the delete zone.
                        dzView.visibility = View.VISIBLE
                    }
                    if (moved) {
                        params.x = initialX - dx   // RTL-aware (Gravity.END)
                        params.y = initialY + dy
                        try { wm.updateViewLayout(view, params) } catch (_: Exception) {}

                        // Highlight the zone when bubble is over it.
                        val bubbleCentreY = params.y + sizePx / 2
                        val inZone = bubbleCentreY >= screenHeight - deleteZoneHeightPx
                        dzView.alpha = if (inZone) 1f else 0.75f
                    }
                    true
                }

                MotionEvent.ACTION_UP -> {
                    if (moved) {
                        // Hide delete zone.
                        dzView.visibility = View.GONE
                        dzView.alpha = 0.75f

                        // Check if bubble was dropped into the delete zone.
                        val bubbleCentreY = params.y + sizePx / 2
                        if (bubbleCentreY >= screenHeight - deleteZoneHeightPx) {
                            // User dragged to the X zone — stop the service.
                            Log.i(TAG, "Bubble dragged to delete zone — disabling service")
                            disableSelf()
                        }
                    } else {
                        onBubbleTapped()
                    }
                    true
                }

                else -> false
            }
        }
    }

    private fun removeBubble() {
        bubbleView?.let { view ->
            try {
                (getSystemService(WINDOW_SERVICE) as? WindowManager)?.removeView(view)
            } catch (_: Exception) {}
            bubbleView = null
        }
    }

    private fun removeDeleteZone() {
        deleteZoneView?.let { view ->
            try {
                (getSystemService(WINDOW_SERVICE) as? WindowManager)?.removeView(view)
            } catch (_: Exception) {}
            deleteZoneView = null
        }
    }

    @Volatile
    private var isProcessing = false

    // -----------------------------------------------------------------------
    // Screenshot + upload
    // -----------------------------------------------------------------------

    private fun onBubbleTapped() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            showToast("Screenshot capture requires Android 11+")
            return
        }
        captureAndUpload()
    }

    @RequiresApi(Build.VERSION_CODES.R)
    private fun captureAndUpload() {
        if (isProcessing) {
            showToast("Scanning already in progress…")
            return
        }
        isProcessing = true
        showToast("Scanning outfit…")

        takeScreenshot(
            Display.DEFAULT_DISPLAY,
            mainExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    Thread {
                        try {
                            val hardwareBitmap = result.hardwareBuffer
                                .let { Bitmap.wrapHardwareBuffer(it, null) }
                                ?: run {
                                    mainHandler.post { showToast("Screenshot capture failed") }
                                    return@Thread
                                }
                            val softBitmap = hardwareBitmap.copy(Bitmap.Config.ARGB_8888, false)
                            hardwareBitmap.recycle()

                            val jpegBytes = ByteArrayOutputStream().also { out ->
                                softBitmap.compress(Bitmap.CompressFormat.JPEG, 88, out)
                            }.toByteArray()
                            softBitmap.recycle()

                            uploadAndOpen(jpegBytes)
                        } catch (e: Exception) {
                            Log.e(TAG, "Screenshot processing failed", e)
                            mainHandler.post { showToast("Could not process screenshot") }
                        } finally {
                            isProcessing = false
                        }
                    }.start()
                }

                override fun onFailure(errorCode: Int) {
                    isProcessing = false
                    Log.e(TAG, "takeScreenshot failed with code $errorCode")
                    mainHandler.post { showToast("Screenshot failed (code $errorCode)") }
                }
            },
        )
    }

    private fun uploadAndOpen(jpegBytes: ByteArray) {
        val endpointsList = mutableListOf<String>()
        if (API_BASE.isNotBlank() && !API_BASE.contains("10.0.2.2")) {
            endpointsList.add("$API_BASE/api/identify")
        }
        endpointsList.add("http://127.0.0.1:4000/api/identify")
        endpointsList.add("http://10.0.2.2:4000/api/identify")
        val endpoints = endpointsList.distinct()

        var lastException: Exception? = null
        for (endpoint in endpoints) {
            val boundary = "FitStealer${UUID.randomUUID().toString().replace("-", "")}"
            val url = URL(endpoint)
            Log.i(TAG, "Attempting upload to $url (${jpegBytes.size} bytes)")

            var conn: HttpURLConnection? = null
            try {
                conn = url.openConnection() as HttpURLConnection
                conn.requestMethod = "POST"
                conn.setRequestProperty("Content-Type", "multipart/form-data; boundary=$boundary")
                conn.setRequestProperty("Accept", "application/json")
                conn.doOutput = true
                conn.connectTimeout = 2_000
                conn.readTimeout = 60_000

                conn.outputStream.use { out ->
                    val writer = OutputStreamWriter(out, Charsets.UTF_8)
                    writer.write("--$boundary\r\n")
                    writer.write("Content-Disposition: form-data; name=\"type\"\r\n\r\n")
                    writer.write("image\r\n")
                    writer.write("--$boundary\r\n")
                    writer.write("Content-Disposition: form-data; name=\"origin\"\r\n\r\n")
                    writer.write("android_overlay\r\n")
                    writer.write("--$boundary\r\n")
                    writer.write("Content-Disposition: form-data; name=\"image\"; filename=\"overlay_capture.jpg\"\r\n")
                    writer.write("Content-Type: image/jpeg\r\n\r\n")
                    writer.flush()
                    out.write(jpegBytes)
                    out.flush()
                    writer.write("\r\n--$boundary--\r\n")
                    writer.flush()
                }

                val status = conn.responseCode
                if (status in 200..299) {
                    val body = conn.inputStream.bufferedReader().readText()
                    Log.i(TAG, "Upload response from $url: $body")
                    val jobId = JSONObject(body).optString("job_id")
                    if (!jobId.isNullOrBlank()) {
                        openJobScreen(jobId)
                        return
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "Failed to connect to $url: ${e.message}")
                lastException = e
            } finally {
                conn?.disconnect()
            }
        }

        Log.e(TAG, "All upload endpoints failed", lastException)
        mainHandler.post { showToast("Network error — backend unreachable") }
    }

    private fun openJobScreen(jobId: String) {
        val uri = Uri.parse("fit-stealer://job/$jobId")
        val intent = Intent(Intent.ACTION_VIEW, uri).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            setPackage(packageName)
        }
        try {
            startActivity(intent)
            Log.i(TAG, "Opened job screen for $jobId")
        } catch (e: Exception) {
            Log.e(TAG, "Could not open job screen", e)
            val fallback = packageManager.getLaunchIntentForPackage(packageName)?.apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            fallback?.let { startActivity(it) }
        }
    }

    private fun showToast(message: String) {
        mainHandler.post {
            Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
        }
    }
}
