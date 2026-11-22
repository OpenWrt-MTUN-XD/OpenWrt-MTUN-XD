# MTUN-XD 发布验收清单

> 适用范围：OpenWrt / iStoreOS 上的 MTUN-XD（墨枢云境）版本发布。
>
> 目标：把每次发布的构建检查、升级验证、LuCI 页面检查和运行状态检查固定下来，
> 减少依赖个人记忆的漏项。
>
> **原则：先在测试路由器验证，再推广到生产路由器。**
> 不要在承载家庭或办公网络的唯一主路由上做首次安装、卸载或故障注入测试。

---

## 1. 发布前检查

### 1.1 版本与代码

- [ ] 确认工作区干净，待发布改动已提交（`git status --short`）。
- [ ] 版本号只在 `generator/app/state.js` 的 `APP_VERSION` 更新；包版本、`dist/latest.txt`
      与 Release 信息由构建流程保持一致。
- [ ] 检查本次改动涉及的安装、升级、卸载、自检和 LuCI 页面路径。
- [ ] 确认没有把节点订阅、密码、私钥、真实配置或个人网络信息提交到仓库。

### 1.2 自动化检查

仓库根目录执行：

```sh
cd generator && bun test tests/unit
cd ..
python3 tests/test_package.py        # Windows：先设 $env:SUITE_DESKTOP=$env:TEMP
```

Shell 语法检查：

```sh
sh -n install.sh
sh -n package/usr/sbin/mtun-xd
sh -n control/postinst
sh -n control/prerm
sh -n deploy/mihomo-haproxy.sh
sh -n deploy/mihomo-kwrt-nginx.sh
sh -n generator/deploy/generator.sh
sh -n generator/deploy/mihomo-apply
```

可选的本地静态检查与工具脚本自查：

```sh
sh tools/check-shell.sh            # 未装 ShellCheck 会跳过；--strict 视为失败
node tools/check-yaml-tokens.mjs   # 高亮器 17 项
node tools/check-copy-integrity.mjs # 复制完整性 4 项
```

- [ ] 单元测试通过（以 `bun test tests/unit` 的实际输出为准）。
- [ ] 打包自检通过（以 `test_package.py` 结尾那行「打包自检通过（N 项）」为准，含两次构建字节一致）。
- [ ] Shell 语法检查通过。
- [ ] 如本次修改涉及 shell，检查并处理 `tools/check-shell.sh` 报告的问题；
      若因规则差异暂不处理，记录原因。

### 1.3 构建产物

```sh
python3 build.py
```

- [ ] APK / IPK 构建成功。
- [ ] 包内版本号、文件清单、权限和菜单入口正确。
- [ ] `SHA256SUMS` 已生成，摘要与最终发布附件对应。
- [ ] Release 附件、CF 镜像文件与官方摘要一致（可用 `tools/verify-kit-digest.sh` 核对 kit）。
- [ ] 确认没有误提交临时文件、测试产物或旧版本附件。

> 本项目 Release 由推送 `main` 的 CI 自动创建，不需要手工建 tag / Release。
> **`dist/` 的处理分两种，不要一刀切：**
>
> - **本次没有主动更新配置工具包（kit）**：确认 `dist/` 没有意外改动；若有，先查明来源，
>   不要盲目 `git checkout -- dist` 把它revert 掉。
> - **本次要更新 kit**：不带 `KIT_NO_PUBLISH` 跑一次 `bun scripts/make-router-kit.mjs`（只写 OUT），
>   再跑 `python build.py kit <OUT>` 把 kit 复制进 `dist/` 并重算 `SHA256SUMS`，然后把 `dist/` 一起提交。
>   **禁止手工 cp kit 进 `dist/`。**
> - 推送前跑 `sh tools/check-kit-sync.sh`（本地）或 `--remote`（CDN）确认与 genkit 同源；
>   CI 还会用 `python tools/check-kit-dist.py /tmp/mihomo-deploy dist v<版本>` 卡一次源码同步。
>
> 预览（只推路由器看效果）必须用 `KIT_NO_PUBLISH=1`，它不会动 `dist/`、也不会发布 kit。

---

## 2. 测试路由器准备

**以下步骤应先在可恢复的测试设备上执行。**

