package dev.freeroute.app

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat

/**
 * 宿主 Activity：一个全屏 WebView，指向引擎在本机监听的 /freeroute/app/。
 *
 * 引擎进程由 EngineService 持有（前台服务），本 Activity 只负责显示与保活：
 * 即使 Activity 被销毁，服务仍在运行，API 端点持续可用。
 */
class MainActivity : AppCompatActivity() {

  private lateinit var root: FrameLayout
  private lateinit var web: WebView
  private lateinit var splash: LinearLayout
  private lateinit var splashStatus: TextView
  private val ui = Handler(Looper.getMainLooper())
  private var loadedPort = 0

  private val engineReceiver = object : BroadcastReceiver() {
    override fun onReceive(ctx: Context?, intent: Intent?) {
      when (intent?.action) {
        EngineService.ACTION_STATE -> {
          val state = intent.getStringExtra(EngineService.EXTRA_STATE) ?: ""
          val port = intent.getIntExtra(EngineService.EXTRA_PORT, 0)
          onEngineState(state, port)
        }
      }
    }
  }

  @SuppressLint("SetJavaScriptEnabled")
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    root = FrameLayout(this)
    root.setBackgroundColor(Color.parseColor("#0D1117"))

    web = WebView(this).apply {
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      setBackgroundColor(Color.parseColor("#0D1117"))
      settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        databaseEnabled = true
        cacheMode = WebSettings.LOAD_NO_CACHE
        loadWithOverviewMode = true
        useWideViewPort = true
        builtInZoomControls = false
        mediaPlaybackRequiresUserGesture = false
        mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
        // 引擎只在 127.0.0.1 上服务，同源即可，无需 file:// 权限
        allowFileAccess = false
        allowContentAccess = false
      }
      webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(
          view: WebView?, request: WebResourceRequest?
        ): WebResourceResponse? = null

        override fun onPageFinished(view: WebView?, url: String?) {
          if (url != null && url.contains("/freeroute/app")) showWeb()
        }
      }
      webChromeClient = object : WebChromeClient() {
        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
          Log.d(TAG, "webui: ${m.message()} @${m.lineNumber()}")
          return true
        }
      }
    }

    splash = buildSplash()
    root.addView(web)
    root.addView(splash)
    setContentView(root)

    ensureNotificationPermission()
    startEngine()
    registerEngineReceiver()
  }

  private fun buildSplash(): LinearLayout {
    val box = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = android.view.Gravity.CENTER
      setBackgroundColor(Color.parseColor("#0D1117"))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
      isClickable = true // 启动期间吞掉点击
    }
    box.addView(TextView(this).apply {
      text = "FreeRoute"
      setTextColor(Color.parseColor("#E6EDF3"))
      textSize = 22f
      letterSpacing = 0.06f
    })
    splashStatus = TextView(this).apply {
      text = "正在启动引擎…"
      setTextColor(Color.parseColor("#8B949E"))
      textSize = 12.5f
      setPadding(0, 24, 0, 0)
    }
    box.addView(splashStatus)
    return box
  }

  private fun startEngine() {
    val i = Intent(this, EngineService::class.java).setAction(EngineService.ACTION_START)
    ContextCompat.startForegroundService(this, i)
  }

  private fun registerEngineReceiver() {
    val f = IntentFilter(EngineService.ACTION_STATE)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      registerReceiver(engineReceiver, f, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      registerReceiver(engineReceiver, f)
    }
    // 服务可能已先于 Activity 就绪：主动查询一次当前状态
    onEngineState(EngineService.currentState, EngineService.currentPort)
  }

  private fun onEngineState(state: String, port: Int) {
    ui.post {
      when (state) {
        EngineService.STATE_READY -> {
          if (port > 0 && port != loadedPort) {
            loadedPort = port
            web.loadUrl("http://127.0.0.1:$port/freeroute/app/")
          } else if (port > 0) {
            showWeb()
          }
        }
        EngineService.STATE_STARTING -> splashStatus.text = "正在启动引擎…"
        EngineService.STATE_ERROR -> splashStatus.text = "引擎启动失败，请查看日志后重试"
        EngineService.STATE_STOPPED -> splashStatus.text = "引擎已停止"
      }
    }
  }

  private fun showWeb() {
    if (splash.visibility == View.VISIBLE) splash.visibility = View.GONE
  }

  private fun ensureNotificationPermission() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
        != PackageManager.PERMISSION_GRANTED) {
        requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 1)
      }
    }
  }

  override fun onDestroy() {
    try { unregisterReceiver(engineReceiver) } catch (_: Exception) {}
    // WebView 随 Activity 销毁，引擎服务保持运行
    if (::web.isInitialized) {
      (web.parent as? ViewGroup)?.removeView(web)
      web.destroy()
    }
    super.onDestroy()
  }

  companion object { private const val TAG = "FreeRoute" }
}
