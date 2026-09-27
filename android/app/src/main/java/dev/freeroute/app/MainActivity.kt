package dev.freeroute.app

import android.annotation.SuppressLint
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.text.method.ScrollingMovementMethod
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import java.io.File

/**
 * 宿主 Activity：一个全屏 WebView，指向引擎在本机监听的 /freeroute/app/。
 *
 * 引擎进程由 EngineService 持有（前台服务），本 Activity 只负责显示与保活：
 * 即使 Activity 被销毁，服务仍在运行，API 端点持续可用。
 *
 * 引擎启动失败时（STATE_ERROR），启动页直接展示 BootLog（boot.log）内容，
 * 并提供「复制日志」「重试」按钮——不用连电脑找 logcat。
 */
class MainActivity : AppCompatActivity() {

  private lateinit var root: FrameLayout
  private lateinit var web: WebView
  private lateinit var splash: LinearLayout
  private lateinit var splashStatus: TextView
  private lateinit var logScroll: ScrollView
  private lateinit var logView: TextView
  private lateinit var btnRow: LinearLayout
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
        allowFileAccess = false
        allowContentAccess = false
      }
      webViewClient = object : WebViewClient() {
        override fun onPageFinished(view: WebView?, url: String?) {
          if (url != null && url.contains("/freeroute/app")) showWeb()
        }
        // 「申请 Key」等外链：WebUI 用 freeroute://open?url=… 触发，
        // 这里拦截后用系统默认浏览器打开（避免 WebView 内嵌外部网站）。
        override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
          val u = request?.url ?: return false
          if (u.scheme == "freeroute" && u.host == "open") {
            val target = u.getQueryParameter("url")
            if (target != null && target.isNotEmpty()) {
              try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(target))
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                startActivity(intent)
              } catch (e: Exception) {
                Log.e(TAG, "无法打开外部浏览器: $target", e)
              }
            }
            return true
          }
          return false
        }
      }
    }
    // 下载拦截：WebUI 的「导出配置」跳转到真实 HTTP URL（/freeroute/config/export），
    // 这里拦截下载，写入应用专属下载目录，Toast 提示完整路径（用户可直接找到）。
    // this 在这里指 MainActivity（onCreate 作用域）。
    web.setDownloadListener { url, _, _, _, _ ->
      try {
        val dir = File(getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), "freeroute")
        if (!dir.exists()) dir.mkdirs()
        val fileName = if (url.contains("config/export")) "freeroute-config.json"
          else Uri.parse(url).lastPathSegment?.takeLast(60) ?: ("freeroute-" + System.currentTimeMillis() + ".json")
        val dest = File(dir, fileName)
        // 后台线程拉取并落盘
        Thread {
          try {
            val conn = (java.net.URL(url).openConnection() as java.net.HttpURLConnection)
            conn.connectTimeout = 10000
            conn.readTimeout = 30000
            conn.inputStream.use { input ->
              dest.outputStream().use { output -> input.copyTo(output, 64 * 1024) }
            }
            runOnUiThread {
              Toast.makeText(this@MainActivity, "已保存: ${dest.absolutePath}", Toast.LENGTH_LONG).show()
              Log.i(TAG, "配置导出完成: ${dest.absolutePath}")
            }
          } catch (e: Exception) {
            Log.e(TAG, "配置导出下载失败: $url", e)
          }
        }.start()
      } catch (e: Exception) {
        Log.e(TAG, "下载拦截失败: $url", e)
      }
    }
    web.webChromeClient = object : WebChromeClient() {
        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
          Log.d(TAG, "webui: ${m.message()} @${m.lineNumber()}")
          return true
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
      gravity = Gravity.CENTER
      setBackgroundColor(Color.parseColor("#0D1117"))
      layoutParams = FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
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
      setPadding(0, dp(24), 0, 0)
    }
    box.addView(splashStatus)

    // 日志区：失败时显示 boot.log（占满中间空间，可滚动）
    logScroll = ScrollView(this).apply {
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
      visibility = View.GONE
      setPadding(dp(16), dp(12), dp(16), dp(4))
    }
    logView = TextView(this).apply {
      setTextColor(Color.parseColor("#8B949E"))
      textSize = 11f
      typeface = android.graphics.Typeface.MONOSPACE
      movementMethod = ScrollingMovementMethod()
    }
    logScroll.addView(logView)
    box.addView(logScroll)

    // 按钮行：复制日志 / 重试
    btnRow = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL
      gravity = Gravity.CENTER
      visibility = View.GONE
      layoutParams = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
      setPadding(dp(16), dp(4), dp(16), dp(24))
    }
    btnRow.addView(button("复制日志") { copyLog() })
    btnRow.addView(button("重试") { retryEngine() })
    box.addView(btnRow)
    return box
  }

  private fun button(label: String, onClick: () -> Unit): TextView {
    val b = TextView(this).apply {
      text = label
      setTextColor(Color.parseColor("#58A6FF"))
      textSize = 13f
      gravity = Gravity.CENTER
      setPadding(dp(18), dp(10), dp(18), dp(10))
      val bg = android.graphics.drawable.GradientDrawable().apply {
        setColor(Color.parseColor("#161B22"))
        setStroke(dp(1), Color.parseColor("#30363D"))
        cornerRadius = dp(5).toFloat()
      }
      background = bg
      setOnClickListener { onClick() }
    }
    val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
    lp.setMargins(dp(4), dp(8), dp(4), dp(8))
    b.layoutParams = lp
    return b
  }

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

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
        EngineService.STATE_STARTING -> {
          splashStatus.text = "正在启动引擎…"
          logScroll.visibility = View.GONE
          btnRow.visibility = View.GONE
        }
        EngineService.STATE_ERROR -> showBootLog()
        EngineService.STATE_STOPPED -> splashStatus.text = "引擎已停止"
      }
    }
  }

  private fun showBootLog() {
    splashStatus.text = "引擎启动失败，原因如下："
    val lines = BootLog.lines(120)
    logView.text = if (lines.isEmpty()) "(boot.log 为空)" else lines.joinToString("\n")
    logScroll.visibility = View.VISIBLE
    btnRow.visibility = View.VISIBLE
  }

  private fun copyLog() {
    val txt = BootLog.fullText()
    (getSystemService(CLIPBOARD_SERVICE) as ClipboardManager)
      .setPrimaryClip(ClipData.newPlainText("freeroute boot.log", txt))
    Toast.makeText(this, "日志已复制（${txt.lines().size} 行），发给我即可定位问题", Toast.LENGTH_LONG).show()
  }

  private fun retryEngine() {
    Toast.makeText(this, "正在重新启动引擎…", Toast.LENGTH_SHORT).show()
    try { stopService(Intent(this, EngineService::class.java)) } catch (_: Exception) {}
    ui.postDelayed({ startEngine() }, 800)
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
    if (::web.isInitialized) {
      (web.parent as? ViewGroup)?.removeView(web)
      web.destroy()
    }
    super.onDestroy()
  }

  companion object { private const val TAG = "FreeRoute" }
}
