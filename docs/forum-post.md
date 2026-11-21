# 【自荐】墨枢云境 MTUN-XD：给 iStoreOS / OpenWrt 用的 Mihomo 一体化管理套件（已开源）

## 一句话

把 **Mihomo 核心 + MetaCubeXD 面板 + 浏览器端配置生成器 + 维护中心** 收进 LuCI 的「服务 → MTUN-XD」，装完这一处，剩下的都在这一处。

---

## 为什么做这个

我自己的用法很固定：路由器跑 Mihomo，手机和电脑走 TUN，几台设备要按 IP 分不同出口。真正折腾的从来不是内核，而是下面这些事：

- 每次换节点都要手写一遍 `config.yaml`，写完还得自己检查格式；
- `SRC-IP-CIDR` 和 `GEOIP,LAN` 的先后顺序错了，内网就莫名其妙走代理；
- 面板、内核、插件散在三个页面，升级要点三次；
- 换台路由器，配置还得重新抄一遍。

这套东西就是把这些重复劳动收掉了。核心和面板**不随安装包分发**，安装时从各自官方 Release 拉取并校验 SHA-256，所以套件包本身不到 80 KB。

---

## 主要功能

### 1. 浏览器端配置生成器

在浏览器里把节点粘进去，直接生成可用的 `config.yaml`：

- 支持 `ss / ssr / vmess / vless / trojan / hysteria2 / tuic / wireguard / socks5` 等分享链接，也能贴 Base64 订阅串、传 Clash YAML；
- 两种模式：**精准分流**（按 GeoSite / GeoIP 分流）和 **内网控制**（按设备 IP 分配出口）；
- 内网控制支持「IP 段顺延」：比如 `192.168.100` 起点 + N 台设备，每台固定一个出口；
- 自定义规则优先级高于内置规则，可以插到广告拦截之前；
- 多节点自动生成负载均衡组，也可以开智能选择做默认出口；
- 生成的配置带 **YAML 语法高亮 + 行号**，复制/下载的都是原始文本，不会带上任何标记。

配好的 YAML 可以一键「载入配置文件」直接生效（写盘前会跑 `mihomo -t`，失败不替换）。

### 2. 控制面板

直接内嵌 MetaCubeXD，和 LuCI 同一套明暗主题，跟随切换。

### 3. 维护中心

内核、面板、插件三个升级按钮，对应三条独立命令，互不影响：

| 操作 | 命令 |
| --- | --- |
| 更新套件 | `/usr/sbin/mtun-xd console` |
| 更新核心 | `/usr/sbin/mtun-xd core` |
| 更新面板 | `/usr/sbin/mtun-xd ui` |

`console` 只换套件，不碰内核、面板和 `config.yaml`。

### 4. 80 端口统一入口

不用记端口：LuCI 在 `/`，面板在 `/ui/`，配置工具在 `/ui/config/`，都走 80。

能力检测优先于固件版本：uhttpd 支持原始流代理就直接用，不支持才回退 HAProxy + nginx，装不上会明确告诉你直连 9090，不会误报“已挂载”。

---

## 安装

SSH 登录路由器，root 执行：

```sh
curl -fsSL https://raw.githubusercontent.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/main/install.sh -o /tmp/mtun-xd-install.sh && sh /tmp/mtun-xd-install.sh
```

国内访问 GitHub 不稳时，用 CF 镜像：

```sh
curl -fsSL https://mtun-xd.wxcircle.top/install.sh -o /tmp/mtun-xd-install.sh && sh /tmp/mtun-xd-install.sh
```

装完进 **LuCI → 服务 → MTUN-XD**。

- 支持 APK（OpenWrt 25.x / iStoreOS 25.12）与 OPKG（24.10 及以前），脚本自动判断；
- 只装套件：加 `pkg` 参数；
- 默认面板密码 `123456`，进面板后请自行修改。

---

## 一些实现上的取舍

| 决定 | 原因 |
| --- | --- |
| 核心 / 面板不随包分发 | 套件包不到 80 KB；核心/面板在你主动执行更新时对齐上游，不会后台自动升级 |
| 配置生成器纯前端 | 节点信息不经过路由器，刷新即清空，不落盘 |
| YAML 高亮自己写，不引 CodeMirror | 只做显示，不改内容；全程 `textContent`，失败回退纯文本；零新增依赖 |
| 不覆盖 `config.yaml` | 安装、升级、修复都不动正在跑的配置，只有你点「载入配置文件」才写 |
| 卸载默认保留配置和密码 | 包管理器直接卸载也一样；要全删用 `uninstall --purge` |

---

## 项目信息

- 仓库：https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD
- 发布页：https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/releases
- 国内镜像：https://mtun-xd.wxcircle.top/
- 讨论群：https://t.me/+Kdxyw8yLTz85ODg5

协议：套件本体 MIT，配置生成器 GPL-3.0。

---

## 最后

这不是一个“全家桶”，它只做一件事：**让 Mihomo 在路由器上跑起来之后，配置和维护不要再折腾**。

用得上的可以试试，用不上也欢迎看看实现；有问题直接在群里问，或者提 issue。
