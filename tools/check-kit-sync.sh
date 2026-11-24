#!/bin/sh
# 检查 dist/ 里的配置工具包与 GitHub genkit Release 的官方摘要是否一致。
#
# 为什么需要：套件升级配置工具时会比对「CF 托管文件」和「genkit Release 摘要」。
# 两边不同源（比如本地跑过 make-router-kit 却没提交 dist）就会报「校验失败」。
# 发布前跑一次，或者排查客户报「拿不到/校验失败」时跑一次。
#
# 用法：
#   sh tools/check-kit-sync.sh            # 比对 dist/ 本地文件
#   sh tools/check-kit-sync.sh --remote   # 比对线上 CDN 上的文件
#
# 退出码：0 一致；1 有差异或取不到。

set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
CF=https://mtun-xd.wxcircle.top
API=https://api.github.com/repos/OpenWrt-MTUN-XD/genkit/releases/tags/genkit
MODE=${1:-local}

# ⚠️ 直连 api.github.com：匿名配额只有 60 次/小时，撞上就取不到（拿不到只报错，不误判）。
#    有 GITHUB_TOKEN / GH_TOKEN 就带上 —— CI runner 是共享 IP，不带很容易 403 把发版卡红。
api_get() {
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        curl -fsSL -m 30 -H 'Accept: application/vnd.github+json' \
            -H "Authorization: Bearer $GITHUB_TOKEN" "$1" 2>/dev/null
    elif [ -n "${GH_TOKEN:-}" ]; then
        curl -fsSL -m 30 -H 'Accept: application/vnd.github+json' \
            -H "Authorization: Bearer $GH_TOKEN" "$1" 2>/dev/null
    else
        curl -fsSL -m 30 -H 'Accept: application/vnd.github+json' "$1" 2>/dev/null
    fi
}
meta=$(api_get "$API")
[ -n "$meta" ] || { echo "✘ 取不到 genkit Release 元数据（网络？）"; exit 1; }
printf '%s' "$meta" | grep -q '"digest"' || { echo "✘ 元数据里没有 digest"; exit 1; }

TMP=$(mktemp -d) || exit 1
trap 'rm -rf "$TMP"' EXIT
bad=0

for f in generator.sh mihomo-deploy.tar.gz mihomo-deploy.zip; do
    if [ "$MODE" = "--remote" ]; then
        curl -fsSL -m 180 -o "$TMP/$f" "$CF/$f" 2>/dev/null || { echo "✘ $f：CDN 下载失败"; bad=$((bad + 1)); continue; }
        src='CDN'
    else
        [ -f "$ROOT/dist/$f" ] || { echo "✘ $f：dist/ 里没有"; bad=$((bad + 1)); continue; }
        cp "$ROOT/dist/$f" "$TMP/$f"
        src='dist'
    fi

    if command -v sha256sum >/dev/null 2>&1; then
        got=$(sha256sum "$TMP/$f" | cut -d' ' -f1)
    else
        got=$(openssl dgst -sha256 "$TMP/$f" 2>/dev/null | sed 's/.*[ =]//')
    fi

    want=$(printf '%s' "$meta" | tr ',{}' '\n\n\n' | tr -d ' ' | awk -v want="\"name\":\"$f\"" '
        index($0, want) { hit = 1; next }
        hit && index($0, "\"name\":") { exit }
        hit && match($0, /"digest":"sha256:[0-9a-fA-F]+"/) {
            s = substr($0, RSTART, RLENGTH)
            sub(/^"digest":"sha256:/, "", s); sub(/"$/, "", s)
            print tolower(s); exit
        }')

    if [ -z "$want" ]; then
        echo "✘ $f：官方没有 digest"; bad=$((bad + 1))
    elif [ "$got" = "$want" ]; then
        echo "✔ $f（$src）一致"
    else
        echo "✘ $f（$src）不一致"
        echo "    本地 $got"
        echo "    官方 $want"
        bad=$((bad + 1))
    fi
done

[ "$bad" = 0 ] && echo "全部一致" || echo "$bad 项不一致 —— 先跑 make-router-kit 让 dist 与 genkit 同源，再提交 dist"
[ "$bad" = 0 ]
