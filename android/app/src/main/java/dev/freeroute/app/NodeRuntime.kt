package dev.freeroute.app

import android.util.Log

/**
 * nodejs-mobile 运行时桥接。
 *
 * APK 携带两个原生库：
 *   - libnode.so        —— nodejs-mobile 预编译的 Node 运行时。只导出 C++ 的
 *                          node::Start()，**不导出任何 JNI 符号**。经
 *                          System.loadLibrary("node") 以 dlopen 载入，不受
 *                          Android 10+ 对数据目录可执行文件的 W^X 限制。
 *   - libnode-engine.so —— 本项目的薄 JNI 桥（src/main/cpp/native-lib.cpp），
 *                          把 startNodeWithArguments 转成 node::Start(argc, argv)，
 *                          并把引擎 stdout/stderr 重定向进 logcat。
 *
 * 注意：startNodeWithArguments 是**阻塞**调用，Node 事件循环运行期间不返回，
 * 必须在独立线程中调用（EngineService 已如此处理）。返回值即 Node 退出码。
 */
object NodeRuntime {

  private const val TAG = "FreeRoute"

  @Volatile private var loaded = false
  @Volatile private var started = false

  /** 加载两个原生库；成功返回 true。重复调用幂等。 */
  @Synchronized
  fun ensureLoaded(): Boolean {
    if (loaded) return true
    return try {
      // 桥先载入（解析 DT_NEEDED 顺带拉进 libnode.so），再显式加载运行时
      System.loadLibrary("node-engine")
      System.loadLibrary("node")
      loaded = true
      Log.i(TAG, "libnode.so 与 JNI 桥已加载")
      true
    } catch (t: Throwable) {
      Log.e(TAG, "原生库加载失败：${t.message}", t)
      false
    }
  }

  /**
   * 在当前进程启动 Node（阻塞，直到事件循环结束）。
   * @param args argv，args[0] 惯例为 "node"，之后是入口脚本与参数（--home=… / --port=…）
   * @return Node 退出码；加载失败返回 -1
   */
  fun start(args: Array<String>): Int {
    if (!ensureLoaded()) return -1
    if (started) { Log.w(TAG, "Node 已在运行，忽略重复启动"); return -1 }
    started = true
    return try {
      startNodeWithArguments(args)
    } catch (t: Throwable) {
      Log.e(TAG, "Node 启动失败：${t.message}", t)
      -1
    } finally {
      started = false
    }
  }

  /**
   * 通过引擎 shutdown RPC 请求优雅停机（引擎侧 process.exit(0)，事件循环随之结束，
   * start() 返回，服务线程据此收尾）。放独立线程，避免在当前 Node 事件循环线程上
   * 再次发起回环请求造成死锁。
   */
  fun requestShutdown(port: Int) {
    if (port <= 0) return
    Thread({
      try {
        val c = java.net.URL("http://127.0.0.1:$port/freeroute/rpc").openConnection() as java.net.HttpURLConnection
        c.connectTimeout = 700; c.readTimeout = 700
        c.requestMethod = "POST"
        c.doOutput = true
        c.setRequestProperty("content-type", "application/json")
        c.outputStream.use { it.write("""{"method":"shutdown"}""".toByteArray()) }
        c.responseCode
        c.disconnect()
      } catch (_: Exception) {}
    }, "engine-shutdown").start()
  }

  // JNI 桥（native-lib.cpp）——符号名由 包名+类名+方法名 决定：
  // Java_dev_freeroute_app_NodeRuntime_startNodeWithArguments
  external fun startNodeWithArguments(arguments: Array<String>): Int
}