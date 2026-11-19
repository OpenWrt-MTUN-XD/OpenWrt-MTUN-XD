# MTUN-XD Agent Guide

本文件是仓库级持久约定。仓库中的更具体 `AGENTS.md`（如有）优先于本文件。

## 项目目标

MTUN-XD 是一个 OpenWrt / iStoreOS 管理套件，把以下内容整合进 LuCI「服务 → MTUN-XD」：

- Mihomo 核心
- MetaCubeXD 官方面板
- 浏览器端配置生成器
- 核心 / 面板 / 控制台安装、升级、卸载与 80 端口接入

核心和面板不随包发布，安装时从 GitHub Release 获取，并校验官方 SHA-256。

## 开始工作前

- 先看 `git status --short --branch`，保留用户已有的未提交改动。
- 版本号唯一来源：`generator/app/state.js` 的 `APP_VERSION`。
- 先读 `README.md`、`CHANGELOG.md` 和相关文件头部注释；本项目大量约定写在源码注释里。
- 默认使用中文回复。用户要求“直接做”时，正常范围内的诊断、修改、测试、发布和真机验证应直接执行。
- 不要把不同路由器混为一谈。涉及真机时必须明确目标 IP / 域名、固件版本和当前连接方式。

## 目录与事实来源

- `package/`：打进套件的文件。
- `control/`：apk/opkg 生命周期脚本。
- `install.sh`：官方安装 / 修复 / 升级入口。
- `build.py`：ipk/apk、dist、Release 构建。
- `deploy/`：随包的 nginx / HAProxy 80 端口适配脚本。
- `generator/`：配置生成器源码和测试，GPL-3.0。
- `dist/`：自动发布产物，**不要手工编辑**。
- `tests/test_package.py`：打包、安装脚本、输出约定和发布一致性自检。

仓库按目录分许可：套件本体 MIT，`generator/` GPL-3.0。

## 常用验证命令

```powershell
# 生成器单测（需要 Bun；CI 每版都会跑）
cd generator
bun test tests/unit

# 打包 + 可复现性 + 安装脚本自检
cd ..
$env:SUITE_DESKTOP=$env:TEMP
python tests/test_package.py

# 只检查现有包
python tests/test_package.py --no-build

# 版本
python build.py version
```

Windows 没有 `sh` 在 PATH 时，可使用：

```powershell
& 'C:\Program Files\Git\usr\bin\sh.exe' -n install.sh
& 'C:\Program Files\Git\usr\bin\sh.exe' -n package/usr/sbin/mtun-xd
& 'C:\Program Files\Git\usr\bin\sh.exe' -n deploy/mihomo-haproxy.sh
```

同时检查：

```powershell
node --check generator/app/state.js
node tools/check-yaml-tokens.mjs     # 高亮器 17 项
node tools/check-copy-integrity.mjs  # 复制完整性 4 项
sh tools/check-kit-sync.sh           # kit 与 dist/ 同源
sh tools/check-shell.sh              # 全部 shell 脚本语法
git diff --check
```

## 修改纪律

- `package/`、`install.sh`、`control/`、`deploy/` 或 `generator/` 有**功能或行为**变化时，发布前必须更新 `APP_VERSION` 和 `CHANGELOG.md`。
- **纯排版 / 文案 / 注释 / 样式改动不 bump 版本号**，随下一个功能版本一起发；避免为一个空格或一行对齐单独发版。
- **改脚本 / 样式 / 文档可以直接推**：推送本身不触发发版 —— release 工作流只有在 `APP_VERSION` 变化时才会真正发布（版本没变时 `prepare` 判 `release=false` 直接跳过）。
- **只有用户明确说「发版 / 发」时才更新 `APP_VERSION`**。「顺手改版本号」才是发版的唯一触发点。
- 提交前确认没有把版本号顺手改掉（`git diff generator/app/state.js` 应为空，除非本次就是发版）。
- 不要手工修改 `dist/`；发布工作流负责生成并提交它。
- 保持 LF。Windows 下的 CRLF 会直接破坏路由器 shell 脚本执行。
- shell 优先 POSIX / BusyBox ash，避免 Bash 专属语法。
- 面向路由器的文本文件继续使用 UTF-8。
- 用户可见输出使用统一的 `▶ / ✔ / ⚠️ / ✘` 步骤格式。
- 包管理器流水账、postinst 杂项和临时下载进度应收进日志，成功时只显示结果。
- 不改 MetaCubeXD 构建产物；只允许生成外壳配置、主题注入和空 Service Worker 等套件自有文件。
- 默认面板密码 `123456` 是用户明确保留的产品设置，不要擅自替换。
- 重跑安装时，配置和核心都没变化就不要重启内核。

## 文档与源码一致性

- 写进文档的「命令会做什么」必须沿**完整调用链**核对，不能只看函数名或单个函数：
  例：`install_core()` 本身会装核心，但上层 `setup` 先判「已存在就跳过」，所以不能写成「每次都会升级核心」。
- 文档摘要 / 审查摘要只能当作**待验证的声明**，不能反过来当作源码依据。
- 改完文档后，至少核对一遍涉及的命令、路径、默认值在源码里确实如此。

## 配置工具包（kit）发布纪律

- 配置工具包的滚动 release 在**独立仓库** `OpenWrt-MTUN-XD/genkit`（tag `genkit`），主仓库的 releases 只放正式版。
- 预览用 `KIT_NO_PUBLISH=1 bun scripts/make-router-kit.mjs` —— 只生成到本地，**不上传 genkit、不动 `dist/`**。
- 不加这个开关时，脚本会「顺手」发布到 genkit 并覆盖 `dist/`；随后若又 `git checkout -- dist`，两边就不同源，
  套件的摘要校验会报「配置工具校验失败」（2026-11-18 事故）。
