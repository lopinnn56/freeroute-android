package dev.freeroute.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.system.ErrnoException
import android.system.Os
import android.util.Log
import androidx.core.app.NotificationCompat
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 常驻前台服务：承载 Node 引擎。
 *
 * nodejs-mobile 以共享库形式把 Node 运行时加载进本应用进程（不 exec 外部二进制，
 * 因此不受 Android 10+ W^X 限制）。引擎的 HTTP 服务器监听 127.0.0.1:<port>，
 * 其它应用与 WebView 均可访问该 OpenAI 兼容端点。
 *
 * 启动的每一步都写入 BootLog（files/home/boot.log）——失败时 MainActivity
 * 直接展示并支持一键复制，无需连接电脑找 logcat。
 */
class EngineService : Service() {

  private lateinit var prefs: android.content.SharedPreferences
  private var wakeLock: PowerManager.WakeLock? = null
  private val running = AtomicBoolean(false)
  /** 用户主动停机标记：避免 Node 优雅退出后 boot 线程把它当崩溃重启 */
  private val stopping = AtomicBoolean(false)
  private var restartCount = 0
  private var port = 0

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    BootLog.init(this)
    BootLog.log("service", "EngineService.onCreate")
    createChannel()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_STOP -> {
        BootLog.log("service", "收到停止指令")
        stopping.set(true)
        stopEngine()
        stopSelf()
        return START_NOT_STICKY
      }
      else -> startEngine()
    }
    return START_STICKY
  }

  private fun startEngine() {
    if (!running.compareAndSet(false, true)) return
    stopping.set(false)
    BootLog.log("boot", "开始启动引擎（第 ${restartCount + 1} 次尝试）")
    startForeground(NOTIF_ID, buildNotification("正在启动引擎…", null))
    acquireWakeLock()
    publish(STATE_STARTING, 0)

    Thread({
      try {
        val projectDir = AssetInstaller.install(this)
        BootLog.log("assets", "引擎资源已释放: ${projectDir.absolutePath}")

        port = prefs.getInt(PREF_PORT, DEFAULT_PORT)
        val home = File(filesDir, "home").apply { mkdirs() }
        BootLog.log("boot", "数据目录: ${home.absolutePath}  端口: $port")

        // Node 读取的是进程环境：HOME/TMPDIR 用 Os.setenv 落进进程，
        // 与 --home/--port 命令行参数互为冗余（nodejs-mobile 官方写法）。
        try {
          Os.setenv("HOME", home.absolutePath, true)
          Os.setenv("TMPDIR", cacheDir.absolutePath, true)
          Os.setenv("PATH", "/system/bin:/system/xbin", true)
          BootLog.log("boot", "环境变量已设置 (HOME=$home)")
        } catch (e: ErrnoException) {
          BootLog.log("boot", "Os.setenv 失败: ${e.message}")
          Log.w(TAG, "Os.setenv 失败，依赖 --home 参数", e)
        }

        val entry = File(projectDir, "engine/start.mjs")
        if (!entry.isFile) {
          fail("引擎入口缺失: ${entry.absolutePath}")
          return@Thread
        }
        BootLog.log("boot", "入口脚本就位: ${entry.absolutePath}")

        // 先确认两个原生库能否加载（libnode.so + JNI 桥）——加载失败是最常见病因
        BootLog.log("native", "加载 libnode.so / node-engine…")
        if (!NodeRuntime.ensureLoaded()) {
          fail("原生库加载失败（见上方 native 日志）")
          return@Thread
        }
        BootLog.log("native", "原生库加载成功")

        // startNodeWithArguments 会阻塞到 Node 事件循环结束，因此在旁路线程
        // 轮询健康检查，就绪后广播给 UI 并更新通知。
        BootLog.log("node", "启动 Node: ${entry.absolutePath}")
        Thread({ awaitReady() }, "engine-ready").start()

        val rc = NodeRuntime.start(arrayOf(
          "node", entry.absolutePath, "--home=${home.absolutePath}", "--port=$port"
        ))
        BootLog.log("node", "Node 事件循环结束，退出码 rc=$rc stopping=${stopping.get()}")

        running.set(false)
        if (stopping.get()) {
          BootLog.log("boot", "已主动停机，不再重启")
          return@Thread
        }
        if (restartCount < MAX_RESTARTS) {
          restartCount++
          val delay = (1000L shl (restartCount - 1)).coerceAtMost(30_000L)
          BootLog.log("boot", "引擎退出，${delay}ms 后重启（第 $restartCount 次）")
          android.os.Handler(android.os.Looper.getMainLooper())
            .postDelayed({ if (!running.get()) startEngine() }, delay)
        } else {
          fail("引擎反复退出（rc=$rc），已停止自动重启")
        }
      } catch (t: Throwable) {
        Log.e(TAG, "引擎启动异常", t)
        fail("引擎启动异常: ${t.message}")
      }
    }, "engine-boot").start()
  }

  /** 轮询健康检查，就绪后更新通知并广播给 UI */
  private fun awaitReady() {
    val deadline = System.currentTimeMillis() + READY_TIMEOUT_MS
    var lastErr = ""
    while (System.currentTimeMillis() < deadline) {
      if (stopping.get()) return
      if (healthOk(port)) {
        restartCount = 0
        BootLog.log("ready", "健康检查通过: http://127.0.0.1:$port/freeroute/health")
        notify(buildNotification("引擎运行中 · 端口 $port", port))
        publish(STATE_READY, port)
        Log.i(TAG, "引擎就绪: http://127.0.0.1:$port/freeroute/v1")
        return
      }
      Thread.sleep(250)
      if (lastErr.isBlank()) lastErr = "端口 $port 无响应"
    }
    fail("引擎在 ${READY_TIMEOUT_MS / 1000}s 内未就绪（$lastErr）")
  }

  private fun healthOk(p: Int): Boolean = try {
    val c = URL("http://127.0.0.1:$p/freeroute/health").openConnection() as HttpURLConnection
    c.connectTimeout = 800
    c.readTimeout = 800
    c.requestMethod = "GET"
    val ok = c.responseCode == 200
    c.disconnect()
    ok
  } catch (_: Exception) { false }

  private fun stopEngine() {
    running.set(false)
    stopping.set(true)
    BootLog.log("boot", "请求引擎优雅退出…")
    // 请求引擎优雅退出：Node 事件循环结束后 start() 返回，boot 线程据此收尾。
    // libnode 是共享库，没有独立进程可 kill，只能走回环 RPC 触发 process.exit()。
    try { NodeRuntime.requestShutdown(port) } catch (_: Exception) {}
    releaseWakeLock()
    publish(STATE_STOPPED, 0)
  }

  private fun fail(msg: String) {
    BootLog.log("boot", "【失败】$msg")
    Log.e(TAG, msg)
    running.set(false)
    notify(buildNotification(msg, null))
    publish(STATE_ERROR, 0)
  }

  // ---------- 通知 ----------
  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val nm = getSystemService(NotificationManager::class.java)
      if (nm.getNotificationChannel(CHANNEL_ID) == null) {
        nm.createNotificationChannel(NotificationChannel(
          CHANNEL_ID, getString(R.string.notif_channel_name), NotificationManager.IMPORTANCE_LOW
        ).apply { description = getString(R.string.notif_channel_desc) })
      }
    }
  }

  private fun buildNotification(text: String, p: Int?): Notification {
    val open = PendingIntent.getActivity(
      this, 0, Intent(this, MainActivity::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
    val builder = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_sys_upload_done)
      .setContentTitle(getString(R.string.notif_title))
      .setContentText(text)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setContentIntent(open)
      .setPriority(NotificationCompat.PRIORITY_LOW)
    if (p != null) {
      builder.addAction(0, "复制端点", PendingIntent.getActivity(
        this, 1,
        Intent(this, MainActivity::class.java).putExtra("copy_endpoint", "http://127.0.0.1:$p/freeroute/v1"),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
    }
    return builder.build()
  }

  private fun notify(n: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) !=
      android.content.pm.PackageManager.PERMISSION_GRANTED) return
    (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIF_ID, n)
  }

  private fun publish(state: String, p: Int) {
    currentState = state
    currentPort = p
    sendBroadcast(Intent(ACTION_STATE)
      .setPackage(packageName)
      .putExtra(EXTRA_STATE, state)
      .putExtra(EXTRA_PORT, p))
  }

  // ---------- 保活 ----------
  private fun acquireWakeLock() {
    if (wakeLock != null) return
    val pm = getSystemService(POWER_SERVICE) as PowerManager
    wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FreeRoute::engine").apply {
      setReferenceCounted(false)
      acquire()
    }
  }

  private fun releaseWakeLock() {
    try { wakeLock?.release() } catch (_: Exception) {}
    wakeLock = null
  }

  override fun onDestroy() {
    releaseWakeLock()
    publish(STATE_STOPPED, 0)
    super.onDestroy()
  }

  companion object {
    private const val TAG = "FreeRoute"
    private const val CHANNEL_ID = "freeroute-engine"
    private const val NOTIF_ID = 0x4652
    private const val PREFS = "freeroute"
    private const val PREF_PORT = "port"
    private const val DEFAULT_PORT = 8787
    private const val MAX_RESTARTS = 5
    private const val READY_TIMEOUT_MS = 20_000L

    const val ACTION_START = "dev.freeroute.app.START"
    const val ACTION_STOP = "dev.freeroute.app.STOP"
    const val ACTION_STATE = "dev.freeroute.app.STATE"
    const val EXTRA_STATE = "state"
    const val EXTRA_PORT = "port"

    const val STATE_STARTING = "starting"
    const val STATE_READY = "ready"
    const val STATE_ERROR = "error"
    const val STATE_STOPPED = "stopped"

    @Volatile var currentState: String = STATE_STOPPED
      private set
    @Volatile var currentPort: Int = 0
      private set
  }
}
