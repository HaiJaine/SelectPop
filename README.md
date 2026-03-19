# SelectPop

SelectPop 是一个面向 Windows 的便携式划词工具条应用。它基于 Electron 主进程与原生 helper 协作工作，在选中文本后弹出一个轻量工具条，支持复制、发送快捷键、打开 URL，以及调用 AI 服务进行翻译。

## 项目简介与核心能力

- 选中文本后弹出工具条，减少重复复制、搜索和跳转操作
- 内置复制工具，并支持自定义快捷键工具、URL 工具和 AI 翻译工具
- 支持多个 AI 提供商配置、代理设置和高级请求参数
- 提供 WebDAV 配置同步，方便多设备共享工具与大部分设置
- 以便携目录运行，数据、日志和缓存默认都保存在程序目录旁
- 支持通过注册表写入 `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` 实现当前用户级开机自启

## 架构与运行方式概览

SelectPop 由三部分组成：

1. Electron 主进程  
   负责托盘、设置窗口、配置管理、WebDAV 同步、AI 请求调度和工具执行。

2. 原生 helper  
   位于 `native/`，负责更贴近 Windows 桌面环境的取词、热键和诊断能力。

3. 便携数据目录  
   打包版会把运行数据写到可执行文件同级的 `data/` 目录；开发模式默认写到项目根目录下的 `.dev-portable/`。

## 环境要求

- Windows 10/11 x64
- Node.js `>= 18`
- npm
- CMake
- MinGW-w64
- PowerShell

当前仓库内置的原生编译脚本默认假定 MinGW 安装在：

```text
C:\dev_env\mingw64
```

如果你的环境路径不同，需要修改 [`scripts/build-native.mjs`](scripts/build-native.mjs) 里的 `mingwBin`、`CMAKE_C_COMPILER` 和 `CMAKE_CXX_COMPILER`。

## 从源码安装与启动

安装依赖：

```bash
npm install
```

编译原生 helper：

```bash
npm run build:native
```

启动开发版：

```bash
npm run dev
```

首次开发启动后，程序会在项目根目录创建：

```text
.dev-portable/
```

其中包含配置、日志、会话数据和缓存。

## 原生 helper 编译说明

原生部分源码位于 [`native/src/main.cpp`](native/src/main.cpp)，构建脚本位于 [`scripts/build-native.mjs`](scripts/build-native.mjs)。

构建脚本会执行以下流程：

1. 使用 CMake 生成 `MinGW Makefiles`
2. 编译 `selectpop-native-helper.exe`
3. 将运行时依赖 `libwinpthread-1.dll` 复制到 `native/bin/`

如果构建失败，优先检查：

- MinGW 是否安装在脚本假定的位置
- `cmake`、`gcc`、`g++` 是否可用
- `libwinpthread-1.dll` 是否存在于 `C:\dev_env\mingw64\bin`

## 开发调试

常用命令：

```bash
npm run dev
npm test
```

测试目前覆盖：

- WebDAV 同步冲突、备份、队列重试和共享字段判断
- 注册表开机自启的读写与幂等对齐逻辑

日志目录：

- 开发模式：`./.dev-portable/data/logs/`
- 打包便携版：`<SelectPop.exe 同级目录>/data/logs/`

如果原生 helper 启动失败，可重点查看：

```text
startup.log
```

## 便携版打包与产物说明

仅生成 Electron Portable 可执行文件：

```bash
npm run pack:portable
```

生成带 ZIP 的便携包：

```bash
npm run dist:portable
```

这条命令会先执行 `npm run pack:portable`，成功生成便携版 EXE 后，再自动执行 `node scripts/zip-portable.mjs` 生成 ZIP，不需要再手动补跑 Node 命令。

校验便携产物是否齐全：

```bash
npm run smoke:portable
```

主要产物：

- `dist/build/SelectPop.exe`
- `dist/SelectPop-portable.zip`

## 首次使用流程

