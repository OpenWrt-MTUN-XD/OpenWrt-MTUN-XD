#!/bin/sh
# Mihomo 管理套件 —— 一行装（OpenWrt / iStoreOS，root 跑）
#
#   curl -fsSL https://mtun-xd.wxcircle.top/install.sh \
#     -o /tmp/mtun-xd-install.sh && sh /tmp/mtun-xd-install.sh
#
# 这个脚本只干一件事：把**套件包**装上。剩下的（拉核心、拉面板、铺默认配置、起服务、
# 装配置工具）由包的 postinst 自己跑 —— 所以**装的时候这台机器要能上网**。
#
# ⚠️ 这个脚本是用 `curl | sh` 跑的：**正文在 stdin 上**，所以里面不能去读 stdin
#    （会把自己后面的内容吃进去）。同理别加交互式确认。
# ⚠️ 拉不动 / 想离线装：手动去 Releases 下载装包，传进路由器再 `apk add` / `opkg install`
#    （**要带路径**），见 README 的「下载安装」。

set -u

REPO=OpenWrt-MTUN-XD/OpenWrt-MTUN-XD
PKG=luci-app-mtun-xd
# 主源是 Cloudflare 上的 dist/ 镜像，拿不到再退回 GitHub（raw + Release）。
# 国内不稳时靠下面的 MIRRORS 反代。
RAW=https://raw.githubusercontent.com/$REPO/main
# 国内镜像（Cloudflare）：dist/ 的静态副本，拿不到再退回 GitHub。
CF=https://mtun-xd.wxcircle.top
# ⚠️ 包文件名用下面现查到的 latest 拼，不在脚本里写死版本号：脚本可能比线上旧
#    （CF / 镜像缓存了一版），写死会去下一份已经不存在的文件名，CF 和所有镜像全 404。
# ⚠️ 跟 /usr/sbin/mtun-xd 里那份保持一致（GitHub 直连 + 两个反代）
MIRRORS="https://github.com https://ghfast.top/https://github.com https://gh-proxy.com/https://github.com"

say() { echo "$1"; }
die() {
    # ⚠️ 安装失败时唯一的诊断信息（apk/opkg 的原始报错）在临时目录里，而 EXIT trap
    #    会把它整个删掉 —— 用户只剩一句「安装失败」。留一份固定路径的副本再退。
    if [ -n "${TMP:-}" ] && [ -f "$TMP/pm.log" ]; then
        cp -f "$TMP/pm.log" /tmp/mtun-xd.pm.log 2>/dev/null \
            && printf '  （包管理器输出：/tmp/mtun-xd.pm.log）\n' >&2
    fi
    echo "✘ $1" >&2; exit 1
}
# 步骤标题：第一个步骤前面不留空行，后续步骤之间保留一个空行分隔。
ui_step() { printf '▶ %s\n' "$1"; }
ui_ok()   { printf '  ✔ %s\n' "$1"; }
ui_warn() { printf '  ⚠️ %s\n' "$1"; }

# ── 只换包模式（只换包文件，不碰任何东西）──────────────────────────────────
#   默认那条路装完会跑 postinst → setup（补齐核心 / 面板 / 配置工具，还会重启服务）；
#   这个模式一个都不碰：apk 用 `--no-scripts`，opkg 没有跳过脚本的开关 ⇒ 让 postinst
#   认标记文件、直接收工。用法：`sh /tmp/mtun-xd-install.sh pkg`。
ONLY_PKG=0
[ "${PKG_ONLY:-0}" = 1 ] && ONLY_PKG=1
case "${1:-}" in pkg|--pkg|-p) ONLY_PKG=1 ;; esac

[ "$(id -u)" = 0 ] || die "要用 root 跑（SSH 上去直接跑就行）"

