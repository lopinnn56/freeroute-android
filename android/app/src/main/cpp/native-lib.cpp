// FreeRoute Node 引擎 JNI 桥
//
// nodejs-mobile 的 libnode.so 只导出 C++ 的 node::Start(argc, argv)，不导出任何
// JNI 符号。本文件是对接层：
//   1. 把 Java 的 String[] argv 转成 libuv 要求的连续内存布局，调 node::Start()；
//   2. 把 stdout/stderr 重定向进 logcat（nodejs-mobile 不会自动做这件事）。
//
// JNI 符号名由包名 + 类名 + 方法名决定，必须与 NodeRuntime.kt 中声明的
// external fun 精确对应：Java_dev_freeroute_app_NodeRuntime_startNodeWithArguments

#include <jni.h>
#include <cstring>
#include <cstdlib>
#include <node.h>
#include <pthread.h>
#include <unistd.h>
#include <android/log.h>

static const char* ADBTAG = "FREEROUTE-NODE";
static int pipe_stdout[2];
static int pipe_stderr[2];
static pthread_t thread_stdout;
static pthread_t thread_stderr;

static void* thread_stdout_func(void*) {
  ssize_t redirect_size;
  char buf[2048];
  while ((redirect_size = read(pipe_stdout[0], buf, sizeof buf - 1)) > 0) {
    if (buf[redirect_size - 1] == '\n') --redirect_size;
    buf[redirect_size] = 0;
    __android_log_write(ANDROID_LOG_INFO, ADBTAG, buf);
  }
  return nullptr;
}

static void* thread_stderr_func(void*) {
  ssize_t redirect_size;
  char buf[2048];
  while ((redirect_size = read(pipe_stderr[0], buf, sizeof buf - 1)) > 0) {
    if (buf[redirect_size - 1] == '\n') --redirect_size;
    buf[redirect_size] = 0;
    __android_log_write(ANDROID_LOG_ERROR, ADBTAG, buf);
  }
  return nullptr;
}

static int start_redirecting_stdout_stderr() {
  setvbuf(stdout, nullptr, _IONBF, 0);
  pipe(pipe_stdout);
  dup2(pipe_stdout[1], STDOUT_FILENO);
  setvbuf(stderr, nullptr, _IONBF, 0);
  pipe(pipe_stderr);
  dup2(pipe_stderr[1], STDERR_FILENO);
  pthread_create(&thread_stdout, nullptr, thread_stdout_func, nullptr);
  pthread_detach(thread_stdout);
  pthread_create(&thread_stderr, nullptr, thread_stderr_func, nullptr);
  pthread_detach(thread_stderr);
  return 0;
}

extern "C" JNIEXPORT jint JNICALL
Java_dev_freeroute_app_NodeRuntime_startNodeWithArguments(
    JNIEnv* env, jobject /* thiz */, jobjectArray arguments) {
  jsize argument_count = env->GetArrayLength(arguments);

  // libuv 要求 argv 的所有字符串存放在连续内存里
  int c_arguments_size = 0;
  for (int i = 0; i < argument_count; i++) {
    jstring arg = (jstring)env->GetObjectArrayElement(arguments, i);
    const char* s = env->GetStringUTFChars(arg, nullptr);
    c_arguments_size += (int)strlen(s) + 1;
    env->ReleaseStringUTFChars(arg, s);
  }

  char* args_buffer = (char*)calloc((size_t)c_arguments_size, sizeof(char));
  char* argv[argument_count];
  char* current = args_buffer;

  for (int i = 0; i < argument_count; i++) {
    jstring arg = (jstring)env->GetObjectArrayElement(arguments, i);
    const char* s = env->GetStringUTFChars(arg, nullptr);
    strncpy(current, s, strlen(s));
    argv[i] = current;
    current += strlen(current) + 1;
    env->ReleaseStringUTFChars(arg, s);
  }

  start_redirecting_stdout_stderr();
  return jint(node::Start(argument_count, argv));
}