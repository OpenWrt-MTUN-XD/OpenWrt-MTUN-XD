# 变更记录

## 2026.11.02

- 配置工具：页面标题改为 MTUN-XD，图标换成官方徽标（圆形透明底）

## 2026.11.01

首个版本。

- 套件包名 `luci-app-mtun-xd`，命令 `mtun-xd`
- 安装 / 升级 / 卸载 / 修复：`mtun-xd setup|console|uninstall|doctor`
- 配置工具独立滚动更新（`mtun-xd tool`）
- 下载源：Cloudflare 镜像 `mtun-xd.wxcircle.top` 优先，GitHub 回退
- 核心 / 面板从各自官方 Release 获取并校验 SHA-256

