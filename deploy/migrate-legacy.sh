#!/bin/sh
# 存量客户无感迁移：老套件 luci-app-mihomo-suite → 新套件 luci-app-mtun-xd
#
# 目标：**代理不断**。做法是全程不碰正在跑的 mihomo 进程：
#   1. 备份现场；
#   2. 把老包的 /usr/sbin/mihomo-suite 挪走 —— 老包的 prerm 靠它作「卸载时停服务 + 删核心/面板」的
#      实际动作，脚本不在，prerm 就只会做包管理器该做的删文件；
#   3. 卸老包（/etc/mihomo/mihomo、config.yaml、ui/、toolpass 都不属于包，原地保留）；
#   4. 装新包；
#   5. 跑 `mtun-xd setup`：它只在「核心换过 / 配置改过 / 没在跑」时才重启服务，这里三条都不成立；
#   6. 核对：进程号没变、config.yaml 哈希没变、状态正常。
#
# 用法（路由器上，root）：
#     curl -fsSL https://mtun-xd.wxcircle.top/migrate.sh -o /tmp/migrate.sh && sh /tmp/migrate.sh
#
# 断网窗口：只有「卸老包 → 装新包」之间几秒 —— 那期间 mihomo 进程照跑、TUN 路由不变，代理不断；
# 但 /etc/init.d/mihomo 会短暂缺失，所以这几秒内别重启路由器。
#
# 可选环境变量：
#     MTUN_XD_CF      镜像地址（默认 https://mtun-xd.wxcircle.top）
#     MTUN_XD_KEEP=1  保留迁移前的备份目录（默认也保留，只是不删）

set -u

CF=${MTUN_XD_CF:-https://mtun-xd.wxcircle.top}
OLD=luci-app-mihomo-suite
NEW=luci-app-mtun-xd
TS=$(date +%Y%m%d-%H%M%S)
BK=${MTUN_XD_BK:-/tmp/mtun-xd-migrate-$TS}

say() { printf '%s\n' "$*"; }
warn() { printf '⚠️ %s\n' "$*"; }
die() { printf '✘ %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die '要用 root 跑'

# ── 0) 包管理器 / 现状 ─────────────────────────────────────────────
if command -v apk >/dev/null 2>&1; then
    PM=apk
elif command -v opkg >/dev/null 2>&1; then
    PM=opkg
else
    die '认不出包管理器（没有 apk 也没有 opkg）'
fi

pkg_installed() {
    case "$PM" in
        apk)  apk info -e "$1" >/dev/null 2>&1 ;;
        opkg) opkg list-installed 2>/dev/null | grep -q "^$1 " ;;
    esac
}

pkg_version() {
    case "$PM" in
        apk)  apk list -I "$1" 2>/dev/null | head -1 | sed -n 's/^[^ ]*-\([0-9][^ ]*\) .*/\1/p' ;;
        opkg) opkg list-installed 2>/dev/null | awk -v p="$1" '$1==p {print $3}' | head -1 ;;
    esac
}

if pkg_installed "$NEW" && ! pkg_installed "$OLD"; then
    say "✔ 这台已经是新套件 $NEW $(pkg_version "$NEW")，不需要迁移"
    exit 0
fi

if ! command -v curl >/dev/null 2>&1; then
    die '没有 curl（新套件安装也依赖它）'
fi

say "▶ 迁移：$OLD → $NEW（包管理器：$PM）"

# ── 1) 现场记录 + 备份 ────────────────────────────────────────────
PID0=$(pidof mihomo 2>/dev/null | awk '{print $1}')
[ -n "${PID0:-}" ] || warn 'mihomo 现在没在跑 —— 迁移不会让它更糟，但这次不保证「无感」'
CFG=/etc/mihomo/config.yaml
SHA0=''
[ -f "$CFG" ] && SHA0=$(sha256sum "$CFG" 2>/dev/null | awk '{print $1}')

mkdir -p "$BK" || die "建不了备份目录 $BK"
chmod 700 "$BK"
for f in /etc/config/mihomo-suite /etc/config/uhttpd /etc/config/haproxy /etc/mihomo-toolpass; do
    [ -f "$f" ] && cp -f "$f" "$BK/" 2>/dev/null
