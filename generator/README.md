# MTUN-XD 配置生成器

> ⚠️ 2026-10-23 起：这个目录**只作为路由器配置工具的源码**（打进套件的 kit）。
> 不再单独部署官网 —— 生成器随套件仓库一起发布，不再依赖独立站点。

浏览器里用的 mihomo 配置生成器。零框架、零构建、零依赖，`index.html` 直接打开就能用。
生成的配置面向 **OpenWrt + mihomo + MetaCubeXD**。

所有处理都在浏览器里完成 —— 节点与订阅内容不上传；页面只向**同源**地址发请求
（登录校验、写盘等），不把数据发到别处。

## 用法

```text
双击 index.html
bun run serve        → http://localhost:4173/
bun run build        → 产出 dist/（纯静态，扔哪都能托管）
```

三步向导：**导入节点 → 设置 → 预览与下载**（下载或复制 `config.yaml`）。

导入节点有两个入口：

- **粘贴链接**，每行一条：`ss://` `ssr://` `vmess://` `vless://` `trojan://`
  `hysteria2://` / `hy2://` `hysteria://` `tuic://` `wireguard://` `snell://`
  `http(s)://` `socks5://` `ssh://` `shadowtls://` `anytls://`
- **上传文件**（`.txt` / `.yaml` / `.yml` / `.json` / `.conf`）—— 链接、整份 Clash 配置（含
  `proxies:` 段）、base64 订阅串都认

订阅 YAML 里本工具没有专门解析的类型（`mieru` / `sudoku` / `tailscale` / `zerotier` …）
也能原样穿过，字段按 mihomo 官方键序重排。

## 界面

- **勾选框只有方块本身可点**：点文字或整行不会误勾（2026-10-26 定的）
- **「广告拦截」出厂默认不勾**（2026.11.05 起）：勾上才生成 `rule-providers.adblock`
  （217heidai 合并清单，约 24 万条，8 小时一更）+ 一条 `- RULE-SET,adblock,REJECT`；
  不勾时配置里既没有这个 provider，也不会去下载清单
- **主题**：嵌在 LuCI 里时跟路由器（Argon 的亮色 / 暗色 / 跟随系统）；单独打开时跟系统。
  预览窗和底部状态条都跟着主题走。页面上**没有**明暗切换按钮（2026-10-29 删的，
  套件里由宿主负责）

## 两种规则方案

| 规则方案 | 说明 |
| --- | --- |
| 精准分流 | 国内直连、国外走代理。可开智能选择模式（多节点时生成测速组）、回国模式、全局代理 |
| 内网控制 | 每个节点分配独立内网 IP，按 `SRC-IP-CIDR` 分流。支持任意网段、回国模式、Telegram / AnyDesk 直连 |

**全局代理**是精准分流里的一个勾选框（默认不勾）：勾上就只剩「自定义规则 → 直连块 →
一句 `MATCH`」，分流规则全都不出。它和**回国模式互斥**，勾上一个会自动取消另一个。

**本地出口**（精准分流正常模式，默认不勾）：勾上「国内出口」并选一个节点后，
`GEOSITE,cn` / `GEOIP,CN` 改走这个节点；不勾就是原来的 `# 国内 直连`。
回国模式 / 全局代理 / 一机一IP 下不显示。

**自定义规则**（rules 卡片底部）一条 = 目标（域名或 IP）+ 出口，两档方案都生效。
出口可以选一个节点（直接走它）、直连，或者**多个节点**（自动生成一个
`load-balance` 负载均衡组，成员相同的规则共用一个组）。
⚠️ 已被占用的节点**不列出来**：智能选择开着时是智能组的成员，关着时是默认出口那个节点。
反选出来的节点逐个列出，点一个 = 直接走它，点多个 = 生成一个 `负载均衡` 组。
没被智能组 / 默认出口 / 自定义规则引用的节点，生成时**直接从配置里剔除**
（一机一IP 例外：每个节点都有自己的 `SRC-IP-CIDR`，全部保留）。
导入节点时会按当前节点表核一遍：指向已删节点的规则自动清掉（不再留在列表里标红）。

**常用 → AI**：勾上就往自定义规则里加一条 `GEOSITE,category-ai-!cn,<出口>`，
覆盖 OpenAI / Claude / Gemini / Copilot / Cursor 等主流海外 AI；出口取当前选中的节点组。
选了「回国模式」时自动换成 `GEOSITE,category-ai-cn,<出口>`（国内 AI 走代理）。

