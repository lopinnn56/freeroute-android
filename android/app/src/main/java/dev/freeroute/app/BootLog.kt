package dev.freeroute.app

import android.content.Context
import android.os.Build
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 启动日志：引擎冷启动各步骤的结果直接落到应用私有目录的 boot.log，
 * 由启动失败页面展示/复制——比 logcat 更易在真机上排查（无需 adb）。
 */
object BootLog {

  private var file: File? = null
  private val fmt = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

  @Synchronized
  fun init(ctx: Context) {
    val dir = File(ctx.filesDir, "home").apply { mkdirs() }
    file = File(dir, "boot.log")
    // 每次冷启动清一轮，只留本次启动的记录
    file?.writeText("")
    log("boot", "FreeRoute 启动 pid=${android.os.Process.myPid()} " +
      "android=${Build.VERSION.RELEASE}(api${Build.VERSION.SDK_INT}) " +
      "abi=${Build.SUPPORTED_ABIS.joinToString("/")}")
  }

  @Synchronized
  fun log(tag: String, msg: String) {
    val line = "${fmt.format(Date())} [$tag] $msg\n"
    try { file?.appendText(line) } catch (_: Exception) {}
  }

  fun lines(max: Int = 60): List<String> {
    return try {
      file?.readLines()?.takeLast(max) ?: emptyList()
    } catch (_: Exception) { emptyList() }
  }

  fun fullText(): String = lines(2000).joinToString("\n")
}