done
[ -f "$CFG" ] && cp -f "$CFG" "$BK/config.yaml" 2>/dev/null
[ -f /usr/sbin/mihomo-suite ] && cp -f /usr/sbin/mihomo-suite "$BK/mihomo-suite.old" 2>/dev/null
[ -f /etc/mihomo-kwrt-nginx.prev ] && cp -f /etc/mihomo-kwrt-nginx.prev "$BK/" 2>/dev/null
say "  备份：$BK"

# ── 2) 停掉老包的开机自检 / 首次启动（卸载后它们还会跑）────────────
for s in mihomo-suite-selfcheck mihomo-suite-firstboot; do
    [ -x "/etc/init.d/$s" ] && "/etc/init.d/$s" disable >/dev/null 2>&1
done

# ── 3) 让老包的 prerm 失效（关键：它一跑就会停内核、删核心/面板）────
if [ -f /usr/sbin/mihomo-suite ]; then
    mv -f /usr/sbin/mihomo-suite "$BK/mihomo-suite.moved" || die '挪不动 /usr/sbin/mihomo-suite'
fi

# ── 4) 卸老包（此时 prerm 里的 `[ -x /usr/sbin/mihomo-suite ]` 不成立）──
if pkg_installed "$OLD"; then
    say "→ 卸载 $OLD（保留核心 / 配置 / 工具密码）"
    case "$PM" in
        apk)  apk del "$OLD" >/dev/null 2>&1 ;;
        opkg) opkg remove "$OLD" >/dev/null 2>&1 ;;
    esac
    pkg_installed "$OLD" && {
        mv -f "$BK/mihomo-suite.moved" /usr/sbin/mihomo-suite 2>/dev/null
        die '老包没卸掉 —— 已恢复旧脚本，现场未改动'
    }
else
    warn '老包不在包管理器里（手工铺的？）—— 只挪走脚本，不调包管理器'
fi

