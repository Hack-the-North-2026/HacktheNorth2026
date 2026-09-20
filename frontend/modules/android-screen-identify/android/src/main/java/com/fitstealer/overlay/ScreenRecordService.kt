package com.fitstealer.overlay

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.MediaRecorder
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.DisplayMetrics
import android.util.Log
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import java.io.File

class ScreenRecordService : Service() {

    companion object {
        private const val TAG = "FitStealer.Record"
        private const val CHANNEL_ID = "FitStealerRecordChannel"
        private const val NOTIFICATION_ID = 1002

        const val ACTION_INIT = "com.fitstealer.overlay.INIT"
        const val ACTION_START_RECORDING = "com.fitstealer.overlay.START_RECORDING"
        const val ACTION_STOP_RECORDING = "com.fitstealer.overlay.STOP_RECORDING"
        const val ACTION_RECORDING_FINISHED = "com.fitstealer.overlay.RECORDING_FINISHED"
        const val ACTION_CONSENT_GRANTED = "com.fitstealer.overlay.CONSENT_GRANTED"
        const val ACTION_CONSENT_DENIED = "com.fitstealer.overlay.CONSENT_DENIED"
        const val ACTION_RECORDING_FAILED = "com.fitstealer.overlay.RECORDING_FAILED"

        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_RESULT_DATA = "resultData"
        const val EXTRA_VIDEO_PATH = "videoPath"
    }

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var dummyImageReader: ImageReader? = null
    private var mediaRecorder: MediaRecorder? = null

    private var currentVideoPath: String? = null
    private var isRecording = false
    private var recordingStartTime = 0L

