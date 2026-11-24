# MTUN-XD Agent Guide

本文件是仓库级持久约定。仓库中的更具体 `AGENTS.md`（如有）优先于本文件。

## 项目目标

MTUN-XD 是一个 OpenWrt / iStoreOS 管理套件，把以下内容整合进 LuCI「服务 → MTUN-XD」：

- Mihomo 核心
- MetaCubeXD 官方面板
- 浏览器端配置生成器
- 核心 / 面板 / 控制台安装、升级、卸载与 80 端口接入

核心和面板不随包发布，安装时从 GitHub Release 获取，并校验官方 SHA-256。

## 产品理念与工程落地

六项产品取舍不是宣传语，是设计约束；动代码时按这张表落地：

| 产品理念 | 工程落地 |
|---|---|
| 配置可审计 | 固定输出键序；改生成逻辑必须过 Diff / Golden |
| 边界清晰 | 每个副作用（写文件、重启内核、删文件）必须显式、可回滚、有说明 |
| 默认克制 | 新功能默认关闭或零影响；默认配置变化要单独说明 |
| 部署可靠 | GEO 数据本地预置；安装路径必须有真机验证 |
| 质量可验证 | `tests/test_package.py` 自检 + `generator/tests/golden` 基线随改动同步 |
| 节点自主 | 不提供订阅托管与自动拉取；用户自带节点仍可导入 |

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

- **提交信息用英文**（Conventional Commits：`type(scope): summary`），祈使句、不超过 72 字符；需要时正文也用英文。面向用户的 `CHANGELOG.md`、README、界面文案保持中文；PR / Issue 标题用英文。
- `package/`、`install.sh`、`control/`、`deploy/` 或 `generator/` 有**功能或行为**变化时，发布前必须更新 `APP_VERSION` 和 `CHANGELOG.md`。
- **纯排版 / 文案 / 注释 / 样式改动不 bump 版本号**，随下一个功能版本一起发；避免为一个空格或一行对齐单独发版。
- **改脚本 / 样式 / 文档可以直接推**：推送本身不触发发版 —— release 工作流只有在 `APP_VERSION` 变化时才会真正发布（版本没变时 `prepare` 判 `release=false` 直接跳过）。
- **只有用户明确说「发版 / 发」时才更新 `APP_VERSION`**。「顺手改版本号」才是发版的唯一触发点。
- **CGI 抽检**：`mihomo-apply` 不在 ipk/apk 内（由生成器 kit 安装），包检只能查 `usr/sbin/mtun-xd`；装完必须在真机 `/www/cgi-bin/mihomo-apply` 抽查一次 —— 无 `docker` / `CONTAINER` / `pidof` / `'/mihomo/'`，且判活委托 `mtun-xd core-state`。
- 提交前确认没有把版本号顺手改掉（`git diff generator/app/state.js` 应为空，除非本次就是发版）。
- **`dist/` 里的任何文件都算线上产物**：改动落进 `dist/` 就等于部署（CF Workers 随 push 自动发布）。只能在发版提交里出现，且必须先拿到明确「发」。
- **禁止手工往 `dist/` copy 文件**。正式发版的 `dist/` 由 release workflow 写入；滚动 kit 只能走 `make-router-kit` → `build.py kit` 的既定流程。
- **改动单里出现「`dist/` 与根文件一致」这类验收时**，若本地无法用构造脚本达成，一律视为「本提交不做同步」，不是「手工同步」。
- 推送本身也会触发 CF 重新部署一次（即使 `dist/` 没变）；推文档时默认会走一趟部署，别顺手带别的改动。
- 保持 LF。Windows 下的 CRLF 会直接破坏路由器 shell 脚本执行。
- shell 优先 POSIX / BusyBox ash，避免 Bash 专属语法。
- 面向路由器的文本文件继续使用 UTF-8。
- 用户可见输出使用统一的 `▶ / ✔ / ⚠️ / ✘` 步骤格式。
- 包管理器流水账、postinst 杂项和临时下载进度应收进日志，成功时只显示结果。
- 不改 MetaCubeXD 构建产物；只允许生成外壳配置、主题注入和空 Service Worker 等套件自有文件。
- 默认面板密码 `123456` 是用户明确保留的产品设置，不要擅自替换。
- 重跑安装时，配置和核心都没变化就不要重启内核。
- **内核判活只有一个答案：`core_alive`。** 不要用 `pidof mihomo`、9090 应答或 `/version` 反推「内核在跑」；端口只能回答「API 能不能连通」。

