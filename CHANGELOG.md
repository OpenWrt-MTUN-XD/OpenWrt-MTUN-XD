# 变更记录

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