# ── 后台模式：下载后 `sh /tmp/mtun-xd-install.sh bg` ────────────────
# 隧道 SSH 装到一半掉线 → 安装跟着死，界面还留个 404。
# 这里把自己重新拉一份到 /tmp、脱离终端跑，日志落盘；**断线不影响安装**。
# 重连后：tail -f /tmp/mtun-xd.install.log  或  mtun-xd install-log
if [ "${1:-}" = bg ] || [ "${1:-}" = --bg ]; then
    BGF=/tmp/mtun-xd.install.sh
    BGL=/tmp/mtun-xd.install.log
    command -v curl >/dev/null 2>&1 || die "后台安装：没有 curl"
    curl -fsSL -m 60 -o "$BGF" "$CF/install.sh" 2>/dev/null || curl -fsSL -m 60 -o "$BGF" "$RAW/install.sh" 2>/dev/null || die "后台安装：取不到安装脚本"
    : > "$BGL"
    if command -v setsid >/dev/null 2>&1; then
        setsid sh "$BGF" </dev/null >>"$BGL" 2>&1 &
    else
        nohup sh "$BGF" </dev/null >>"$BGL" 2>&1 &
    fi
    ui_step "安装 mtun-xd"
    ui_ok "后台安装已开始（SSH 断开不影响）"
    printf '  日志：tail -f %s\n' "$BGL"
    printf '  结果：mtun-xd install-log\n'
    exit 0
fi
MARK=/tmp/mtun-xd.pkg-only
# 只清理自己创建的标记；未持有（或已经清过）就什么都不做。
mark_clear() {
    [ "${MARK_OWNED:-0}" = 1 ] && rm -f "$MARK"
    MARK_OWNED=0
}


# ── 并发锁（安装器自己的，不是套件那把）──────────────────────────────
# 两条 install.sh 同时跑（SSH 一条 + 页面点控制台升级）会在 apk 数据库上撞锁：
# 一个报「安装失败」、另一个其实装成功了。
# ⚠️ 故意不跟套件共用 /tmp/mtun-xd.lock：postinst 的 setup 要拿套件那把锁，
#    共用的话老版本（不认 MTUN_XD_LOCKED）会被挡住，setup 整个跳过。
SUITE_LOCK=/tmp/mtun-xd-install.lock
LOCKED=0
lock_acquire() {
    if mkdir "$SUITE_LOCK" 2>/dev/null; then
        echo $$ > "$SUITE_LOCK/pid" 2>/dev/null
        LOCKED=1
        return 0
    fi
    local old
    old=$(cat "$SUITE_LOCK/pid" 2>/dev/null)
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
        return 1
    fi
    rm -rf "$SUITE_LOCK"
    mkdir "$SUITE_LOCK" 2>/dev/null || return 1
    echo $$ > "$SUITE_LOCK/pid" 2>/dev/null
    LOCKED=1
    return 0
}
cleanup_install() {
    [ -n "${TMP:-}" ] && rm -rf "$TMP"
    # 只删自己建的那份；别人的标记不碰
    [ "${MARK_OWNED:-0}" = 1 ] && rm -f "$MARK"
    # 只删自己那把锁
    [ "$LOCKED" = 1 ] && [ "$(cat "$SUITE_LOCK/pid" 2>/dev/null)" = "$$" ] && rm -rf "$SUITE_LOCK"
    return 0
}
trap cleanup_install EXIT
trap 'cleanup_install; exit 130' INT TERM
lock_acquire || { say "⚠️ 另一个安装正在进行，稍后再试"; exit 1; }

# ⚠️ 拿到锁之后才动共享标记：另一个安装正在跑（持锁）时，那份标记是它的有效状态，
#    不是残留 —— 在这里删掉会让它的 postinst 认不出「只换包」而跑全套 setup。
[ "$ONLY_PKG" = 1 ] || rm -f "$MARK"
MARK_OWNED=0

# ── 认包管理器 ────────────────────────────────────────────────────────────
if command -v apk >/dev/null 2>&1; then
    PM=apk
elif command -v opkg >/dev/null 2>&1; then
    PM=opkg
else
    die "既没有 apk 也没有 opkg —— 这不是 OpenWrt 系的系统？"
fi

ui_step "安装 mtun-xd"

# ── 本机装的是哪一版（没装就是空）────────────────────────────────────────
installed_ver() {
    if [ "$PM" = apk ]; then
        apk list -I "$PKG" 2>/dev/null | sed -n "s/^$PKG-\([^ ]*\) .*/\1/p" | head -1
    else
        opkg info "$PKG" 2>/dev/null | sed -n 's/^Version: *//p' | head -1
    fi
}

