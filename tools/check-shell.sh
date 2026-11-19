#!/bin/sh
# ShellCheck 自查（不阻塞 CI，开发时手动跑）。
# 用法：sh tools/check-shell.sh            # 装了就查
#       sh tools/check-shell.sh --strict   # 没装 ShellCheck 视为失败
#
# 为什么单独一个脚本而不是塞进 CI：ShellCheck 版本差异大，OpenWrt 用的 BusyBox ash
# 也有自己的方言；先把问题暴露出来，等规则稳定了再考虑进 CI 门禁。

set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

# 全部 shell 脚本都过一遍：只挑 4 个的话，control/ 与 openwrt/ 里的变量名拼错永远查不出来
# ⚠️ 不用 find：Windows 的 Git sh 里 PATH 可能先撞到 Windows 自带的 find.exe。
FILES="
$ROOT/package/usr/sbin/mtun-xd
$ROOT/install.sh
$ROOT/deploy/mihomo-haproxy.sh
$ROOT/deploy/mihomo-kwrt-nginx.sh
$ROOT/control/postinst
$ROOT/control/prerm
$ROOT/openwrt/files/mtun-xd-firstboot
$ROOT/generator/deploy/generator.sh
$ROOT/generator/deploy/mihomo-apply
$ROOT/tools/check-kit-sync.sh
$ROOT/tools/verify-kit-digest.sh
$ROOT/tools/check-shell.sh
$ROOT/tools/uninstall-check.sh
"

if ! command -v shellcheck >/dev/null 2>&1; then
    echo "未安装 shellcheck，跳过（安装：apk add shellcheck / apt install shellcheck）"
    [ "$STRICT" = 1 ] && exit 1
    exit 0
fi

rc=0
for f in $FILES; do
    [ -f "$f" ] || continue
    echo "== $f"
    # -s sh：按 POSIX sh 检查；-S warning：只报 warning 及以上
    if ! shellcheck -s sh -S warning "$f"; then
        rc=1
    fi
done

[ "$rc" = 0 ] && echo "ShellCheck：没有 warning 及以上问题" || echo "ShellCheck：存在问题（见上）"
exit $rc