- [ ] 确认测试设备型号、CPU 架构、内存、存储空间和系统版本。
- [ ] 确认当前使用 APK 还是 OPKG，并记录测试环境。
- [ ] 确认 SSH 可用；测试期间保留一个 SSH 会话，不要只依赖 LuCI。
- [ ] 记录升级前版本：

```sh
mtun-xd status
mtun-xd version
mtun-xd expose status
```

- [ ] 备份用户配置和重要数据（保存到路由器以外的安全位置）：

```sh
cp -p /etc/mihomo/config.yaml   /安全备份目录/config.yaml
cp -p /etc/mihomo-toolpass      /安全备份目录/mihomo-toolpass
```

- [ ] 记录当前 `config.yaml` 与工具密码文件是否存在。
- [ ] 确认测试路由器有足够磁盘空间和可用网络。

> 备份文件包含敏感信息，必须妥善保管；不要把文件内容或密码贴进公开日志或 issue。

---

## 3. 安装 / 升级验证

### 3.1 全量安装或升级路径

```sh
curl -fsSL https://raw.githubusercontent.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/main/install.sh \
  -o /tmp/mtun-xd-install.sh \
  && sh /tmp/mtun-xd-install.sh
```

GitHub 不通时用 CF 镜像：

```sh
curl -fsSL https://mtun-xd.wxcircle.top/install.sh \
  -o /tmp/mtun-xd-install.sh \
  && sh /tmp/mtun-xd-install.sh
```

只验证套件包替换路径时用 `pkg` 模式，**不要把它当作全量组件安装测试**：

```sh
sh /tmp/mtun-xd-install.sh pkg
```

- [ ] 安装脚本正常下载，摘要校验成功（取不到摘要会拒绝安装，属预期行为）。
- [ ] 软件包安装成功，无 APK / OPKG 数据库错误。
- [ ] Mihomo 核心、MetaCubeXD 面板和配置工具按预期部署或保留。
- [ ] 已有用户 `config.yaml` 未被默认配置覆盖。
- [ ] 已有工具密码未被意外重置。
- [ ] 安装过程没有输出明文面板密码或工具密码。
- [ ] 没有遗留安装包、解压目录或临时文件；检查 `/tmp`。

### 3.2 升级后命令检查

```sh
mtun-xd status          # 应显示 内核 / 面板 / 配置工具 / 控制台 四个版本
mtun-xd doctor          # 只读诊断，错误项必须为 0
mtun-xd expose status
```

- [ ] `status` 能显示控制台、核心、面板、配置工具版本。
- [ ] `doctor` 正常完成；错误项必须为 0。
- [ ] 对警告逐项判断：环境限制、用户主动关闭的功能，还是本次发布引入的回归。
- [ ] `expose status` 与预期一致；此前主动 `expose off` 的应保持关闭。
- [ ] Mihomo 核心进程正常运行。
- [ ] `config.yaml` 校验通过。

> `doctor` 是只读诊断，不替代浏览器页面检查，也不代表代理规则全部验证过。

---

## 4. LuCI 页面与实际功能回归

浏览器登录 LuCI，进入 **服务 → MTUN-XD / 墨枢云境**。

### 4.1 控制面板

- [ ] 页面正常打开，无白屏、脚本报错或持续加载。
- [ ] 面板能完成认证，流量、内存、连接等数据正常显示。
- [ ] 代理、规则、连接等交互区域能正常加载。
- [ ] 刷新页面后仍能正常进入。
- [ ] 浏览器地址栏、页面提示、运行日志中没有明文认证信息。

### 4.2 配置工具

- [ ] 页面正常打开，工具认证流程正常。
- [ ] 节点导入 → 参数设置 → 配置预览三步可用。
- [ ] YAML 预览有语法高亮与行号；复制/下载得到的是原始文本。
- [ ] 不要为了验收覆盖生产配置；「载入配置文件」在测试配置上验证。
- [ ] 写盘前有备份，`mihomo -t` 失败时原配置保持可用、不留半截文件。

### 4.3 维护中心

- [ ] 页面正常打开，当前版本信息可读。
- [ ] 核心、面板、套件更新按钮状态正常。
- [ ] 本次改动涉及升级流程时，在测试设备上实际验证对应升级项。
- [ ] 后台执行时日志持续更新，结束后状态正确。
- [ ] 页面刷新或重新登录后系统状态仍正确。