# 版本号只比「主体部分」：apk 里固件集成包会带 -r1，仓库包不带；
# 直接字符串比会把「已经装好」判成失败（2026-11 实测）。
ver_base() { printf '%s' "$1" | sed 's/^v//; s/-r[0-9][0-9]*$//'; }

# 装完要验的几样：命令行、LuCI 菜单、LuCI 的三个 view + 它们的公共件 ——
# 缺了 menu 项那页 404，缺 view / common.js 那几页白屏或 404。
# ⚠️ 定义在这儿（不是装完才用）：判断"要不要装"的时候就得先看它们在不在。
NEED="/usr/sbin/mtun-xd /etc/init.d/mihomo /usr/share/luci/menu.d/$PKG.json /usr/share/rpcd/acl.d/$PKG.json
      /www/luci-static/resources/mtun-xd/common.js
      /www/luci-static/resources/view/mtun-xd/panel.js
      /www/luci-static/resources/view/mtun-xd/generator.js
      /www/luci-static/resources/view/mtun-xd/upgrade.js"
missing() {
    # 主脚本没有执行位 = CLI 全废（tar 里的权限偶尔会丢）
    [ -x /usr/sbin/mtun-xd ] || { echo "/usr/sbin/mtun-xd（没有执行位）"; return 0; }
    for f in $NEED; do [ -e "$f" ] || { echo "$f"; return 0; }; done
    # ⚠️ 真正被加载的是 menu.d 里那几个**带指纹**的文件名（build.py 换的名），
    #    只查上面那份不带指纹的原件会漏判 —— 原件留着只是给老会话兜底。
    for p in $(sed -n 's/^[[:space:]]*"path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
                "/usr/share/luci/menu.d/$PKG.json" 2>/dev/null); do
        f="/www/luci-static/resources/view/$p.js"
        [ -e "$f" ] || { echo "$f"; return 0; }
    done
    # 三页 require 的都是**带指纹**那份（common_<版本>_<指纹>.js）
    ls /www/luci-static/resources/mtun-xd/common_*.js >/dev/null 2>&1 \
        || { echo "/www/luci-static/resources/mtun-xd/common_<版本>.js"; return 0; }
    return 1
}

# 包该带起来的三样：核心 / 面板 / 配置工具。
# ⚠️ 只比包版本号是不够的：「包在、但这三样没装上（postinst 的 setup 没跑成、或者被人
#    删过）」的机器，一行装必须能救回来 —— 只看版本会直接打个 ✔ 已是最新 就退出。
READY="/etc/mihomo/mihomo /etc/mihomo/ui/index.html /etc/mihomo/ui/config/index.html"
notready() {
    for f in $READY; do [ -e "$f" ] || { echo "$f"; return 0; }; done
    return 1
}

# 内核真在跑没有（装完必须能满足正常运行）。
# ⚠️ 只看"文件在不在"不够：配置坏 / 缺 TUN / 端口被占，包都在、内核却起不来。
core_running() {
    [ -x /usr/sbin/mtun-xd ] || return 1
    # 用 `corestate`（只输出 on/off，跟显示文案解耦）。
    # 本仓库从 2026.11 起就带这个命令，不再需要「老版本没有它」的回退分支。
    [ "$(/usr/sbin/mtun-xd corestate 2>/dev/null | head -1)" = on ]
}

# ── 问最新版本号 ──────────────────────────────────────────────────────────
# ① 先问自己家：dist/latest.txt（build.py 每次发版写进去）
tag=$(curl -fsSL --connect-timeout 10 -m 20 "$CF/latest.txt" 2>/dev/null | tr -d '\r\n')
[ -n "$tag" ] || tag=$(curl -fsSL --connect-timeout 10 -m 20 "$RAW/dist/latest.txt" 2>/dev/null | tr -d '\r\n')
# ② 退到 GitHub：用 release 页的 302 解析 tag，不吃 API 配额（跟套件里那套一样）
if [ -z "$tag" ]; then
    for m in $MIRRORS; do
        tag=$(curl -sI --connect-timeout 10 --user-agent "Mozilla/5.0" \
                  "$m/$REPO/releases/latest" 2>/dev/null \
            | sed -n 's|.*[Ll]ocation: .*/tag/\([^[:space:]]*\).*|\1|p' | tr -d '\r')
        [ -n "$tag" ] && break
    done
