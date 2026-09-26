cmake_minimum_required(VERSION 3.22.1)
project(node-engine)

# 宿主 JNI 桥：把 Java 调用转成 node::Start()（见 native-lib.cpp）
add_library(node-engine SHARED native-lib.cpp)

# nodejs-mobile C 头文件（CI 下载 release zip 后解压到 android/app/libnode/include/node）
# 从本文件所在 cpp/ 上溯三级即到 android/app/，再进 libnode/include/node
include_directories(${CMAKE_SOURCE_DIR}/../../../libnode/include/node)

# 预编译 libnode.so（CI 下载 release zip 后放到 src/main/jniLibs/<abi>/libnode.so）。
# 桥只做链接用；APK 里该 .so 同时被 System.loadLibrary("node") 加载。
add_library(libnode SHARED IMPORTED)
set_target_properties(libnode PROPERTIES
        IMPORTED_LOCATION
        ${CMAKE_SOURCE_DIR}/../jniLibs/${ANDROID_ABI}/libnode.so)

find_library(log-lib log)
target_link_libraries(node-engine libnode ${log-lib})