**常用 → TK**：勾上往自定义规则里加 `GEOSITE,tiktok,<出口>`；
固定用 `tiktok` 分类，**不跟回国模式切换**。
**常用 → TC**：勾上往自定义规则里加一段 `# TC 服务`
（`GEOSITE,tencent,<出口>`），覆盖微信 / QQ / 腾讯全家桶
（`qq.com`、`weixin.qq.com`、`qpic.cn`、`qlogo.cn`、`gtimg.cn`、`wechat.com`…）。

**TK / TC / AI 三项在任何模式下都显示，也不会被自动清掉** —— 出口取当前选中的节点组。
输出顺序：`# Tik Tok` → `# TC 服务` → `# AI 服务`。
目标框也可以手写 `geosite:<分类>`（如 `geosite:openai`），生成 `GEOSITE,<分类>,<出口>`。
⚠️ 分类必须存在于路由器上的 `GeoSite.dat`，缺了内核会拒载整份配置。

两档共用同一套节点解析与渲染内核，同一批节点在两种配置里的文本逐字一致。

## 约定

- **默认值就是出厂配置** —— 什么都不改的话，产物与内置模板逐字节相同；清空任何一栏 = 用回默认值。
- **什么都不存** —— 关掉页面重新打开就是出厂默认，上次填的模式 / 端口 / DNS / 自定义规则一概不带过来。
- 节点字段**源里有就输出**；链接里没写的少数字段按 mihomo 常用值补（如 vmess 的 `fp: chrome`、hysteria2 的 `alpn: h3`），字段名与顺序照 mihomo 官网。
- 内网直连写 `GEOIP,LAN,DIRECT,no-resolve`，布尔字段裸写 `true`（加引号就是字符串）。
- dns 段的备注按界面上的分类名统一成「引导 / 默认 / 节点 / 中国 / 国外 / 直连 DNS」。

## 上路由器（部署包）

```shell
bun scripts/make-router-kit.mjs     # 出桌面的 mihomo-deploy/（完整包）
```

**现在不用了** —— 装套件（`MTUN-XD`）、或点它的「软件升级 → 控制台升级」，就把生成器
一起带齐了（套件从 **GitHub Releases** 拿，国内不稳时走镜像
那个滚动 release，tag `genkit`）。真要单装生成器：

```shell
curl -fsSL https://raw.githubusercontent.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/main/generator/deploy/generator.sh | sh -s i
```

⚠️ 走套件那条更稳：它会先把包（zip）下好再交给脚本（`MIHOMO_KIT_FILE`）；
这条单装是**单地址**，CF 抽风时没有回退。

长命令粘进 SSH 会被终端从中间截断（踩过：800 多字符那行断在中间，shell 停在续行
提示符上干等），所以整个过程**写成脚本发到网站上**，而不是压成一条长命令。
`deploy/generator.sh` 是唯一来源，打包时原样发布两处：套件仓库的 `genkit` 滚动 release，
以及套件仓库的 `dist/`（随仓库发布）。

⚠️ 脚本是从 stdin 灌进来的，**菜单不能从 stdin 读**（会把还没执行的正文吃掉），
得 `read < /dev/tty`。

⚠️ 安装时顺手会把面板的 `sw.js`（PWA 的 service worker）换成一个**空 SW**：
面板自带那个的 `NavigationRoute` 作用域是 `/ui/`、没有 denylist，会把
`/ui/config/` 也兜底成面板自己的页面 —— 面板 HTML 里的资源是相对路径，
在 `/ui/config/` 下全 404，**表现就是打开生成器白屏**。只有 https 会犯
（service worker 需要安全上下文）。代价是面板不再离线缓存，这个场景用不到。
换上去的那个空 SW 还兼职一件事：把**生成器那个页面本身**改成每次重新校验
（`cache: "no-cache"`），这样改完东西不用再手动强刷。

⚠️ **改完不用手动 F5**：打包时会给每个 js/css 挂上**内容指纹**
（`?v=<md5 前 8 位>`），内容一变 URL 就变，浏览器不可能再给旧的；
页面本身在 https 下由上面那个 SW 每次重新校验。

### 「载入配置文件」怎么走

只有**直接写盘**一条路 —— uhttpd 上的 `/cgi-bin/mihomo-apply`，写的就是
`/etc/mihomo/config.yaml`（写完让内核重载）。地址按两条顺序探：

1. **本页自己的 origin** —— 地址栏里那个 `host:port` + `/cgi-bin/mihomo-apply`。
   套件把生成器挂在 uhttpd 那个端口上（`expose on`），所以这条通常直接命中。
2. **同一主机的协议默认口**（只对 http 页面；https 不试 443）—— 给「页面开在 9090、
   写盘口在 uhttpd 80」那种布局兜底。