fi
[ -n "$tag" ] || die "套件：拿不到最新版本号（连不上 GitHub？）—— 可以手动下载装包再装，见 README"
# 两边都抹掉 v 再比（GitHub 的 tag 带 v，apk/opkg 里装出来的不带）
latest="${tag#v}"
cur=$(installed_ver)

# 包文件名按**刚查到的 latest** 拼（不再用脚本里写死的版本，见文件头那段）
if [ "$PM" = apk ]; then
    FILE="$PKG-$latest.apk"
else
    FILE="${PKG}_${latest}_all.ipk"
fi

# 装过、版本一样、包文件也齐 → 不再下包重装。想强制重装：先 remove 再跑。
# ⚠️ 但核心/面板/配置工具那三样缺了的得救回来：不重装包，让套件自己的 setup 去补齐
#    （它那套拉取 + 多镜像回退都在）。
# ⚠️ pkg 模式不许走这条 —— 那个模式是"把包文件换掉"，版本一样也得重装（文件可能被别的
#    包删过 / postinst 没跑全）。
if [ "$ONLY_PKG" = 0 ] && [ "$cur" = "$latest" ] && [ -z "$(missing)" ]; then
    nrd=$(notready)
    if [ -z "$nrd" ]; then
        ui_step "1/6 安装套件"
        ui_ok "已安装 luci-app-mtun-xd $cur"
        MTUN_XD_STEPS=1 MTUN_XD_EMBEDDED=1 \
            MIHOMO_KIT_NO_SELFUPGRADE=1 /usr/sbin/mtun-xd setup
        exit $?
    fi
    say "⚠️ 套件：核心 / 面板 / 配置工具缺（$nrd 不在）—— 跑一次 setup"
    setuprc=0
    # ⚠️ 跟下面那条 setup 用同一套环境：不许触发 kit 的「顺手升级控制台」
    #    （它会跟本脚本的安装锁打起来），步骤输出由本脚本统一接管。
    MTUN_XD_STEPS=1 MTUN_XD_EMBEDDED=1 \
        MIHOMO_KIT_NO_SELFUPGRADE=1 /usr/sbin/mtun-xd setup || setuprc=$?
    nrd=$(notready)
    # setup 也没补齐（网络不通、或者它自己半坏）→ 别卡死在这儿，落下去重装整包
    if [ -z "$nrd" ] && [ "$setuprc" = 0 ]; then
        # ⚠️ 快路径也得过最后那道「内核真在跑」的断言，否则「包在、内核没起来」的机器会被
        #    打一句成功就放走。
        if core_running; then
            exit 0
        fi
        say "✘ 套件：部署完成，但内核没在跑 —— 先看 tail -n 30 /tmp/mtun-xd.log，"
        say "   再看 logread -e mihomo；修好后再跑一次这个脚本"
        exit 1
    fi
    [ "$setuprc" = 0 ] || say "⚠️ 套件：setup 报失败（环境 / 配置不满足，见上面）—— 重装一遍包再试"
    say "⚠️ 套件：setup 没补齐 —— 重装一遍包"
fi

ui_step "1/6 安装套件"

# ⚠️ 装包之前先清一次 LuCI 菜单缓存：它记着旧版的页面文件名（generator_8937_xxx.js），
#    不清的话装到一半断线就留下一个"菜单指向已删除文件"的 404。装完末尾还会再清一次。
rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null

TMP="${TMPDIR:-/tmp}/mtun-xd-install.$$"
mkdir -p "$TMP" || die "建不了临时目录 $TMP"