## UI 视觉与交互规范

适用于 LuCI 三页（控制面板 / 配置工具 / 维护中心）以及生成器页面的所有视觉调整。
核心原则：**克制用色、统一对齐、最小改动、实际验证**；**不以个人审美替代既定规范**。

### 颜色

- **最小着色**：只给需要强调的**状态值、操作结果、异常信息**着色，不扩大到整行或整段。
- **语义一致**：同一状态在徽标、日志、提示里用同一个变量（定义在
  `package/www/luci-static/resources/mtun-xd/common.js` 的 `themeApply()`）：

  | 语义 | 变量 |
  | --- | --- |
  | 运行中 | `--mh-ok` / `--mh-ok-bg` |
  | 已停止 | `--mh-idle` / `--mh-idle-bg` |
  | 启动中 / 停止中 | `--mh-busy` / `--mh-busy-bg` |
  | 更新中 | `--mh-warn` / `--mh-warn-bg` |
  | 异常 / 失败 / 超时 | `--mh-err` / `--mh-err-bg` |

- **默认中性**：时间戳、字段名（如 `状态：`）、普通说明文字保持正文默认色。
- **主题适配**：颜色一律走 CSS 变量，明暗两套都要能给对；禁止写死十六进制。

### 日志输出

- `[HH:MM:SS]` 时间戳始终默认正文色。
- 字段名（`状态：` 等）始终默认正文色。
- 状态值单独着色：运行中绿 / 已停止灰 / 启动中·停止中蓝 / 更新中橙 / 异常·失败·超时红。
- `✔ / ✘ / →` 这类**独立结果行**（没有时间戳前缀）允许整行着色。
- 没有匹配规则的普通日志保持默认正文色。

### 信息层级（重要）

**不要为了突出状态而牺牲信息层级。** 强调状态值，不等于把整行都染色：

```text
推荐：  [12:39:05] 状态：运行中
         └─ 默认色 ─┘ └ 绿 ┘
错误：  [12:39:05] 状态：运行中      ← 整行染色，时间戳和字段名被一起错误强调
```

### 布局与对齐

- 同类元素保持统一尺寸、间距与对齐方式。
- 状态徽标在所属内容区域**水平居中**，不随左侧文字长度漂移。
- 操作按钮保持统一高度；不要无意义地加大宽度或字号。
- 标题、正文、日志的缩进要视觉协调（同一左缘或明确的层级缩进）。
- 优先保持原有布局；局部调整不得影响其他区域。

### 修改纪律（UI 相关）

- 最小范围修改，不顺手重构无关代码。
- 不擅自改变已有布局、字号、颜色、间距和交互行为。
- 改前先看同类组件，改后必须**看实际渲染**（真机或本地截图 / computed style），
  不能只确认「代码改完了」。
- 发现规范冲突或视觉异常，先说明再调整；不拿个人喜好覆盖本规范。

## 文档与源码一致性

- 写进文档的「命令会做什么」必须沿**完整调用链**核对，不能只看函数名或单个函数：
  例：`install_core()` 本身会装核心，但上层 `setup` 先判「已存在就跳过」，所以不能写成「每次都会升级核心」。
- 文档摘要 / 审查摘要只能当作**待验证的声明**，不能反过来当作源码依据。
- 改完文档后，至少核对一遍涉及的命令、路径、默认值在源码里确实如此。

## 配置工具包（kit）发布纪律

- 配置工具包的滚动 release 在**独立仓库** `OpenWrt-MTUN-XD/genkit`（tag `genkit`），主仓库的 releases 只放正式版。
- 预览用 `KIT_NO_PUBLISH=1 bun scripts/make-router-kit.mjs` —— 只生成到本地 OUT，**不上传 genkit、不动 `dist/`**。
- `make-router-kit` 只写 OUT（桌面 `mihomo-deploy/`），**不再直接改 `dist/`**。正式发 kit 的路径只有一条：
  不带开关跑脚本（发 genkit）→ `python build.py kit <OUT>`（复制进 `dist/` + 重算 `SHA256SUMS`）→ 提交 `dist/`。
- kit 里只允许 LF，且归一必须排在算 `?v=` 内容指纹之前（否则指纹随 CRLF 变、index.html 差一行）；打包末尾另有 `\r` 断言兜底。
- **禁止手工 cp kit 进 `dist/`**。CI 在提交 `dist/` 前会跑
  `python tools/check-kit-dist.py /tmp/mihomo-deploy dist v<版本>`：解 `dist/mihomo-deploy.tar.gz`
  与当前源码拍平目录逐文件比对，并要求 `config/state.js` 的 `APP_VERSION` 等于本次版本号；不一致直接 fail。