- 改了生成器、需要正式发布 kit 时：跑一次**不带开关**的 `make-router-kit`，然后**把 `dist/` 一起提交**。
- 发布前或排查此类问题，跑 `sh tools/check-kit-sync.sh`（比对 `dist/`）或 `--remote`（比对 CDN）确认同源。
- **只改配置工具（`generator/`）时不需要发版**：跑一次 `make-router-kit` 重发 kit 即可，
  用户点「更新配置工具」（`mtun-xd tool`）或跑 `console` 就拿到。
  发版只用于 `package/`、`install.sh`、`control/`、`deploy/` 或套件脚本的改动。

## 下载与安全

- 核心、面板下载必须校验 GitHub Release 官方 SHA-256。
- `/gh-api/` 只允许 Mihomo / MetaCubeXD Release 元数据，不扩大代理白名单。
- 不得把 SSH 密码、面板密码、工具密码或 token 写入仓库、日志或命令输出。
- 真机命令如必须使用密码，应从环境变量读取，不能记录到持久文件。
- `config.yaml` 是用户正在运行的配置。安装、升级、修复默认不得覆盖；只有明确执行“载入配置文件”或用户要求时才修改。
- 写盘前必须用 `mihomo -t` 校验，失败不得替换现有配置；替换失败要回滚。

## 卸载约定

- `mtun-xd uninstall` 默认保留配置、工具密码和 GEO。
- 交互终端才询问是否 purge；非交互默认保留。
- 彻底删除使用 `mtun-xd uninstall --purge`。
- 包管理器直接卸载（`apk del` / `opkg remove`）也必须保留用户配置。
- 卸载输出固定为 1/4 到 4/4；包管理器输出收进日志。
- 卸载时会恢复 HAProxy / uhttpd 的原始 80 监听状态。

## 80 端口路由规则

能力检测优先于固件版本号：

1. uhttpd 支持 `Proxy raw stream`：使用原生 `proxy_prefix`。
2. nginx 已占 80：使用 `deploy/mihomo-kwrt-nginx.sh`。
3. uhttpd 不支持且 80 可用：`deploy/mihomo-haproxy.sh` 按需安装 HAProxy，mihomo 路径转 9090，其余 LuCI 转 uhttpd:8080。
4. 都无法使用：明确提示直连 mihomo 端口，不能误报“已挂载”。

已知固件差异：

- iStoreOS 24.10.7：uhttpd 没有原始流代理，需要 HAProxy 回退。
- iStoreOS 24.10.8：恢复原生 `Proxy raw stream`，应自动从 HAProxy 迁回 uhttpd。
- iStoreOS 25.12 等新版本：原生能力可用。

HAProxy 方案必须：

- 备份原 uhttpd 与 HAProxy 配置。
- 健康检查 `/`、`/ui/`、`/version`。
- 失败自动回滚，不能把 LuCI 锁死。
- HAProxy 已被其他配置占用时拒绝覆盖。
- `expose off` / 卸载时停用并恢复。

开机已有 `/etc/init.d/mtun-xd-selfcheck`，每次只运行一次 `selfcheck`。不要在 `expose ensure` 外层再新增第二个开机定时器。自检中 80 路由收敛必须幂等，并尊重 `expose off` 标记。

## 真机验证

真机变更前后至少记录：

- 固件发行版和 revision
- 套件 / 核心 / 面板版本
- 内核进程与 `/version` 状态
- `config.yaml` 哈希
- 工具密码是否保持不变（不打印明文）
- 磁盘空间

修改 80 路由时还要记录：

- `uci show uhttpd.main`
- 实际监听端口
- `/`、`/ui/`、`/version` 状态码
- 服务开机自启状态
- 回滚文件位置

真机操作要求：

- 先备份再切换端口或服务。
- 自动健康检查失败必须恢复原配置。
- 不因无关的小改动重启内核。
- 测试完成后恢复路由器到正常运行状态。
- 临时备份在确认成功后清理。

## 发布流程

1. 完成代码和测试。
2. 更新 `APP_VERSION`、`openwrt/Makefile` 的 `PKG_VERSION`（去掉前导 v，必须与之一致）、
   `CHANGELOG.md` 和必要文档。`PKG_VERSION` 漏改会让 `tests/test_package.py` 直接失败，
   也会让固件包版本和 Release 对不上。
3. 本地运行 `python tests/test_package.py`。
4. 提交并推送 `main`。
5. 等待 CI 与 Release 工作流成功。
6. `git pull --ff-only` 同步 bot 生成的 `dist:` 提交。
7. 验证 GitHub Release、线上 `latest.txt`、`/gh-api/`。
8. 用户要求真机验收时，升级目标设备并验证状态。

不要手工跳过失败的 Actions，也不要在 `dist/` 与 Release 不一致时宣称发布完成。

## 上游边界

- Mihomo / MetaCubeXD 的 issue 先判断是否真实、是否已修复、是否影响本项目。
- 用户只是询问上游 issue 时，不修改生成器或本仓库。
- 不得把上游尚未发布的能力写进生成器配置。
- 需要验证上游结论时，优先查官方源码、提交和 Release；引用准确版本。

## 完成标准

一个任务只有在以下条件满足时才算完成：

- 请求的行为已经实现，不只是写了说明。
- 相关自动化测试通过。
- 文档、版本和发布产物没有漂移。
- 真机任务已恢复到正常运行状态。
- 最终回复说明实际结果、验证证据、剩余风险和是否已发布。

