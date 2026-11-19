#!/bin/sh
# Shell 自检：语法（sh -n）+ ShellCheck。
#
# 用法：
#   sh tools/check-shell.sh            # 默认：语法错误 / ShellCheck error 级 → 失败
#   sh tools/check-shell.sh --strict   # 额外把 warning 也当失败（CI 目前不用）
#
# 口径说明（重要）：
#   · 这批脚本跑在 BusyBox ash 上，`local` 是能用的；ShellCheck 的 `-s sh` 会按
#     严格 POSIX 报 SC3043。所以门禁用 `-S error`，warning 只打印、不判死。
#   · 文件清单按行读（`while IFS= read -r`）—— 路径里带空格时 `for f in $FILES`
#     会把一个路径切成两段，`[ -f ]` 全假 → 一个文件都不查还报「全过」。
#
# 退出码：0 全过；1 有 error / 语法错。

set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STRICT=0
[ "${1:-}" = "--strict" ] && STRICT=1

# ⚠️ 不用 find：Windows 的 Git sh 里 PATH 可能先撞到 Windows 自带的 find.exe。
FILES="
$ROOT/package/usr/sbin/mtun-xd
$ROOT/package/etc/init.d/mihomo
$ROOT/package/etc/init.d/mtun-xd-selfcheck
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

have_sc=0
command -v shellcheck >/dev/null 2>&1 && have_sc=1

checked=0
bad=0
warn=0

# 按行读，保留空格；无扩展名脚本一样处理
while IFS= read -r f; do
    [ -n "$f" ] || continue
    [ -f "$f" ] || { echo "⚠️ 清单里的文件不存在，跳过：$f"; continue; }
    checked=$((checked + 1))

    if ! sh -n "$f" 2>/dev/null; then
        echo "✘ 语法错误：$f"
        sh -n "$f" 2>&1 | head -3
        bad=$((bad + 1))
        continue
    fi

    [ "$have_sc" = 1 ] || continue

    # error 级：门禁
    err=$(shellcheck -s sh -S error -f gcc "$f" 2>&1)
    if [ -n "$err" ]; then
        echo "✘ ShellCheck(error)：$f"
        printf '%s\n' "$err" | head -5
        bad=$((bad + 1))
        continue
    fi

    # warning 级：只打印，不判死（--strict 时判死）
    w=$(shellcheck -s sh -S warning -f gcc "$f" 2>/dev/null | grep -v 'error:' | head -5)
    if [ -n "$w" ]; then
        warn=$((warn + 1))
        if [ "$STRICT" = 1 ]; then
            echo "✘ ShellCheck(warning, strict)：$f"
            printf '%s\n' "$w"
            bad=$((bad + 1))
        fi
    fi
done <<EOF
$FILES
EOF

# 清单里一个都没查到 = 路径解析坏了，不能算「通过」
expected=$(printf '%s\n' "$FILES" | sed '/^[[:space:]]*$/d' | wc -l | tr -d ' ')
if [ "$checked" -ne "$expected" ]; then
    echo "✘ 清单解析失败：应查 $expected 个，实际只查到 $checked 个"
    bad=$((bad + 1))
fi

if [ "$have_sc" = 0 ]; then
    echo "未安装 shellcheck：只做了 sh -n 语法检查"
else
    echo "ShellCheck：error 级已过；warning 文件 $warn 个（不阻塞）"
fi

if [ "$bad" = 0 ]; then
    echo "✔ 检查通过（$checked 个文件）"
else
    echo "✘ 有 $bad 个文件未通过（共检查 $checked 个）"
fi
exit "$bad"
