#!/bin/sh
# 比对 CF 上的 kit 资产与 genkit Release 的官方 digest
API=https://api.github.com/repos/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/releases/tags/genkit
cd /tmp || exit 1
meta=$(curl -fsSL -m 30 -H 'Accept: application/vnd.github+json' "$API") || { echo "no meta"; exit 1; }

for f in generator.sh mihomo-deploy.tar.gz mihomo-deploy.zip; do
    curl -fsSL -m 180 -o kit "$CF/$f" || { echo "$f: 下载失败"; continue; }
    a=$(sha256sum kit | cut -d' ' -f1)
    w=$(printf '%s' "$meta" | tr ',{}' '\n\n\n' | tr -d ' ' | awk -v want="\"name\":\"$f\"" '
        index($0, want) { hit = 1; next }
        hit && index($0, "\"name\":") { exit }
        hit && match($0, /"digest":"sha256:[0-9a-fA-F]+"/) {
            s = substr($0, RSTART, RLENGTH)
            sub(/^"digest":"sha256:/, "", s); sub(/"$/, "", s)
            print tolower(s); exit
        }')
    if [ -z "$w" ]; then
        echo "$f: 官方无 digest"
    elif [ "$a" = "$w" ]; then
        echo "$f: MATCH"
    else
        echo "$f: MISMATCH  本地=$a  官方=$w"
    fi
    rm -f kit
done
