# 固件编译集成

> **已验证**（2026-11-18）：仓库的 `Firmware` workflow 用两套官方 SDK 实编并校验通过 ——
>
> | SDK | 产物 | 包管理器 |
> | --- | --- | --- |
> | OpenWrt **24.10.8** | `luci-app-mtun-xd_<版本>-r1_all.ipk`（约 57 KB） | opkg |
> | OpenWrt **25.12.6** | `luci-app-mtun-xd-<版本>-r1.apk`（约 57 KB） | apk |
>
> 两个包里都已核对套件本体、init 脚本、LuCI 菜单与页面文件齐全。

把 MTUN-XD 编进 OpenWrt / iStoreOS 固件。**独立安装（APK / OPKG / install.sh）不受影响**，
两条路共用同一份 `package/`，不存在第二套实现。

---

## Release 附件怎么选

每个版本会挂四个包，按文件名就能分辨：

| 文件名 | 来源 | 用途 |
| --- | --- | --- |
| `luci-app-mtun-xd_<版本>_all.ipk` | `build.py` 打包 | **独立安装**：opkg 固件手工 `opkg install` |
| `luci-app-mtun-xd-<版本>.apk` | `build.py` 打包 | **独立安装**：apk 固件手工 `apk add` |
| `luci-app-mtun-xd_<版本>-r1_all.ipk` | OpenWrt 24.10.8 SDK | **固件编译参考 / 塞进镜像前验证** |
| `luci-app-mtun-xd-<版本>-r1.apk` | OpenWrt 25.12.6 SDK | 同上（apk 体系） |

- 带 `-r1` 的是**用 SDK 按固件格式编出来的**，和你在自己固件树里编出来的东西同源；
- 不带 `-r1` 的是仓库常规发布包，内容一样，只是打包方式不同；
- 真正要「编进固件」，请用 `openwrt/Makefile` 在自己的固件树里编，而不是把 `-r1` 包直接塞进镜像 —— 依赖与架构校验由你的 SDK 负责。

## 它做了什么


| 层 | 内容 |
| --- | --- |
| 进镜像 | 套件本体：LuCI 菜单、三个页面、`/usr/sbin/mtun-xd`、init 脚本、i18n（几十 KB） |
| 不进镜像 | Mihomo 核心、MetaCubeXD 面板、配置工具 —— 首次开机联网后由 `mtun-xd setup` 拉取，带 SHA-256 校验 |
| 首次开机 | `mtun-xd-firstboot` 等服务就绪后跑一次 setup，成功后写 `/etc/mtun-xd-firstboot.done` |

不把核心塞进镜像的原因：体积按架构不同（约 22 MB），且会随上游版本很快过期。

---

## 接入方式

### 1. 丢进自己的 feed

```sh
cd openwrt                                  # 你的 OpenWrt 源码根目录
mkdir -p package/mtun-xd
cp /path/to/MTUN-XD/openwrt/Makefile package/mtun-xd/
```

### 2. 选源码来源（二选一）

**A. 本地仓库（推荐，改完立刻能编）**

```sh
make package/luci-app-mtun-xd/compile V=s \
     MTUN_XD_LOCAL=/path/to/MTUN-XD
```

**B. 从 GitHub 拉（按 tag）**

```sh
make package/luci-app-mtun-xd/compile V=s
```

这条路要求 `v<版本>` 的 tag 已存在，且编译机联网。

### 3. 选中并烧进固件

```sh
make menuconfig
#   LuCI → 3. Applications → luci-app-mtun-xd
make -j$(nproc)
```

```sh
make -j$(nproc)
```

---

## 包信息

| 项 | 值 |
| --- | --- |
| 包名 | `luci-app-mtun-xd` |
| 架构 | `all`（纯脚本 + 静态页面） |
| 依赖 | `luci-base`、`curl`、`ca-bundle`、`kmod-tun` |
| 配置 | `/etc/config/mtun-xd`（`firstboot`、`expose`） |
| 首次开机日志 | `/tmp/mtun-xd-firstboot.log` |

---

## 首次开机行为

1. 网络就绪（能访问 github.com）后，后台执行 `mtun-xd setup`；
2. 拉核心、面板、配置工具，铺默认 `config.yaml`（**不覆盖已存在的配置**），起服务；
3. 成功后写 `/etc/mtun-xd-firstboot.done`，之后开机不再执行。

### 关掉自动拉取

```sh
uci set mtun-xd.main.firstboot=0
uci commit mtun-xd
/etc/init.d/mtun-xd-firstboot disable
```

### 手动补一次

```sh
/usr/sbin/mtun-xd setup
```

---

## 与独立安装的关系

| 场景 | 入口 |
| --- | --- |
| 固件内置 | `/etc/init.d/mtun-xd-firstboot` → `mtun-xd setup` |
| 手动安装 | `install.sh` → 调包管理器 → 包内 postinst → 同一个 `setup` |
| 维护中心 | LuCI 页面 → `core` / `ui` / `console` |

三种入口最后都落到 `/usr/sbin/mtun-xd`，没有分支实现。

---

## 注意事项

- **磁盘空间**：核心 + 面板 + GEO 合计约 35 MB，建议 overlay ≥ 128 MB；
- **TUN**：依赖 `kmod-tun`，没有它的精简固件会降级为不开 TUN；
- **DNS / 时间**：首次开机若系统时间不对，TLS 校验会失败 —— 确保固件自带 NTP；
- **升级**：固件升级后 `mtun-xd-selfcheck` 会在开机时补齐被刷掉的登记信息；
- **不要同时用两种方式装**：固件内置了就不要再跑 `install.sh`（会重装同一个包，无意义）。
