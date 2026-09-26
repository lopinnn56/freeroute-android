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

  private fun versionStamp(ctx: Context): String {
    return try {
      val pi = ctx.packageManager.getPackageInfo(ctx.packageName, 0)
      "${pi.versionName}:${pi.longVersionCode}"
    } catch (_: Exception) {
      "unknown"
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