    private var screenDensity = 0
    private var screenWidth = 0
    private var screenHeight = 0

    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(
                NOTIFICATION_ID,
                createNotification("Ready to record"),
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
            )
        } else {
            startForeground(NOTIFICATION_ID, createNotification("Ready to record"))
        }

        updateScreenMetrics()
    }

    private fun updateScreenMetrics() {
        val metrics = DisplayMetrics()
        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        wm.defaultDisplay.getRealMetrics(metrics)
        screenDensity = metrics.densityDpi
        screenWidth = metrics.widthPixels
        if (screenWidth % 2 != 0) screenWidth--
        screenHeight = metrics.heightPixels
        if (screenHeight % 2 != 0) screenHeight--
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_INIT -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0)
                val resultData = intent.getParcelableExtra<Intent>(EXTRA_RESULT_DATA)
                if (resultCode != 0 && resultData != null) {
                    initMediaProjection(resultCode, resultData)
                }
            }
            ACTION_START_RECORDING -> {
                startRecording()
            }
            ACTION_STOP_RECORDING -> {
                stopRecording()
            }
        }
        return START_NOT_STICKY
    }

    private fun initMediaProjection(resultCode: Int, data: Intent) {
        if (mediaProjection != null && virtualDisplay != null) {
            Log.i(TAG, "MediaProjection already active with VirtualDisplay, notifying consent granted")
            sendBroadcast(Intent(ACTION_CONSENT_GRANTED).apply { setPackage(packageName) })
            return
        }

        cleanupProjection()

        val manager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        try {
            mediaProjection = manager.getMediaProjection(resultCode, data)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get MediaProjection", e)
            val failed = Intent(ACTION_RECORDING_FAILED).apply {
                setPackage(packageName)
                putExtra("error", "Permission token invalid: ${e.message}")
            }
            sendBroadcast(failed)
            return
        }

        if (mediaProjection == null) {
            Log.e(TAG, "getMediaProjection returned null")
            val failed = Intent(ACTION_RECORDING_FAILED).apply {
                setPackage(packageName)
                putExtra("error", "Could not obtain screen capture permission")
            }
            sendBroadcast(failed)
            return
        }

        // Android 14+ requires registering callback before createVirtualDisplay
        mediaProjection?.registerCallback(object : MediaProjection.Callback() {
            override fun onStop() {
                Log.i(TAG, "MediaProjection stopped by system")
                if (isRecording) stopRecording()
                cleanupProjection()
                val denied = Intent(ACTION_CONSENT_DENIED).apply { setPackage(packageName) }
                sendBroadcast(denied)
            }
        }, mainHandler)

        try {
            updateScreenMetrics()
            initDummyImageReader()

            virtualDisplay = mediaProjection?.createVirtualDisplay(
                "FitStealerScreen",
                screenWidth, screenHeight, screenDensity,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                dummyImageReader?.surface, null, null
            )
            Log.i(TAG, "VirtualDisplay created once with dummy surface (${screenWidth}x${screenHeight})")

            val granted = Intent(ACTION_CONSENT_GRANTED).apply { setPackage(packageName) }
            sendBroadcast(granted)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to create VirtualDisplay", e)
            cleanupProjection()
            val failed = Intent(ACTION_RECORDING_FAILED).apply {
                setPackage(packageName)
                putExtra("error", "Failed to create VirtualDisplay: ${e.message}")
            }
            sendBroadcast(failed)
        }
    }

    private fun initDummyImageReader() {
        dummyImageReader?.close()
        dummyImageReader = ImageReader.newInstance(screenWidth, screenHeight, PixelFormat.RGBA_8888, 2).apply {
            setOnImageAvailableListener({ reader ->
                try {
                    reader?.acquireLatestImage()?.close()
                } catch (_: Exception) {}
            }, mainHandler)
        }
    }

    private fun startRecording() {
        if (isRecording) {
            Log.w(TAG, "startRecording called but already recording")
            return
        }
        if (mediaProjection == null || virtualDisplay == null) {
            Log.w(TAG, "startRecording called but session not ready — requesting consent")
            val denied = Intent(ACTION_CONSENT_DENIED).apply { setPackage(packageName) }
            sendBroadcast(denied)
            return
        }

        try {
            updateScreenMetrics()
            initMediaRecorder()

            val recorderSurface = mediaRecorder?.surface
            if (recorderSurface == null) {
                throw IllegalStateException("MediaRecorder surface is null")
            }

            // Direct display rendering to mediaRecorder surface
            virtualDisplay?.setSurface(recorderSurface)

            mediaRecorder?.start()
            isRecording = true
            recordingStartTime = System.currentTimeMillis()
            Log.i(TAG, "Recording started into $currentVideoPath")

            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIFICATION_ID, createNotification("Recording screen..."))
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start recording", e)
            isRecording = false
            try { virtualDisplay?.setSurface(dummyImageReader?.surface) } catch (_: Exception) {}
            try { mediaRecorder?.reset() } catch (_: Exception) {}
            try { mediaRecorder?.release() } catch (_: Exception) {}
            mediaRecorder = null

            val failed = Intent(ACTION_RECORDING_FAILED).apply {
                setPackage(packageName)
                putExtra("error", e.message ?: "Failed to start recording")
            }
            sendBroadcast(failed)
        }
    }

    private fun stopRecording() {
        if (!isRecording) return
        var success = false
        val savedPath = currentVideoPath

        try {
            // Ensure minimum 1 second duration so MediaRecorder captures valid keyframes
            val elapsed = System.currentTimeMillis() - recordingStartTime
            if (elapsed < 1000) {
                try {
                    Thread.sleep(1000 - elapsed)
                } catch (_: Exception) {}
            }

            // Detach mediaRecorder surface by switching back to dummy surface BEFORE stopping
            try {
                virtualDisplay?.setSurface(dummyImageReader?.surface)
            } catch (e: Exception) {
                Log.w(TAG, "Could not restore dummy surface: ${e.message}")
            }

            mediaRecorder?.stop()
            Log.i(TAG, "Recording stopped, saved to $savedPath")
            success = true
        } catch (e: Exception) {
            Log.e(TAG, "Failed to stop recording", e)
        } finally {
            try { mediaRecorder?.reset() } catch (_: Exception) {}
            try { mediaRecorder?.release() } catch (_: Exception) {}
            mediaRecorder = null
            isRecording = false

            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIFICATION_ID, createNotification("Ready to record"))
        }

        if (success && savedPath != null) {
            val file = File(savedPath)
            if (file.exists() && file.length() > 2000) {
                val finishedIntent = Intent(ACTION_RECORDING_FINISHED).apply {
                    setPackage(packageName)
                    putExtra(EXTRA_VIDEO_PATH, savedPath)
                }
                sendBroadcast(finishedIntent)
            } else {
                Log.w(TAG, "Recorded file was too small (${file.length()} bytes)")
                val failed = Intent(ACTION_RECORDING_FAILED).apply {
                    setPackage(packageName)
                    putExtra("error", "Recorded video was empty")
                }
                sendBroadcast(failed)
            }
        }
    }

    @Suppress("DEPRECATION")
    private fun initMediaRecorder() {
        mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            MediaRecorder(this)
        } else {
            MediaRecorder()
        }

        val tempFile = File.createTempFile("fit_stealer_capture_", ".mp4", cacheDir)
        currentVideoPath = tempFile.absolutePath

        mediaRecorder?.apply {
            setVideoSource(MediaRecorder.VideoSource.SURFACE)
            setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            setVideoEncoder(MediaRecorder.VideoEncoder.H264)
            setVideoEncodingBitRate(6000000)
            setVideoFrameRate(30)
            setVideoSize(screenWidth, screenHeight)
            setOutputFile(currentVideoPath)
            prepare()
        }
    }

    private fun cleanupProjection() {
        try { virtualDisplay?.release() } catch (_: Exception) {}
        virtualDisplay = null
        try { dummyImageReader?.close() } catch (_: Exception) {}
        dummyImageReader = null
        try { mediaProjection?.stop() } catch (_: Exception) {}
        mediaProjection = null
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Screen Recording",
                NotificationManager.IMPORTANCE_LOW
            )
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun createNotification(contentText: String): Notification {
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_camera)
            .setContentTitle("Fit Stealer")
            .setContentText(contentText)
            .setOngoing(true)
            .build()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        super.onDestroy()
        if (isRecording) stopRecording()
        cleanupProjection()
    }
}