1. 启动程序后，双击托盘图标或从托盘菜单进入“设置”
2. 在“工具管理”里确认要显示在工具条上的工具
3. 在“划词设置”里选择触发模式、黑白名单和工具条偏移
4. 如果要使用 AI 翻译，先在“AI 提供商”中配置服务地址、模型和 API Key
5. 返回“工具管理”，创建或编辑一个 `AI 翻译` 工具并绑定提供商
6. 如需多设备共享配置，再到 “WebDAV 同步” 填写同步地址和凭据

## 工具配置、AI 提供商、划词模式、WebDAV、自启说明

### 工具配置

- `复制`：内置工具，始终保留
- `快捷键`：把选中文本后的动作映射为一组按键
- `URL 工具`：把选中文本填入 URL 模板并用指定浏览器打开
- `AI 翻译`：把选中文本发给一个或多个 AI 提供商

### AI 提供商

AI 提供商配置支持：

- 自定义 `base_url`
- 自定义 `model`
- API Key
- 请求超时
- 代理模式
- 高级 JSON 请求参数
- 自定义系统提示词

### 划词模式

当前支持：

- `auto`
- `ctrl`
- `hotkey`
- `disabled`

不同模式的详细说明可以直接在设置页中查看。

### WebDAV 同步

WebDAV 同步用于共享配置本身，不用于共享秘密。

- 会共享：工具、AI 提供商、选择模式、`startup.launch_on_boot` 等共享偏好
- 不会共享：WebDAV 用户名、密码、同步状态字段、窗口位置等本机专属信息

这意味着：

- A 设备启用 WebDAV 并同步后，B 设备会收到同步目标和共享配置
- 但 B 设备仍需单独填写本机的 WebDAV 用户名和密码
- 在本机凭据缺失时，自动同步会暂停，手动测试或同步会给出明确提示

### 开机自启

开机自启开关会作为共享偏好同步；当配置被应用到新设备时，程序会自动尝试把当前设备的启动项写入：

```text
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
```

值名固定为：

```text
SelectPop
```

如果当前设备的注册表写入失败，配置仍会保留，并在后续启动时继续重试。

## 数据目录与日志位置

便携版目录结构示意：

```text
SelectPop.exe
data/
  logs/
  session/
  cache/
```

其中：

- `data/logs/`：日志
- `data/session/`：Electron 会话数据
- `data/cache/`：缓存

AI 缓存和图标缓存会继续位于 `data/cache/` 下的子目录中。

## 常见问题与排障

### 启动后没有弹出工具条

优先检查：

- 当前是否选择了受支持的文本
- 是否在“划词设置”里把模式设为了 `disabled`
- 黑名单或高风险禁用项是否屏蔽了当前程序
- 原生 helper 是否启动失败

### AI 翻译没有返回结果

优先检查：

- 提供商配置是否正确
- API Key 是否有效
- 模型名称是否存在
- 代理是否配置正确

### WebDAV 已启用但没有自动同步

优先检查：

- 当前设备是否已经填写 WebDAV 地址、用户名和密码
- 远端路径是否正确
- 最近同步状态和最近错误信息是否有提示

### 开机自启开关是开的，但系统启动后没有跟着启动

优先检查：

- 当前用户是否有权限写入 `HKCU\...\Run`
- 程序是否被移动到新的目录，导致旧路径失效
- 是否在日志中出现启动项写入失败信息

### A JavaScript error occurred in the main process

优先执行：

```bash
node --check main/main.js
```

如果这里直接报语法错误，先修复主进程脚本，再重新打包。

### `npm run dist:portable` 没有生成 ZIP

优先检查：

- `npm run pack:portable` 是否已经成功完成
- `dist/build/SelectPop.exe` 是否已经生成
- 如果 `electron-builder` 阶段失败，ZIP 脚本不会继续执行，因此不会产出 `dist/SelectPop-portable.zip`

---

如果你准备将本项目继续扩展为开源版本，建议优先补充：

- CI 构建与自动化测试
- 发布版本号与变更日志
- 英文 README
- Windows 以外平台的能力边界说明
