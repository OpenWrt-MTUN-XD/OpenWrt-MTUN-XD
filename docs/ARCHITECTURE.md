# 架构与开发文档

本文面向维护者，记录 MTUN-XD 的内部结构、路由与构建发布机制。
普通用户只需要看 [README](../README.md)。

---

## 产品架构

### 整体工作流程

```text
                    MTUN-XD · 墨枢云境
                            │
              ┌─────────────┼─────────────┐
              │             │             │
          控制面板       配置工具       维护中心
              │             │             │
              │         配置生成          │
              │             │             │
              │       mihomo-apply       │
              │             │             │
              │         配置校验          │
              │             │             │
              └─────────────┼─────────────┘
                            │
                     Mihomo Core
                            │
                 OpenWrt / iStoreOS
```

### 访问与数据流

```text
安装：
install.sh
    └── GitHub Release
          ├── Mihomo Core
          └── MetaCubeXD
                └── /etc/mihomo/

访问：
浏览器
    └── uhttpd :80
          ├── /luci/       → LuCI 页面
          └── /ui          → Mihomo Web 面板
              /version     → Mihomo API
                            └── 127.0.0.1:9090
                                （expose 同源反向代理）

配置：
配置工具
    └── /cgi-bin/mihomo-apply
          ├── 写入临时配置
          ├── mihomo -t 校验
          ├── 原子替换 config.yaml
          └── 热载入 / 重启
```

## 文件布局

路由器端采用模块化目录结构：

```text
/
├── usr/
│   ├── sbin/
│   │   └── mtun-xd
│   │
│   ├── share/
│   │   └── mtun-xd/
│   │       ├── mihomo-kwrt-nginx.sh
│   │       └── mihomo-haproxy.sh
│   │
│   └── lib/lua/luci/i18n/
│       ├── luci-app-mtun-xd.zh-cn.lmo
│       └── luci-app-mtun-xd.zh-tw.lmo
│
├── etc/
│   ├── init.d/
│   │   ├── mihomo
│   │   └── mtun-xd-selfcheck
│   │
│   ├── mihomo/
│   │   ├── config.yaml
│   │   ├── mihomo
│   │   ├── ui/
│   │   └── rules/
│   │
│   └── mihomo-toolpass
│
└── www/
    ├── cgi-bin/
    │   └── mihomo-apply
    │
    └── luci-static/
        └── resources/
            ├── mtun-xd/
            │   └── common.js
            │
            └── view/
                └── mtun-xd/
                    ├── panel.js
                    ├── generator.js
                    └── upgrade.js
```

### 目录职责

| 路径 / 文件 | 用途 |
| --- | --- |
| `/usr/sbin/mtun-xd` | 主控制脚本 |
| `/usr/share/mtun-xd/` | 80 端口适配脚本 |
| `/etc/init.d/mihomo` | procd 核心服务 |
| `/etc/init.d/mtun-xd-selfcheck` | 开机自检 |
| `/etc/mihomo/config.yaml` | Mihomo 运行配置 |
| `/etc/mihomo/mihomo` | 核心二进制 |
| `/etc/mihomo/ui/` | Web 面板及配置工具 |
| `/etc/mihomo/rules/` | 规则集存储 |
| `/etc/mihomo-toolpass` | 配置工具访问密码 |
| `/www/cgi-bin/mihomo-apply` | 配置载入与写盘入口 |
| `common.js` | 三个 LuCI 页面的共用组件 |

## 80 端口与同源访问

为了简化面板和配置工具的访问，MTUN-XD 通过同源反向代理，将 Mihomo Web 面板及 API 统一挂载到 80 端口。

适配方式**按实际能力检测决定，不看固件版本号**（版本只作兼容性参考）：

| 环境情况 | 适配方式 |
| --- | --- |
| uhttpd 支持原始流代理（`Proxy raw stream`） | 直接用 uhttpd 的 `proxy_prefix` |
| 80 被 nginx 占用 | `mihomo-kwrt-nginx.sh` 生成 locations |
| uhttpd 不支持且 80 空闲/外部 HAProxy 在其他端口 | `mihomo-haproxy.sh` 启动独立 HAProxy 实例（自有 cfg / PID / init）接管 80；已有外部 HAProxy 时共存，不覆盖其配置 |
| 以上都不可用 | 明确提示直连 `:9090`，不会误报「已挂载」 |

已知固件差异：

| 固件 | 实际情况 |
| --- | --- |
| iStoreOS 24.10.7 | uhttpd 没有原始流代理，需要 HAProxy 回退 |
| iStoreOS 24.10.8 | 恢复原生 `Proxy raw stream`，会自动从 HAProxy 迁回 |
| iStoreOS 25.12 | 原生能力可用 |

适配脚本：

```text
/usr/share/mtun-xd/
├── mihomo-kwrt-nginx.sh
└── mihomo-haproxy.sh
```

## 仓库结构

```text
MTUN-XD/
├── package/                 套件软件包
├── control/                 软件包控制文件
├── build.py                 构建脚本
├── install.sh               安装 / 修复 / 升级入口
├── generator/               配置生成器源码
├── tests/
│   └── test_package.py      打包与安装脚本自检
├── tools/
│   └── make_i18n.py         菜单名称翻译目录生成器
└── dist/                    CI 构建产物（勿手工修改）
```

版本号唯一来源：

```text
generator/app/state.js
```

对应字段：

```js
APP_VERSION
```

## 构建与测试

构建 APK 与 IPK：

```sh
python build.py
```

仅构建 IPK：

```sh
python build.py ipk
```

仅构建 APK：

```sh
python build.py apk
```

说明：APK 构建需要 `apk-tools-static` 环境。

执行完整构建与自检：

```sh
python tests/test_package.py
```

仅检查现有软件包：

```sh
python tests/test_package.py --no-build
```

执行配置生成器单元测试：

```sh
cd generator && bun test tests/unit
```

## 自动化发布

项目采用 GitHub Actions 自动化发布流程。

推送至 `main` 分支后，CI 自动执行：

```text
代码推送
   │
   ▼
自动测试
   │
   ▼
构建 APK / IPK
   │
   ▼
更新 dist/
   │
   ▼
生成 SHA256SUMS
   │
   ▼
提交构建产物
   │
   ▼
创建 GitHub Release
```

发布规则：

- 版本号以 `APP_VERSION` 为唯一来源。
- 已发布版本不重复构建。
- 如需重新发布，可通过 Actions → Release → Run workflow 执行。
- 重新发布时使用 `force` 参数。