# 跑包管理器：滤掉两种流水账 ——「Removing obsolete file …」（每发一版都会删掉上一版
# 那几个带版本号的页面文件）和 apk 的「N error(s); X MiB in N packages」汇总行
# （本机 Argon 是本地 .apk 装的，仓库里没有它，apk 收尾会计 1 个 error，与本次安装无关）。
# 真正的失败行（ERROR: …）照旧显示；输出实时，退出码借临时文件从管道里捞回来。
pm() {
    # ⚠️ 一定要 `</dev/null`：这个脚本是 `curl | sh` 灌进来的，包管理器继承了 stdin 就会跟
    #    脚本正文抢流（它一问 Y/N，后面的脚本就被吃掉了）。
    # ⚠️ 先清掉上一次的 rc：退避分支里子 shell 要是被 kill，留着上一次的 0 会被当成成功。
    [ -n "${TMP:-}" ] && rm -f "$TMP/rc"
    ( "$@" </dev/null 2>&1; echo $? > "$TMP/rc" ) | sed         -e '/^Removing obsolete file/d'         -e '/^[0-9][0-9]* error; .* in [0-9][0-9]* packages$/d'         -e '/^[0-9][0-9]* errors; .* in [0-9][0-9]* packages$/d'         -e '/^OK: .* in [0-9][0-9]* packages$/d'
    local _rc
    _rc=$(cat "$TMP/rc" 2>/dev/null)
    [ -n "$_rc" ] && return "$_rc"
    return 1
}

# ── 下装包（挨个来源轮着试）───────────────────────────────────────────────
# ⚠️ 不问也不打"从哪下的"。
got=0
if curl -fL --retry 1 --connect-timeout 15 -m 300 --user-agent "Mozilla/5.0" \
        -o "$TMP/$FILE" "$CF/$FILE" 2>/dev/null; then
    got=1
fi
for m in $MIRRORS; do
    [ "$got" = 1 ] && break
    if curl -fL --retry 1 --connect-timeout 15 -m 300 --user-agent "Mozilla/5.0" \
            -o "$TMP/$FILE" "$m/$REPO/releases/download/$tag/$FILE" 2>/dev/null; then
        got=1
    fi
done
[ "$got" = 1 ] || die "套件：包没下来（GitHub 和所有镜像都试过了）—— 手动下载再装吧，见 README"

