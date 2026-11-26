<p align="center"><img src="docs/assets/banner.jpg" alt="MTUN-XD"></p>

<h1 align="center">墨枢云境</h1>

<p align="center">
  OpenWrt / iStoreOS 的 Mihomo 管理套件
</p>

<p align="center">
  <strong>简体中文</strong> | <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/actions/workflows/ci.yml"><img src="https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

---

## 项目介绍

套件把 Mihomo 核心、MetaCubeXD UI、配置生成器、维护功能，收进 LuCI 的「服务 → 墨枢云境」统一入口。

## 设计理念

MTUN-XD 不以功能堆叠为目标，而是优先保证稳定性、可控性与行为可预期。

- **配置可审计**：固定键序，支持 Diff，便于审查与回滚。
- **边界清晰**：不擅自重启内核或删除文件，保留用户控制权。
- **默认克制**：广告拦截默认关闭，不引入不必要的运行变量。
- **部署可靠**：GEO 数据本地预置，降低首次启动对外网的依赖。
- **质量可验证**：176 项自检与 Golden 基线，确保变更经过验证。
- **节点自主**：不提供机场订阅托管与自动拉取，节点来源由用户掌控。

> 让行为可预期，让变更可审计，让运行有保障。

### 质量验证

```sh
python tests/test_package.py      # 176 项打包自检（含视图自愈、脚本约定）
bun test generator/tests/unit     # 306 项单元测试（含 Golden 基线逐字节比对）
sh tools/check-shell.sh           # shell 语法检查
```

CI 结果：[Actions](https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/actions/workflows/ci.yml) · 发布验收：[RELEASE-CHECKLIST](docs/RELEASE-CHECKLIST.md)

### 界面预览

<p align="center">
  <img src="docs/panel-2026.png" alt="控制面板（MetaCubeXD）" width="100%">
</p>

<p align="center"><sub>控制面板：流量、内存、连接数实时视图，支持代理 / 规则 / 连接管理</sub></p>

### 功能特性

- **控制面板**：内嵌 MetaCubeXD，跟随 LuCI 明暗主题。
- **一键载入**：写盘前 `mihomo -t` 校验，失败回滚并保留备份。
- **统一入口**：LuCI、面板、配置工具同走 80 端口，无需记端口。
- **维护中心**：核心 / 面板 / 套件分别更新，后台执行，日志可查。
- **分流与分组**：精准分流、按设备 IP 分配出口、多节点自动负载均衡。
- **配置生成器**：导入节点（链接 / 订阅 / Clash YAML），生成可用的 `config.yaml`。

### 系统要求

- root 权限，安装过程需要联网
- 磁盘空间足够放下对应架构的 Mihomo 核心
- OpenWrt / iStoreOS，包管理器为 APK 或 OPKG

### 推荐环境

- **主题：[Argon](https://github.com/jerrykuku/luci-theme-argon)** —— 推荐使用，界面已适配 Argon，支持明暗主题切换。
- **系统：[iStoreOS](https://fw.koolcenter.com/)** —— 主要测试平台，已实测 24.10.8 和 25.12.6。其他 OpenWrt 系固件也可使用。

## 安装与配置

### 方式一：路由器直接安装（推荐）

SSH 登录路由器，以 root 执行：

```sh
# GitHub（备用地址）
curl -fsSL https://raw.githubusercontent.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/main/install.sh -o /tmp/mtun-xd-install.sh && sh /tmp/mtun-xd-install.sh
```

国内访问 GitHub 不稳时用 CF 镜像（推荐，也是 install.sh、核心和面板的首选源）：

```sh
curl -fsSL https://mtun-xd.wxcircle.top/install.sh -o /tmp/mtun-xd-install.sh && sh /tmp/mtun-xd-install.sh
```

安装完成后进入 **LuCI → 服务 → MTUN-XD**（中文界面显示「墨枢云境」）。

### 方式二：编进固件

把套件作为软件包编进 OpenWrt / iStoreOS 镜像：首次开机联网后自动拉取核心与面板，与上面的独立安装共用同一套 `setup` 实现。

步骤见 [openwrt/README.md](openwrt/README.md)。

### 离线安装

Release 里的 `.apk` / `.ipk` 可以离线装套件本体（不含核心与面板，约 73 KB）：

```sh
# APK 固件（OpenWrt 25.12 / iStoreOS 25.12）
apk add --allow-untrusted /tmp/luci-app-mtun-xd-*.apk
# OPKG 固件（OpenWrt 24.10 及更早）
opkg install /tmp/luci-app-mtun-xd_*.ipk
```

注意：首次 `mtun-xd setup` 仍需联网拉取核心、面板与 GEO 数据；完全离线时，可把另一台已装好的 `/etc/mihomo` 整目录拷过来再执行 `mtun-xd setup`，已有的核心、面板与 GEO 会被复用，缺的部分仍需网络补齐。`config.yaml` 不会被覆盖。

### 初始配置

安装后会得到一份最小可用配置：

| 配置项 | 默认值 |
| --- | :---: |
| External UI | `ui` |
| 面板密码 | `123456` |
| External Controller | `127.0.0.1:9090` |

> 首次登录后建议立即修改默认密码。

首次使用在「配置工具」里导入节点、生成配置，再点「载入配置文件」。

### 安全说明

默认监听（`127.0.0.1:9090`）。如需开放访问，请设置 `secret` 并限制防火墙访问范围，切勿将控制端口暴露到公网。

## 使用与维护

### 开机启动

重启后，Mihomo 核心延迟 40 秒启动。

此延迟用于等待 USB 存储、PPPoE 拨号及网络链路等底层环境完成初始化。

### 组件更新

「维护中心」的按钮等价于下面这些命令，顺序与页面一致（核心 → 面板 → 套件）：

| 维护中心按钮 | SSH 命令 | 实际更新范围 |
| --- | --- | --- |
| 更新核心 | `/usr/sbin/mtun-xd core` | 只更新核心二进制 |
| 更新面板 | `/usr/sbin/mtun-xd ui` | 只换面板静态文件 |
| 更新套件 | `/usr/sbin/mtun-xd console` | 重装套件包并跑部署流程：面板/配置工具有新版就对齐、GEO 缺失补装；**不更新已有核心**、不动 `config.yaml` |

### 卸载

```sh
mtun-xd uninstall --purge   # 全部删除
mtun-xd uninstall           # 保留 config.yaml、工具密码和 GEO
```

## 项目资料

**项目声明**

其他渠道发布的「同款版」「定制版」与本项目无关。

套件正式发布渠道仅限 GitHub 仓库及 Releases，以及 CF 镜像。

`MTUN-XD`、`墨枢云境`、`墨樞雲境` 及 Logo 未授权第三方使用。**代码授权不代表品牌授权。**

安装脚本内置摘要校验，套件安装包仅从上述渠道获取；核心与面板则从各自上游官方渠道获取。

**项目链接**

[GitHub 仓库](https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD) · [版本发布](https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/releases) · [Telegram 群组](https://t.me/mtunxd) · [安全报告](https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/blob/main/SECURITY.md) · [参与开发](https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/blob/main/CONTRIBUTING.md) · [发布验收清单](https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/blob/main/docs/RELEASE-CHECKLIST.md) · [项目架构](https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/blob/main/docs/ARCHITECTURE.md) · [品牌与商标声明](https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/blob/main/TRADEMARK.md)
