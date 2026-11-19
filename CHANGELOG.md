# 变更记录

## 2026.11.05（未发布）

### 移除

- 维护中心的 80 端口挂载开关（回退为 CLI：`mtun-xd expose on|off|status`）
  —— 默认安装已自动挂好，这个开关只对极少数人有用，却要重启 uhttpd、页面会短暂掉线

### 修复

- 固件 workflow 的 gate：取不到 Release 元数据时直接失败，不再安静跳过（会少挂固件包）
- gate 去掉「发布时间 ≤1200 秒」这半句：runner 排队超过窗口时真发版反而被跳过
- `Firmware` workflow 的触发面补回 `package/usr/sbin`、`package/etc`、`package/www`
  （这条腿编的就是 `package/` 的内容，只留 `openwrt/**` 等于不再验固件包本体）
- kit 打包：输出目录护栏（拒绝清空仓库根 / 家目录 / 盘符根）、先写 dist 再发远端、
  `SHA256SUMS` 字节序排序、目录条目补 DOS 属性位、拒绝符号链接、资产列表分页、
  ZIP/TAR 结构自检

## 2026.11.04

### 修复

- 后台升级失败不再显示成功：退出码取自真实命令，不再取管道末端的清洗器
- 首次开机 `setup` 失败不写完成标记，下次开机会重试
- 安装后的版本比对忽略 `-rN`（固件集成包不再被误判「版本没对上」）
- nginx 方案：停 uhttpd 让出 80（不再只靠 `enabled=0`）；用户原有 conf 备份到 `/etc/mihomo-kwrt-nginx.prev`，`off` 时还原
- apk / ipk 依赖补齐 `ca-bundle`、`kmod-tun`
- 删除两个 32 字节坏掉的 `.lmo`（页面没有 `_()` 词条，留着会坑以后）
- 回环分支与状态行文案纠正：不再出现「未装（读不出版本号）」「检查服务是否正常启动」这类误导

### 工具链

- `tools/check-shell.sh`：按行读路径（路径带空格不再假绿）、ShellCheck `-S error` 硬门禁、清单解析失败直接判死
- `read_lf` 支持无扩展名脚本（靠 shebang 识别），二进制文件不再被改行尾
- CI 与本地同口径：统一跑 `check-shell.sh` + 四个前端 `node --check` + 两个验收脚本
- `release_meta` 恢复 `"assets"` 校验，网关页面 / 限流错误体不会当缓存

### 新增

- 维护中心增加 80 端口开关（`expose on` / `off`），状态现问脚本，未知时提供重试入口
- 前台 resize 监听改 window 单例，来回切页不再累积

## 2026.11.03

- 后台升级失败不再显示成功（退出码取自真实命令，非管道末端的清洗器）
- 首次开机 setup 失败不写完成标记，下次开机会重试
- 安装后的版本比对忽略 `-rN`，固件集成包不再被误判为「版本没对上」
- 跳过校验开关统一为 `MIHOMO_ALLOW_UNVERIFIED`（旧名仍兼容）
- 核心候选拿不到摘要时继续试下一个，不再整次安装判死
- nginx 方案：装前备份用户原 conf 并在 `off` 时还原；不再只靠 `enabled=0` 让端口
- apk / ipk 依赖补齐 `ca-bundle`、`kmod-tun`
- `check-kit-sync.sh`、`verify-kit-digest.sh`、两个验收脚本修正（不再引用未定义变量 / 写死本机路径）
- `status` 控制台一行改为三段判断，失败诊断不再自相矛盾
- 后台日志恢复逐行实时输出（`fflush`）

## 2026.11.02

- 配置工具：页面标题改为 MTUN-XD，图标换成官方徽标（圆形透明底）

## 2026.11.01

首个版本。

- 套件包名 `luci-app-mtun-xd`，命令 `mtun-xd`
- 安装 / 升级 / 卸载 / 修复：`mtun-xd setup|console|uninstall|doctor`
- 配置工具独立滚动更新（`mtun-xd tool`）
- 下载源：Cloudflare 镜像 `mtun-xd.wxcircle.top` 优先，GitHub 回退
- 核心 / 面板从各自官方 Release 获取并校验 SHA-256