# ── 校验：摘要必须拿得到，且必须对上 ────────────────────────────────────────
# 顺序：仓库 dist/SHA256SUMS → GitHub Release 资产自带的 digest。
# 两条都拿不到时**拒绝安装**（老部署没有 SHA256SUMS 也一样）—— 「没校验就装」
# 等于把完整性交给了网络环境。确认来源可信时可显式跳过：
#   MIHOMO_ALLOW_UNVERIFIED=1 sh install.sh
sums=$(curl -fsSL --connect-timeout 10 -m 30 "$CF/SHA256SUMS" 2>/dev/null)
[ -n "$sums" ] || sums=$(curl -fsSL --connect-timeout 10 -m 30 "$RAW/dist/SHA256SUMS" 2>/dev/null)
want=''
[ -n "$sums" ] && want=$(printf '%s\n' "$sums" | awk -v f="$FILE" '$2 == f || $2 == "*" f { print $1; exit }')
if [ -z "$want" ]; then
    meta=$(curl -fsSL --connect-timeout 10 -m 30 -H 'Accept: application/vnd.github+json' \
        "https://api.github.com/repos/$REPO/releases/tags/$tag" 2>/dev/null)
    if [ -n "$meta" ]; then
        want=$(printf '%s' "$meta" | tr ',{}' '\n\n\n' | tr -d ' ' | awk -v f="\"name\":\"$FILE\"" '
            index($0, f) { hit = 1; next }
            hit && index($0, "\"name\":") { exit }
            hit && match($0, /"digest":"sha256:[0-9a-fA-F]+"/) {
                s = substr($0, RSTART, RLENGTH)
                sub(/^"digest":"sha256:/, "", s); sub(/"$/, "", s)
                print tolower(s); exit
            }')
    fi
fi
if [ -z "$want" ]; then
    if [ "${MIHOMO_ALLOW_UNVERIFIED:-0}" = 1 ] || [ "${MTUN_XD_ALLOW_UNVERIFIED:-0}" = 1 ]; then
        printf '⚠️  取不到官方摘要，按 MIHOMO_ALLOW_UNVERIFIED=1 继续\n'
    else
        die "套件：取不到官方 SHA-256 摘要，拒绝安装（网络问题？确认可信可设 MIHOMO_ALLOW_UNVERIFIED=1）"
    fi
elif command -v sha256sum >/dev/null 2>&1; then
    got_hash=$(sha256sum "$TMP/$FILE" | cut -d' ' -f1)
elif command -v openssl >/dev/null 2>&1; then
    got_hash=$(openssl dgst -sha256 "$TMP/$FILE" | sed 's|.*[ =]||')
else
    got_hash=''
fi
if [ -n "$want" ]; then
    [ -n "$got_hash" ] || die "套件：系统里没有 sha256sum / openssl，无法校验安装包"
    [ "$got_hash" = "$want" ] || die "套件：包校验失败（下载不完整？重跑一次）"
fi

# ⚠️ 老 opkg 不会自己建父目录（wfopen: … No such file or directory，文件一个都写不进去）。
#    包里现在带目录条目了，这里再兜一道，双保险。
mkdir -p /www/luci-static/resources/mtun-xd \
         /www/luci-static/resources/view/mtun-xd \
         /usr/share/luci/menu.d /usr/share/rpcd/acl.d 2>/dev/null

# 只把 ipk 里 data.tar.gz 的文件铺到 / —— 不跑 prerm/postinst、不碰 opkg 数据库。
# ⚠️ 为什么需要它：`opkg install --force-reinstall` 走 remove + install，而 remove 跑的是
#    已安装那一版自带的 prerm —— 老版本不认我们新加的 pkg-only 标记，会把核心 / 面板 /
#    配置工具整套卸掉。同版本补文件 / 只换包一律用这个，绝不 remove。
ipk_overlay() {
    # 整个 ipk 只有几十 KB，先解到临时目录再铺 —— 不依赖 tar 的“按成员名提取”
    # 在 BusyBox / GNU tar 上行为一致。
    rm -rf "$TMP/ipk"
    mkdir -p "$TMP/ipk"
    tar -xzf "$1" -C "$TMP/ipk" 2>/dev/null \
        || { echo "✘ 套件：包解不开"; return 1; }
    [ -f "$TMP/ipk/data.tar.gz" ] \
        || { echo "✘ 套件：包里没有 data.tar.gz"; return 1; }
    tar -xzf "$TMP/ipk/data.tar.gz" -C / || { echo "✘ 套件：铺文件失败"; return 1; }
    chmod +x /usr/sbin/mtun-xd /etc/init.d/mihomo 2>/dev/null
    rm -rf "$TMP/ipk"
    return 0
}

if [ "$ONLY_PKG" = 1 ]; then
    # ⚠️ 同版本必须真的换文件：`apk add` / `opkg install` 同版本都会说"已是最新 / up to date"
    #    然后一个字节都不换，这个模式就失去意义了。
    #    · apk：`--no-scripts --force-reinstall`（apk 不跑 prerm/postinst，安全）
    #    · opkg：绝不能 --force-reinstall（remove+install 会跑已安装那一版的 prerm，老版本
    #      不认新标记，会把核心/面板/工具整套卸掉）⇒ 同版本用 ipk_overlay 铺文件，
    #      不同版本用普通 `opkg install`（参数是 upgrade，老 prerm 本来就会跳过）。
    if [ "$PM" = apk ]; then
        # ⚠️ apk 退出码不能全信：手工装过非仓库版包（如 Argon 3.1.0-r1）的机器每次都会多报
        #    「1 error」（apk fix 里是 APK unavailable），包其实装好了 ⇒ 下面用版本/文件判定。
        pm apk add --no-scripts --allow-untrusted --force-reinstall "$TMP/$FILE" || true
    elif [ "$cur" = "$latest" ]; then
        ipk_overlay "$TMP/$FILE" || die "套件：换包失败（铺文件出错）"
    else
        : > "$MARK"
        MARK_OWNED=1
        pm opkg install "$TMP/$FILE" || { mark_clear; die "套件：安装失败"; }
        mark_clear
    fi
    mark_clear
    # 版本为准（apk 的退出码可能是环境噪音，见上面那段注释）
    [ "$(ver_base "$(installed_ver)")" = "$(ver_base "$latest")" ] || die "套件：安装失败（版本没对上：$(installed_ver)）"
    # 换完验一遍文件在不在（包坏了 / 被别的包删过都得能看出来）
    bad=$(missing)
    [ -z "$bad" ] || die "套件：包换了但文件还缺：$bad"
    # LuCI 的菜单缓存里还记着**旧版页面文件名** —— 不清掉，当前会话点菜单还是旧界面
    #（文件已经换了，只会 404 / 吃浏览器缓存）。清这个不会踢人下线。
    rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null
    rm -rf /tmp/luci-modulecache 2>/dev/null
    # ⚠️ 打实际装上的版本，别打 $latest —— CF 还在发旧包时，apk/opkg 会打一句"没事干"就退了，
    #    那时候打 $latest 就是撒谎。
    gotver=$(installed_ver)
    # ⚠️ pkg 模式不跑 postinst，但界面/主题必须跟上，否则永远停在旧版。三步都幂等：
    #    seed-panel 纯本地；expose ensure 只在没挂好时动；tool 每次都重下一份 kit。
    kitok=1
    if [ -x /usr/sbin/mtun-xd ]; then
        /usr/sbin/mtun-xd seed-panel >/dev/null 2>&1 || kitok=0
        [ -f /etc/mtun-xd.expose-off ] || /usr/sbin/mtun-xd expose ensure >/dev/null 2>&1
        # ⚠️ 装包这条路上不许触发 kit 的「顺手升级控制台」—— 会跟本脚本的安装锁打起来
        MIHOMO_KIT_NO_SELFUPGRADE=1 /usr/sbin/mtun-xd tool             || { say "⚠️ 配置工具：没对齐（网络？）—— 之后再跑一次 install.sh"; kitok=0; }
    fi
    # ⚠️ 「配置工具已对齐」不能无条件写：tool 失败的那趟它是在撒谎（自动化还会当成成功）
    kitrc=0
    # ⚠️ 「控制台升级」那条走的是这个 pkg 分支 —— 收尾行按调用方换说法（其余流程一个字不动）
    if [ "${MTUN_XD_CONSOLE:-0}" = 1 ]; then
        if [ "$kitok" = 1 ]; then
            say "✔ 控制台升级完成：已装${gotver:-$latest}"
        else
            say "⚠️ 控制台升级完成：已装${gotver:-$latest}（配置工具没对齐）"
            kitrc=1
        fi
    elif [ "$kitok" = 1 ]; then
        say "✔ 套件：已装${gotver:-$latest}（只换包：核心 / 面板没动；配置工具已对齐）"
    else
        say "⚠️ 套件：已装${gotver:-$latest}（只换包：核心 / 面板没动；配置工具没对齐）"
        kitrc=1
    fi
    # 新机器上直接跑 pkg 模式：包装上了，但那三样一个都没有 —— 必须说清楚，
    # 不然用户看到 ✔ 会以为整套能用了。
    nrd=$(notready)
    [ -z "$nrd" ] || say "⚠️ 核心 / 面板 / 配置工具还没装 —— 要装就再跑一次 install.sh（不带 pkg）"
    exit $kitrc
fi

if [ "$PM" = apk ]; then
    apk update >/dev/null 2>&1 || say "    ⚠️ apk update 没成功，继续"
    pm apk add --allow-untrusted --no-scripts "$TMP/$FILE" >"$TMP/pm.log" 2>&1 || true
    # 同上：以实际装上的版本为准
    [ "$(ver_base "$(installed_ver)")" = "$(ver_base "$latest")" ] || die "套件：安装失败（版本没对上：$(installed_ver)）"
    # ⚠️ 跟 opkg 那边一个道理：同一个版本在装的时候，包管理器多半只会说「已经装了」然后
    #    什么都不干（postinst 也不跑）→ 缺的文件永远补不回来。装完统一验一遍，缺了就强制重装。
    bad=$(missing)
    if [ -n "$bad" ]; then
        say "    ⚠️ $bad 不在 —— 强制重装一遍"
        # ⚠️ --no-scripts ⇒ postinst 不会跑，别留那个标记（留了也没人看）；
        #    setup 由下面那段 notready 检查补跑。
        pm apk add --allow-untrusted --no-scripts --force-reinstall "$TMP/$FILE" \
            >"$TMP/pm.log" 2>&1 || true
        bad=$(missing)
    fi
    [ -z "$bad" ] || die "套件：装是装上了，但文件还是缺：$bad"
else
    opkg update >/dev/null 2>&1 || say "    ⚠️ opkg update 没成功，继续"
    : > "$MARK"
    MARK_OWNED=1
    pm opkg install "$TMP/$FILE" >"$TMP/pm.log" 2>&1 || { mark_clear; die "套件：安装失败"; }
    mark_clear
    # ⚠️ opkg 对同一个版本会直接说 "…is up to date" 然后什么都不干 —— 上一次要是没装全
    #    （或者文件被别的包删过），它永远不会补回来，而且连 postinst 都不会跑。所以自己验一遍：
    bad=$(missing)
    if [ -n "$bad" ]; then
        say "    ⚠️ opkg 说已是最新，但 $bad 不在 —— 直接把包里的文件补回去"
        # ⚠️ 这里绝不能 `--force-reinstall`（走 remove+install，跑的是已安装那一版的 prerm ——
        #    老版本会趁机把核心/面板/工具整套卸掉）。只铺 data.tar.gz，不跑维护脚本、不碰数据库。
        ipk_overlay "$TMP/$FILE" || die "套件：补文件失败"
        bad=$(missing)
    fi
    [ -z "$bad" ] || die "套件：装是装上了，但文件还是缺：$bad（之后再跑一次这个脚本试试）"
fi

# postinst 被 --no-scripts / 标记文件跳过了；这里补上它原本负责、setup 又不会做的两件事。
if [ -f /etc/init.d/mihomo.apk-new ]; then
    mv -f /etc/init.d/mihomo.apk-new /etc/init.d/mihomo
fi
chmod +x /usr/sbin/mtun-xd /etc/init.d/mihomo /etc/init.d/mtun-xd-selfcheck 2>/dev/null
/etc/init.d/mtun-xd-selfcheck enable >/dev/null 2>&1 || true
ui_ok "已安装 luci-app-mtun-xd $(installed_ver)"

# ⚠️ 装完再看一眼那三样：postinst 里的 setup 要是因为网络没拉成（它只警告不失败），
#    这里补跑一次 —— 免得留下一台"包在、三样全缺"的机器。
# 菜单缓存清掉（旧版页面文件名），当前会话下一次导航就按新菜单走
rm -rf /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null

# 不管核心 / 面板是不是已经齐全，都完整跑一遍六步；已有组件显示“已就位”。
# 这样全新安装和升级的输出形状一致，也不会因为快路径判断而只打第 1 步就结束。
setuprc=0
MTUN_XD_STEPS=1 MTUN_XD_EMBEDDED=1 \
    MIHOMO_KIT_NO_SELFUPGRADE=1 /usr/sbin/mtun-xd setup || setuprc=$?
nrd=$(notready)
[ -z "$nrd" ] || die "套件：还是缺 $nrd（网络不通？）—— 连上网再跑一次这个脚本"
[ "$setuprc" = 0 ] || die "套件：部署失败（见上面几行）"

# ── 最后一道：装完必须真的在跑 ──
# 文件齐、版本对都不算数 —— 配置坏 / 缺 TUN / 端口被占，内核照样起不来。
# ⚠️ 开机 5 分钟内启动内核会先等 40 秒（见 /etc/init.d/mihomo 的开机延迟）——
#    这里必须跟着等，否则刚开机装完会立刻判「没在跑」。
if ! core_running; then
    say "→ 套件：内核还没起来（开机延迟 40 秒），等待中…"
    _wait=0
    while [ "$_wait" -lt 60 ]; do
        sleep 1
        _wait=$((_wait + 1))
        core_running && break
    done
fi
if ! core_running; then
    say "✘ 套件：装完了，但内核没在跑 —— 先看 tail -n 30 /tmp/mtun-xd.log，"
    say "   再看 logread -e mihomo；修好后再跑一次这个脚本"
    exit 1
fi

# ⚠️ 这里不再打收尾那句「✔ 装好了 —— 路由器界面…」—— 包自己的 setup 收尾已经打了，
#    同一件事不说两遍。

# ⚠️ CF 刚部署完那一小瞬，静态文件可能还是上一版：`apk add` 对"看起来已经装了"的同版本
#    包会直接说没事干 → 实际装的还是旧版。只在版本不一致时点一句，不给正常安装加噪音。
gotver=$(installed_ver)
if [ -n "$gotver" ] && [ "$(ver_base "$gotver")" != "$(ver_base "$latest")" ]; then
    say "⚠️ 套件：装上的还是 $gotver（CF 可能还在发旧包）—— 过一两分钟再跑一次"
fi
