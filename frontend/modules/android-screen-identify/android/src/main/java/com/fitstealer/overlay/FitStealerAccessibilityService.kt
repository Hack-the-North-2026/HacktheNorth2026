package com.fitstealer.overlay

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
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
 * Draws a floating bubble over the OS using TYPE_ACCESSIBILITY_OVERLAY (no
 * extra permission beyond BIND_ACCESSIBILITY_SERVICE + canTakeScreenshot).
 *
 * Flow on tap:
 *   1. takeScreenshot()  — API 30+; requires canTakeScreenshot=true in config XML
 *   2. Compress to JPEG  — in a background thread
 *   3. POST /api/identify multipart — origin: android_overlay
 *   4. Parse job_id from response JSON
 *   5. Fire fit-stealer://job/<job_id> deep link so the Expo app opens results
 *
 * Privacy: capture happens ONLY on explicit tap. No always-on buffer. No
 * keystroke listening.
 */
class FitStealerAccessibilityService : AccessibilityService() {

    companion object {
        private const val TAG = "FitStealer.Overlay"

        /**
         * API base URL.
         *
         * Priority order:
         *  1. BuildConfig.FIT_STEALER_API_URL   — injected by the config plugin from
         *     EXPO_PUBLIC_API_BASE_URL at prebuild time.
         *  2. Android emulator gateway           — works when running on the default
         *     AVD connected to the dev machine.
         *
         * On a physical device pointed at a local dev server you MUST set
         * EXPO_PUBLIC_API_BASE_URL=http://<your-LAN-IP>:4000 before running prebuild.
         */
        private val API_BASE: String by lazy {
            // BuildConfig field is injected by app.plugin.js via resValue.
            // Falls back to emulator gateway so `expo run:android` works out of the box.
            try {
                val clazz = Class.forName("com.fitstealer.app.BuildConfig")
                val field = clazz.getField("FIT_STEALER_API_URL")
                val value = field.get(null) as? String
                if (!value.isNullOrBlank()) value else "http://10.0.2.2:4000"
            } catch (_: Exception) {
                "http://10.0.2.2:4000"
            }
        }

        // Bubble size in dp → converted to px at runtime via DisplayMetrics.
        private const val BUBBLE_SIZE_DP = 54f
        private const val BUBBLE_MARGIN_DP = 16f
    }

    // WindowManager reference for adding/removing the bubble view.
    private var windowManager: WindowManager? = null

    // The inflated bubble view currently shown on screen.
    private var bubbleView: View? = null

    // WindowManager layout params so we can drag the bubble.
    private var bubbleParams: WindowManager.LayoutParams? = null

    // Main-thread handler for UI updates.
    private val mainHandler = Handler(Looper.getMainLooper())

    // -----------------------------------------------------------------------
    // AccessibilityService lifecycle
    // -----------------------------------------------------------------------

    override fun onServiceConnected() {
        super.onServiceConnected()
        Log.i(TAG, "Service connected — adding overlay bubble")

        // Configure what events we listen for (none needed; we just want the overlay).
        serviceInfo = serviceInfo?.also { info ->
            info.eventTypes = AccessibilityServiceInfo.FEEDBACK_GENERIC
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC
            info.flags = AccessibilityServiceInfo.DEFAULT
        }

        showBubble()
    }

    override fun onAccessibilityEvent(event: android.view.accessibility.AccessibilityEvent?) {
        // We don't consume accessibility events — the service is overlay-only.
    }

    override fun onInterrupt() {
        Log.w(TAG, "Service interrupted")
    }

    override fun onDestroy() {
        super.onDestroy()
        removeBubble()
        Log.i(TAG, "Service destroyed — bubble removed")
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

        // TYPE_ACCESSIBILITY_OVERLAY draws above most system UI without
        // requiring SYSTEM_ALERT_WINDOW when the AccessibilityService is active.
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
            y = marginPx * 6  // Start below the status bar area
        }
        bubbleParams = params

        val inflater = LayoutInflater.from(this)
        val view = inflater.inflate(
            resources.getIdentifier("overlay_bubble", "layout", packageName),
            null,
        )

        // Drag support — let the user reposition the bubble.
        var initialX = 0
        var initialY = 0
        var touchX = 0f
        var touchY = 0f
        var moved = false

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
                    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true
                    params.x = initialX - dx  // RTL-aware (Gravity.END)
                    params.y = initialY + dy
                    wm.updateViewLayout(view, params)
                    true
                }
                MotionEvent.ACTION_UP -> {
                    if (!moved) onBubbleTapped()
                    true
                }
                else -> false
            }
        }

        wm.addView(view, params)
        bubbleView = view
    }

    private fun removeBubble() {
        bubbleView?.let { view ->
            (getSystemService(WINDOW_SERVICE) as? WindowManager)?.removeView(view)
            bubbleView = null
        }
    }

    @Volatile
    private var isProcessing = false

    // -----------------------------------------------------------------------
    // Screenshot + upload
    // -----------------------------------------------------------------------

    private fun onBubbleTapped() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            // takeScreenshot() is API 30+. On older devices the overlay still works
            // but screenshot capture is unavailable — prompt the user to upgrade.
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

        // takeScreenshot is async; callback fires on the provided executor.
        takeScreenshot(
            Display.DEFAULT_DISPLAY,
            mainExecutor,
            object : TakeScreenshotCallback {
                override fun onSuccess(result: ScreenshotResult) {
                    // We receive a HardwareBuffer-backed bitmap. Convert to JPEG
                    // bytes on a background thread to avoid blocking the main thread.
                    Thread {
                        try {
                            val hardwareBitmap = result.hardwareBuffer
                                .let { Bitmap.wrapHardwareBuffer(it, null) }
                                ?: run {
                                    mainHandler.post { showToast("Screenshot capture failed") }
                                    return@Thread
                                }
                            // Hardware bitmaps cannot be compressed directly — copy to software.
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

    /**
     * Uploads the JPEG as multipart/form-data to POST /api/identify.
     * Runs entirely on the calling (background) thread.
     *
     * Multipart is built manually to avoid adding OkHttp as a dependency —
     * OkHttp is already in the app's classpath via React Native so this is safe,
     * but using HttpURLConnection keeps the module self-contained.
     */
    private fun uploadAndOpen(jpegBytes: ByteArray) {
        val endpointsList = mutableListOf<String>()
        if (API_BASE.isNotBlank() && !API_BASE.contains("10.0.2.2")) {
            endpointsList.add("$API_BASE/api/identify")
        }
        endpointsList.add("http://127.0.0.1:4000/api/identify")
        endpointsList.add("http://10.37.123.166:4000/api/identify")
        endpointsList.add("http://10.0.2.2:4000/api/identify")
        if (API_BASE.isNotBlank() && API_BASE.contains("10.0.2.2")) {
            endpointsList.add("$API_BASE/api/identify")
        }
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

    /**
     * Fires fit-stealer://job/<jobId> as a new-task Intent.
     *
     * FLAG_ACTIVITY_NEW_TASK is required because we're starting an Activity
     * from a Service context. The Expo app handles this deep link in its
     * Expo Router navigation stack (app/job/[id].tsx).
     */
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
            // Fallback: launch the app's main activity
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