- 发布前或排查此类问题，跑 `sh tools/check-kit-sync.sh`（比对 `dist/`）或 `--remote`（比对 CDN）确认同源。
- **tag 只承诺复现 `install.sh` 与两种包，不承诺复现 kit。** kit 是滚动产物，`dist/` 里的 kit 会随配置工具更新，不随 tag 冻结。
- 组名滚动改名：配置工具默认组名由「智能选择」改为「自动优选」；旧名在解析器里保留兼容。kit 更新后，设备需重新「生成配置文件」才会写出新组名；`install.sh`、apk/ipk、tag 均不受影响。
- **只改配置工具（`generator/`）时不需要发版**：跑 `make-router-kit` → `python build.py kit <OUT>`
  重发 kit 即可，用户点「更新配置工具」（`mtun-xd tool`）或跑 `console` 就拿到。
  但 `dist/` 变更仍按部署纪律走：推送即上线，必须明确授权。
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
- 卸载时会还原 MTUN-XD 自己接管的 80 与 uhttpd 监听；外部 / 系统的 HAProxy 实例和 /etc/haproxy.cfg 不动。

## 80 端口路由规则

能力检测优先于固件版本号：

1. uhttpd 支持 `Proxy raw stream`：使用原生 `proxy_prefix`。
2. nginx 已占 80：使用 `deploy/mihomo-kwrt-nginx.sh`。
3. uhttpd 不支持且 80 可用：`deploy/mihomo-haproxy.sh` 启动**独立的** HAProxy 实例（独立 cfg / PID / init），mihomo 路径转 9090，其余 LuCI 转 uhttpd:8080；已有外部 HAProxy 时共存，不覆盖其配置。
4. 都无法使用：明确提示直连 mihomo 端口，不能误报“已挂载”。

已知固件差异：

- iStoreOS 24.10.7：uhttpd 没有原始流代理，需要 HAProxy 回退。
- iStoreOS 24.10.8：恢复原生 `Proxy raw stream`，应自动从 HAProxy 迁回 uhttpd。
- iStoreOS 25.12 等新版本：原生能力可用。

HAProxy 方案必须：

- 备份原 uhttpd 监听；HAProxy 使用独立配置，不备份也不覆盖 `/etc/haproxy.cfg`。
- 按原始 `listen_http` 生成 bind，不擅自扩大到 `0.0.0.0` / `[::]`。
- 健康检查 `/`、`/ui/`、`/version`，并按实际 bind 地址探测。
- 失败自动回滚；回滚后确认 80 恢复，失败则保留快照。
- 已有外部 HAProxy 时走独立实例共存；80 被外部实例占用则拒绝接管。
- `expose off` / 卸载只停自己的实例并还原 uhttpd，外部 HAProxy 不动。

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

1. 本地只更新 `generator/app/state.js` 的 `APP_VERSION`、`openwrt/Makefile` 的
   `PKG_VERSION`（去掉前导 v，必须一致）、`CHANGELOG.md`，然后提交 release commit 并推 `main`。
   **本地不产出 dist、不建 tag、不建 Release、不传附件。**
2. 推 `main` 后由 `.github/workflows/release.yml` 完成：prepare → test → 造 ipk/apk →
   更新/提交 dist → 建 Release（含 tag）→ Telegram 通知。
3. `prepare` 的硬闸门：若 `dist/latest.txt` 已是本次版本、但 GitHub Release 不存在，
   判定为「dist 被本地抢跑」，直接失败，禁止继续发布。
4. Release 正文只由 `build.py release_body(made)` 生成；Packages List 必须来自实际附件，
   不预写未上传的 `-r1` 行；生成后校验 U+FFFD = 0 并输出正文 sha256。
5. Telegram 步骤必须解析 Telegram 返回值：`ok == true` 且拿到 `message_id` 才算成功；
   secret 缺失打 `::warning::`，接口失败打 `::error::` 并带 `error_code` / `description`。
6. 出现 skipped / 已存在 / 跳过判定，先停下报告，不得自行补跑；`force` 补跑必须经用户同意，
   且 job summary 要记录「人工强制重跑」并核对正文 sha、附件数量、CF 三方。
7. `git pull --ff-only` 同步 bot 生成的 `dist:` 提交，核对 `dist`、Release、CF、
   `latest.txt` 与摘要一致；不要手工补 tag / Release / 附件。
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

