# 贡献指南

感谢你愿意参与 MTUN-XD（墨枢云境）。这个项目面向 OpenWrt / iStoreOS 上的 Mihomo
管理，改动会直接跑在别人家的路由器上，所以对「可回滚」「不破坏现有配置」的要求比一般项目高。

---

## 先看这几份

| 文件 | 说明 |
| --- | --- |
| `README.md` | 安装、功能、推荐环境 |
| `AGENTS.md` | 仓库级约定：目录职责、修改纪律、80 端口规则、发布流程 |
| `TRADEMARK.md` | 发布渠道与品牌使用声明 |
| `CHANGELOG.md` | 每个版本改了什么 |

**改动前请先读 `AGENTS.md`**，里面的约定（例如「安装/升级不得覆盖 `config.yaml`」）不是建议，是硬约束。

---

## 提交信息

提交信息用英文，遵循 Conventional Commits：

```
fix(upgrade): keep running state when core version is unreadable
docs: add offline installation steps
ci(release): notify Telegram after publishing
```

- 祈使句，首字母小写，不超过 72 字符；
- 一个提交只做一件事；
- `CHANGELOG.md`、README 和界面文案保持中文，提交信息与 PR 标题用英文。

---

## 环境准备

```sh
# 生成器单测（需要 Bun）
cd generator && bun test tests/unit

# 打包 + 可复现性 + 安装脚本自检（需要 Python 3.8+）
cd ..
python tests/test_package.py

# Shell 语法
sh -n install.sh
sh -n package/usr/sbin/mtun-xd

# 可选：静态检查（未装 shellcheck 会跳过）
sh tools/check-shell.sh
```

Windows（PowerShell）先设临时目录，再跑同一条命令：

```powershell
$env:SUITE_DESKTOP=$env:TEMP
python tests/test_package.py
```

改生成器时的两个回归脚本：

```sh
node tools/check-yaml-tokens.mjs      # 语法高亮 17 项
node tools/check-copy-integrity.mjs   # 复制完整性 4 项
```

---

## 提交

- 提交信息使用 **Conventional Commits**：`feat:` / `fix:` / `docs:` / `style:` / `chore:` / `refactor:`；
- 一个提交只做一件事，别把「修 bug + 改文案 + 升版本」混在一起；
- **不要在 PR 里改 `APP_VERSION`** —— 版本号由维护者在发版时统一更新（见 `AGENTS.md`）。

---

## 代码约定（摘自 AGENTS.md）

- `package/`、`install.sh`、`control/`、`deploy/`、`generator/` 有行为变化时，发版前才更新版本号与 CHANGELOG；
- 文件保持 **LF**，面向路由器的文本一律 UTF-8；
- Shell 用 POSIX / BusyBox ash，不要用 Bash 专属语法；
- 用户可见输出统一 `▶ / ✔ / ⚠️ / ✘`；
- 写盘前必须 `mihomo -t` 校验，失败不得替换现有配置；
- 不得把密码、token、私钥写进仓库、日志或命令输出。

---

## 不要提交的内容

- 真实节点订阅、`config.yaml`、面板密码、工具密码、SSH 凭据；
- 构建产物（`dist/` 由发布工作流生成）、临时脚本、抓包文件；
- 与改动无关的格式化（会让 review 变难）。

---

## 报告问题

- **常规 bug / 功能建议**：用 Issue 模板提交；
- **安全漏洞**：不要开公开 Issue，按 `SECURITY.md` 的方式私下报告。

提交 bug 时请附上：

```
固件与版本（如 iStoreOS 25.12 / ImmortalWrt 24.10）
套件版本：mtun-xd version
诊断输出：mtun-xd doctor
相关日志：/tmp/mtun-xd.log 的尾部（先脱敏）
```

`mtun-xd doctor` 的输出通常能直接定位问题，比贴一堆日志有用。

---

## 许可

提交代码即表示同意按仓库现有许可发布：套件本体 MIT，`generator/` 为 GPL-3.0。