---

## 5. 80 端口与服务检查

```sh
mtun-xd expose status
```

- [ ] 预期启用同源访问时返回 `on`，浏览器可通过 LuCI 同源入口访问面板与配置工具。
- [ ] 用户主动关闭过的应保持 `off`，不被安装/升级擅自开启。
- [ ] 面板与 API 可正常访问；不能只凭配置文件里有反代规则就判定成功。
- [ ] 使用 nginx / HAProxy 适配时，确认配置有效、无重复规则、其他站点未受影响。
- [ ] 核心重启后再次检查面板与配置工具是否恢复。

---

## 6. 日志与敏感信息检查

- [ ] 维护中心运行日志可读取，能定位成功或失败步骤。
- [ ] 日志体积上限生效（超过 512 KB 只保留最后 128 KB）。
- [ ] 日志中没有明文面板 `secret`、工具密码、订阅 URL 凭据或节点认证信息。
- [ ] 检查日志时不要把完整凭据复制到工单或公开渠道。
- [ ] 若发现敏感信息：先停止传播并评估轮换凭据，再修复源头与脱敏逻辑。

常用日志位置：

```text
/tmp/mtun-xd.log          后台升级输出（写入前统一脱敏）
/tmp/mtun-xd.setup.log    分步安装明细
/tmp/mtun-xd.install.log  安装/升级整体日志（install-log 命令读取）
/tmp/mtun-xd.boot.log     开机自检日志
```

---

## 7. 数据保护与卸载回归

**常规发布不要求每次都在主路由上卸载。**
卸载测试应在可重装的测试设备或快照环境中执行。

只检查当前安装完整性：

```sh
sh tools/uninstall-check.sh
```

本次改动涉及卸载、包脚本、文件清理或数据保留行为时，再在测试设备上做破坏性验证：

```sh
sh tools/uninstall-check.sh --run
```

`--run` 会实际卸载套件并停止服务，执行后需按脚本提示重装。
**不要在唯一生产主路由上运行。**

- [ ] 普通卸载保留用户配置和工具密码。
- [ ] 套件脚本、菜单、ACL、LuCI 视图和 init 文件按预期清理。
- [ ] 80 端口适配按设计还原，没有遗留指向已删除目录的规则。
- [ ] 重装后可正常恢复服务。
- [ ] 只有用户明确要求彻底清除时才测 `uninstall --purge`，执行前另行备份。

---

## 8. 发布判定

### 必须全部满足

- [ ] 自动化测试、打包自检和语法检查通过。
- [ ] 发布附件与镜像摘要一致。
- [ ] 测试设备升级成功，用户配置未被覆盖。
- [ ] `doctor` 无错误；所有警告均已解释。
- [ ] 控制面板、配置工具、维护中心三页正常。
- [ ] 80 端口状态符合用户原有设置。
- [ ] 日志无明文凭据泄露。
- [ ] 本次改动涉及的专项回归已完成。

### 不满足时

- 不要继续推广到生产设备。
- 保留失败日志与设备环境信息，先脱敏再归档。
- 明确区分代码问题、网络/CDN 问题、固件差异和用户自定义配置问题。
- 修复后重跑受影响的检查项；涉及安装、升级、卸载或 ACL 的改动，重走完整链路。

---

## 9. 发布记录模板

每次发布复制填写一份：

| 项目 | 记录 |
| --- | --- |
| 版本号 | |
| Git commit | |
| 测试日期 | |
| 测试设备 / 架构 | |
| OpenWrt / iStoreOS 版本 | |
| 包管理器 | APK / OPKG |
| 升级前版本 | |
| 升级后版本 | |
| 自动化测试 | 通过 / 失败 |
| `doctor` | 错误数： 警告数： |
| 三个 LuCI 页面 | 通过 / 失败 |
| `expose status` | on / off（是否符合预期：） |
| 配置与密码保留 | 通过 / 不适用 / 失败 |
| 专项回归 | |
| 发布结论 | 通过 / 暂缓 |
| 备注 | |

**执行口径：** 每次发布至少完成第 1、2、3、4、5、6、8 节；
只有涉及卸载、安装脚本、包控制脚本、数据清理或 ACL 的改动，才强制执行第 7 节的破坏性回归。
