# CTViewer Android 工程（已停用）

> 2026-11-27：项目只做**本地开发**，不发布、不分发、不再提供任何安装包。
> 原先签好的 `build/CTViewer-2.0.0.apk`（23 MB）与 `lib/d8.jar`（15 MB 构建工具）已删除；
> 浏览器直接打开 `http://127.0.0.1:8030` 即可。这个 WebView 壳工程仅作历史存档。

## 保留的文件

- `AndroidManifest.xml`：`com.dsh.ctviewer`，应用名 CTViewer，最低 API 24
- `src/com/dsh/ctviewer/MainActivity.java`：全屏 WebView，启动本地虚拟域名 `https://appassets.local`
- `res/`：应用图标与名称
- `build.sh`：原一键打包脚本（需要 Android SDK + d8.jar 才能跑）

## 说明

- 本机没有 Android SDK，`build.sh` 跑不通，也不需要跑通。
- `android/build.sh` 只拷贝 `assets/models/`，不含人物、动作、车库道具与城市；
  即使重新打包也不包含当前内容，不要把它当作运行路径。
