package dev.freeroute.app

import android.content.Context
import android.util.Log
import java.io.File
import java.io.FileOutputStream

/**
 * 把 APK 内 assets/nodejs-project 释放到应用私有目录。
 *
 * 首次安装或 APK 版本变化时整体重放（引擎代码随 APK 更新），
 * 用户数据（~/.freeroute、~/.dsh/freeroute.json）位于同级目录，
 * 不在 nodejs-project 内，因此升级不会覆盖配置与密钥。
 */
object AssetInstaller {

  private const val TAG = "FreeRoute"
  const val PROJECT_DIR = "nodejs-project"

  /** 返回释放后的项目根目录绝对路径 */
  fun install(ctx: Context): File {
    val dest = File(ctx.filesDir, PROJECT_DIR)
    val stamp = File(ctx.filesDir, ".nodejs-project.stamp")
    val want = versionStamp(ctx)

    if (dest.isDirectory && stamp.isFile() && stamp.readText().trim() == want) {
      return dest
    }

    Log.i(TAG, "释放引擎资源 -> ${dest.absolutePath} (stamp=$want)")
    if (dest.exists()) dest.deleteRecursively()
    dest.mkdirs()
    copyAssetTree(ctx, PROJECT_DIR, dest)
    stamp.writeText(want)
    return dest
  }

  /**
   * 资源版本戳：对 assets 内全部文件的内容做哈希。
   * 此前用 versionName:versionCode——两个版本号长期不变，导致装了新 APK
   * 也不重新释放 assets，App 一直跑旧 WebUI/引擎（"改了没生效"的根因）。
   * 改为内容哈希后，任何一次构建的任何文件变化都会触发重新释放。
   */
  private fun versionStamp(ctx: Context): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    fun hashTree(assetPath: String) {
      val children = ctx.assets.list(assetPath) ?: return
      if (children.isEmpty()) {
        ctx.assets.open(assetPath).use { input ->
          val buf = ByteArray(64 * 1024)
          while (true) {
            val n = input.read(buf)
            if (n <= 0) break
            digest.update(buf, 0, n)
          }
        }
        digest.update(assetPath.toByteArray())
        return
      }
      for (name in children.sorted()) hashTree("$assetPath/$name")
    }
    return try {
      hashTree(PROJECT_DIR)
      digest.digest().joinToString("") { "%02x".format(it) }
    } catch (_: Exception) {
      // 无法读 assets 时退回包版本号
      try {
        val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
        "${pi.versionName}:${pi.longVersionCode}"
      } catch (e2: Exception) { "unknown" }
    }
  }

  private fun copyAssetTree(ctx: Context, assetPath: String, dest: File) {
    val children = ctx.assets.list(assetPath) ?: emptyArray()
    if (children.isEmpty()) {
      // 叶子：普通文件
      dest.parentFile?.mkdirs()
      ctx.assets.open(assetPath).use { input ->
        FileOutputStream(dest).use { output -> input.copyTo(output, 64 * 1024) }
      }
      return
    }
    dest.mkdirs()
    for (name in children) copyAssetTree(ctx, "$assetPath/$name", File(dest, name))
  }
}