⚠️ 两条都探不到（比如只映射了 9090、80 没露出去）⇒ **根本不显示「载入配置文件」按钮**，
旁边写一句原因。以前的「信箱」兜底（投进 mihomo 的 `/storage`、机器上 cron 取信）
2026-10-16 已整个撤掉。

桌面上 `mihomo-deploy/` 底下**只有 `config/` 一个目录**，而且是**平铺**的 —— 打包时
把仓库里的 `app/` 那一层拍掉，`index.html` 里 `href`/`src` 的 `app/` 前缀也一起去掉，
所以传上去就是一层：

```text
config/  index.html（入口）  *.js  core/  vendor/  style.css  favicon.png
         mihomo-apply（写盘 CGI）  btn.js（面板左下角那个绿点）
```

说明文档不进包。

⚠️⚠️ **生成器页面本身是公开的**（绕了一圈，2026-10-12 定的）：

mihomo 把 `external-ui` 当**静态文件**发，**没有登录层** —— 页面怎么都挡不住。
试过并否掉的几条路：

- 不显示绿点 —— 挡不住手输地址的人；
- 删掉 `index.html`、让 `/ui/config/` 变 404 —— **不行**：Go 的 `http.FileServer`
  在目录里没有 `index.html` 时会改为吐**目录列表**（还是 HTTP 200，文件名全列出来）；
- 把文件搬出 `/ui/`、由一道验凭据的 CGI 来发 —— 能真 404，但入口就落到了 uhttpd 的
  **80 端口**上，而只映射 9090 的网络（端口转发 / 公网 / NAT 隧道）下根本打不开。

所以**门放在「写」那一层**：

- 没登录就拿不到 secret，页面上**没有「载入配置文件」按钮**（`app/apply.js`）；
- 写盘 CGI 认 **mihomo 自己的 secret**（登录面板要输的密码），硬 POST 也是 403。

> 以前这里放过一个 `apply.json`，里面是写盘用的 token —— 2026-10-12 删掉了。
> 它跟生成器页面一起躺在 `/ui/config/` 这个**不用登录就能直接访问**的静态目录里，
> 等于把钥匙挂在门上。

⚠️ 拍平只针对**打包产物**：仓库里仍然是 `index.html` + `app/`，到 kit 里才变成一层 `config/`。

部署包只发两处：套件仓库的 `dist/`（随仓库发布的
）、以及套件的 `genkit` 滚动 release。

zip 是脚本自己拼的（不依赖 `zip` 命令），时间戳写死，内容不变则字节完全一致。

## 开发

需要 [Bun](https://bun.sh)（只为跑测试和本地服务；应用本身不需要任何工具链）。

```shell
bun test tests/unit      # 单元测试（含逐字节基线比对）
bun run serve            # 本地静态服务器
bun run build            # 产出 dist/
bun run golden           # 重建基线
```

`tests/golden/fixtures.json` 是本项目自己的产物基线，由 `tests/golden/bless.mjs` 从
`app/core/*.js` 生成。**只有故意改了产物才跑 `golden`**，跑完务必看 `git diff` ——
那个 diff 就是这次改动对产物的全部影响。

```text
index.html                 界面骨架（三步向导）
app/style.css              样式（浅色 / 深色）
app/vendor/js-yaml.min.js  唯一第三方文件（MIT），解析 Clash YAML 订阅
app/main.js                启动
app/gate.js                登录门（工具密码 / 从 LuCI 带过来的那把）
app/secret.js              读面板 secret（同源 localStorage / 地址栏）
app/apply.js               「载入配置文件」（探写盘口 + POST）
app/embed.js               嵌在 LuCI 里（?noframe=1）时给 body 打 `headerless` 记号
app/core/util.js           真值 / URI / base64 / IP / 网段运算
app/core/yaml.js           YAML 标量序列化 + 官方字段顺序表
app/core/yaml-load.js      Clash YAML 订阅解析适配层
app/core/parsers.js        链接解析 + Clash YAML / base64 / 纯链接入口
app/core/render.js         节点 → YAML
app/core/engines.js        精准分流 + 内网控制两个引擎
app/state.js               状态与出厂默认
app/ui.js                  渲染与事件
app/vendor/sha256.js       纯 JS SHA-256（http 下算工具密码用）
deploy/                    上路由器的 kit 源（generator.sh / mihomo-apply / btn.js）
tests/                     测试与基线
scripts/                   本地服务 / 构建 / 出 kit
```

## License

GPL-3.0。

图标用的是 [mihomo](https://github.com/MetaCubeX/mihomo) 官方 logo（同一许可）。