# ── 4.5) 清老套件残留 ────────────────────────────────────────────
# 包管理器只删它登记过的文件；下面这些是运行时/手工铺出来的，必须自己清：
#   · /etc/rc.d 里指向已删 init 的悬空链接（老 postinst 跑的 enable）
#   · 老套件的 LuCI 菜单 / ACL / 页面目录（手工装或残留时）
#   · /tmp 里的老标记与日志
#   · /etc/config/mihomo-suite（老套件自己的设置；新套件不读，备份里已留一份）
scrub_old() {
    rm -f /usr/sbin/mihomo-suite 2>/dev/null
    rm -f /etc/init.d/mihomo-suite-selfcheck /etc/init.d/mihomo-suite-firstboot 2>/dev/null
    rm -f /etc/config/mihomo-suite 2>/dev/null
    rm -f /usr/share/luci/menu.d/luci-app-mihomo-suite.json 2>/dev/null
    rm -f /usr/share/rpcd/acl.d/luci-app-mihomo-suite.json 2>/dev/null
    rm -rf /www/luci-static/resources/view/mihomo-suite 2>/dev/null
    rm -rf /www/luci-static/resources/mihomo-suite 2>/dev/null
    rm -f /tmp/mihomo-suite.* 2>/dev/null
    # 悬空的开机链接（只删链接本身，别碰 /etc/init.d/mihomo —— 那是新套件的）
    for l in /etc/rc.d/*mihomo-suite*; do
        [ -e "$l" ] || [ -L "$l" ] || continue
        case "$l" in
            *mihomo-suite*) rm -f "$l" 2>/dev/null ;;
        esac
    done
}
scrub_old

# ── 5) 装新包 ─────────────────────────────────────────────────────
VER=$(curl -fsSL -m 30 "$CF/latest.txt" 2>/dev/null | tr -d ' \t\r\n' | sed 's/^v//')
case "$VER" in
    ''|*[!0-9.]*) die "取不到新版本号（$CF/latest.txt）—— 老包已卸，核心仍在跑；稍后重跑本脚本即可" ;;
esac
say "→ 安装 $NEW $VER"
TMPD=$(mktemp -d /tmp/mtun-xd-migrate.XXXXXX) || die '建不了临时目录'
case "$PM" in
    apk)
        PKG="$TMPD/$NEW-$VER.apk"
        curl -fsSL -m 120 "$CF/$NEW-$VER.apk" -o "$PKG" || die "下载失败：$CF/$NEW-$VER.apk"
        apk add --allow-untrusted "$PKG" >/dev/null 2>&1
        ;;
    opkg)
        PKG="$TMPD/${NEW}_${VER}_all.ipk"
        curl -fsSL -m 120 "$CF/${NEW}_${VER}_all.ipk" -o "$PKG" || die "下载失败：$CF/${NEW}_${VER}_all.ipk"
        opkg install "$PKG" >/dev/null 2>&1
        ;;
esac
pkg_installed "$NEW" || {
    warn '包没装上 —— 回落用官方安装脚本再试一次'
    curl -fsSL -m 60 "$CF/install.sh" -o "$TMPD/install.sh" && sh "$TMPD/install.sh"
}
pkg_installed "$NEW" || die "新包安装失败（核心仍在跑）。手动重试：curl -fsSL $CF/install.sh | sh"
say "  ✔ 已安装 $NEW $(pkg_version "$NEW")"

# ── 6) 对齐（复用现成核心 / 配置；只有必要时才重启内核）───────────
say '→ 对齐套件（核心 / 配置 / 面板 / 配置工具 / 80 端口）'
if [ -x /usr/sbin/mtun-xd ]; then
    /usr/sbin/mtun-xd setup >/tmp/mtun-xd-migrate-setup.log 2>&1
    rc=$?
    [ "$rc" = 0 ] || warn "setup 退出码 $rc（详见 /tmp/mtun-xd-migrate-setup.log）"
else
    die '没找到 /usr/sbin/mtun-xd —— 新包不完整'
fi

scrub_old   # 装完再兜一遍（旧文件可能在包管理器删除后又冒出来）

# ── 7) 核对 ───────────────────────────────────────────────────────
ok=1
PID1=$(pidof mihomo 2>/dev/null | awk '{print $1}')
if [ -n "${PID0:-}" ]; then
    if [ "${PID1:-}" = "$PID0" ]; then
        say "  ✔ 内核进程未重启（pid $PID0）—— 代理没有中断"
    else
        warn "内核进程变了（$PID0 → ${PID1:-无}）：本次迁移重启过内核，连接会断一下"
        ok=0
    fi
fi
[ -n "$SHA0" ] && {
    SHA1=$(sha256sum "$CFG" 2>/dev/null | awk '{print $1}')
    [ "$SHA1" = "$SHA0" ] && say '  ✔ config.yaml 没被动过' || { warn 'config.yaml 变了！'; ok=0; }
}
/usr/sbin/mtun-xd status 2>/dev/null | sed 's/^/  /'
# 老套件残留必须为 0：包、脚本、菜单、ACL、页面目录、rc.d 链接
left=0
pkg_installed "$OLD" && { warn "老包还在：$OLD"; left=$((left+1)); }
for f in /usr/sbin/mihomo-suite /etc/config/mihomo-suite \
         /usr/share/luci/menu.d/luci-app-mihomo-suite.json \
         /usr/share/rpcd/acl.d/luci-app-mihomo-suite.json; do
    [ -e "$f" ] && { warn "残留文件：$f"; left=$((left+1)); }
done
[ -d /www/luci-static/resources/view/mihomo-suite ] && { warn '残留目录：view/mihomo-suite'; left=$((left+1)); }
[ -d /www/luci-static/resources/mihomo-suite ] && { warn '残留目录：resources/mihomo-suite'; left=$((left+1)); }
for l in /etc/rc.d/*mihomo-suite*; do
    { [ -e "$l" ] || [ -L "$l" ]; } || continue
    warn "残留开机项：$l"; left=$((left+1))
done
if [ "$left" = 0 ]; then say '  ✔ 老套件残留：0'; else ok=0; fi

c80=$(curl -s -o /dev/null -m 8 -w '%{http_code}' http://127.0.0.1/ui/ 2>/dev/null || echo 000)
[ "$c80" = 200 ] && say '  ✔ /ui/ 200' || warn "  ⚠️ /ui/ 返回 $c80（用 expose on 或稍后再看）"

rm -rf "$TMPD" 2>/dev/null

say ''
if [ "$ok" = 1 ]; then
    say "✔ 迁移完成：现在跑的是 $NEW $(pkg_version "$NEW")，代理全程未断。"
else
    say "⚠️ 迁移完成，但有上面的告警 —— 逐条看一眼。"
fi
say "  现场备份：$BK"
say "  套件设置页：路由器 → 服务 → 墨枢云境"
