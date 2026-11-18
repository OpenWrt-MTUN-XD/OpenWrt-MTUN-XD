#!/bin/sh
# Mihomo Suite —— Kwrt / OpenWrt + nginx 前端的同源适配
#
# 适用：80/443 由 nginx（luci-nginx + uwsgi）提供，uhttpd 没有 iStoreOS 的
#       「原始流代理」补丁（uhttpd -h 里没有 Proxy raw stream）。
#
# 做四件事：
#   1. 在 nginx 的 conf.d 里挂 16 条内核口子（/ui /version …）→ mihomo；
#   2. 起一个只监听 127.0.0.1:9091 的 uhttpd，专门执行 /www/cgi-bin/mihomo-apply；
#   3. 在 uhttpd 配置里写 16 条 proxy_prefix 占位，让 `mtun-xd expose status` 认出来；
#   4. TUN：补 kmod-tun / /dev/net/tun 持久化 / `/etc/firewall.include`。
#
# 用法：sh mihomo-kwrt-nginx.sh [install|on|off|status|uninstall]
#   默认 install；幂等，可反复跑。
set -u

PFX='ui version logs traffic memory configs proxies group rules connections providers cache dns storage restart upgrade'
CONFIG=/etc/mihomo/config.yaml
APPLY=/etc/mihomo/ui/config/mihomo-apply
WWW_APPLY=/www/cgi-bin/mihomo-apply
NGX_LOC=/etc/nginx/conf.d/mtun-xd.locations
UCI_CFG=uhttpd
UCI_SEC=mihomo
CGI_PORT=9091
STATE=/etc/mihomo-kwrt-nginx.state
ADDR_CACHE=/etc/mihomo-kwrt-nginx.addr
OFF_MARK=/etc/mtun-xd.expose-off
SUITE_ADDR_CACHE=/etc/mtun-xd.expose-addr

say()  { printf '%s\n' "$*"; }
die()  { printf '✘ %s\n' "$*" >&2; exit 1; }

# ── 环境 ────────────────────────────────────────────────────────
nginx_owns_80() {
    pidof nginx >/dev/null 2>&1 || return 1
    netstat -lnt 2>/dev/null | grep -q ':80 '
}

uhttpd_has_raw_proxy() {
    uhttpd -h 2>&1 | grep -q 'Proxy raw stream'
}

# ── 内核地址 ────────────────────────────────────────────────────
cfg_secret() {
    sed -n 's/^secret:[[:space:]]*//p' "$CONFIG" 2>/dev/null | head -1 | tr -d '"'\'' '
}

cfg_addr() {
    local a
    a=$(sed -n 's/^external-controller:[[:space:]]*//p' "$CONFIG" 2>/dev/null \
        | head -1 | tr -d '"'\'' ')
    [ -n "$a" ] || a=127.0.0.1:9090
    case "$a" in
        0.0.0.0:*) a="127.0.0.1:${a#0.0.0.0:}" ;;
        '[::]':*)  a="127.0.0.1:${a#\[::\]:}" ;;
    esac
    case "$a" in
        *:*) ;;
        *)   a="$a:9090" ;;
    esac
    printf '%s' "$a"
}

# 200/401 且正文是 JSON 才算答上了（跟套件 expose_probe 同一判据）
probe() {
    local out code
    [ -n "${1:-}" ] || return 1
    out=$(curl -s -m 2 -o - -w '\n@@%{http_code}' \
              -H "Authorization: Bearer $(cfg_secret)" \
              "http://$1/version" 2>/dev/null) || return 1
    code=${out##*@@}
    case "$code" in 200|401) ;; *) return 1 ;; esac
    case "$out" in '{'*) return 0 ;; esac
    return 1
}

lan_ips() {
    ip -4 addr show scope global 2>/dev/null \
        | sed -n 's/.*inet \([0-9][0-9.]*\)\/.*/\1/p'
}

pick_addr() {
    local a p c ip
    a=$(cat "$ADDR_CACHE" 2>/dev/null | tr -d ' \r\n')
    if [ -n "$a" ] && probe "$a"; then printf '%s' "$a"; return 0; fi
    p=$(printf '%s' "$(cfg_addr)" | sed 's/.*://')
    [ -n "$p" ] || p=9090
    for c in "$(cfg_addr)" "127.0.0.1:$p"; do
        if probe "$c"; then printf '%s' "$c" > "$ADDR_CACHE"; printf '%s' "$c"; return 0; fi
    done
    for ip in $(lan_ips); do
        c="$ip:$p"
        if probe "$c"; then printf '%s' "$c" > "$ADDR_CACHE"; printf '%s' "$c"; return 0; fi
    done
    for c in "127.0.0.1:9090"; do
        if probe "$c"; then printf '%s' "$c" > "$ADDR_CACHE"; printf '%s' "$c"; return 0; fi
    done
    for ip in $(lan_ips); do
        c="$ip:9090"
        if probe "$c"; then printf '%s' "$c" > "$ADDR_CACHE"; printf '%s' "$c"; return 0; fi
    done
    return 1
}

# ── uhttpd 里的占位（套件 expose status 认这 16 条）──────────────
strip_our_pfx() {
    local e name keep='' dropped=0
    uci -q show "$UCI_CFG.main.proxy_prefix" >/dev/null 2>&1 || return 1
    for e in $(uci -q show "$UCI_CFG.main.proxy_prefix" 2>/dev/null | tr ' ' '\n'); do
        e=${e#*proxy_prefix=}
        e=${e#\'}
        e=${e%\'}
        name=${e%%=*}
        name=${name#/}
        case " $PFX " in
            *" $name "*) dropped=1 ;;
            *) [ -n "$e" ] && keep="$keep $e" ;;
        esac
    done
    if [ "$dropped" = 1 ]; then
        uci -q delete "$UCI_CFG.main.proxy_prefix"
        for e in $keep; do
            uci -q add_list "$UCI_CFG.main.proxy_prefix=$e"
        done
        return 0
    fi
    return 1
}

write_our_pfx() {
    local p
    for p in $PFX; do
        uci -q add_list "$UCI_CFG.main.proxy_prefix=/$p=http://$1" \
            || die "uci 写不进 $UCI_CFG.main.proxy_prefix"
    done
}

# ── 状态文件（记下改动前的样子，uninstall/off 用）────────────────
UHTTPD_WAS_ENABLED=0
UHTTPD_WAS_RUNNING=0
MAIN_ENABLED_WAS=''
[ -f "$STATE" ] && . "$STATE"

save_state_once() {
    [ -f "$STATE" ] && return 0
    if ls /etc/rc.d/S*uhttpd >/dev/null 2>&1; then UHTTPD_WAS_ENABLED=1; fi
    if pidof uhttpd >/dev/null 2>&1; then UHTTPD_WAS_RUNNING=1; fi
    MAIN_ENABLED_WAS=$(uci -q get "$UCI_CFG.main.enabled" 2>/dev/null || true)
    {
        printf 'UHTTPD_WAS_ENABLED=%s\n' "$UHTTPD_WAS_ENABLED"
        printf 'UHTTPD_WAS_RUNNING=%s\n' "$UHTTPD_WAS_RUNNING"
        printf 'MAIN_ENABLED_WAS=%s\n' "$MAIN_ENABLED_WAS"
    } > "$STATE"
}

restore_main_enabled() {
    if [ -n "$MAIN_ENABLED_WAS" ]; then
        uci -q set "$UCI_CFG.main.enabled=$MAIN_ENABLED_WAS"
    else
        uci -q delete "$UCI_CFG.main.enabled"
    fi
}

# ── nginx 配置 ──────────────────────────────────────────────────
nginx_conf_path() {
    # 跟运行中的 nginx 用同一个路径（相对 include 的解析基准才一致）
    if [ -f /etc/nginx/uci.conf ]; then
        printf '%s' /etc/nginx/uci.conf
    elif [ -f /var/lib/nginx/uci.conf ]; then
        printf '%s' /var/lib/nginx/uci.conf
    else
        printf '%s' /etc/nginx/nginx.conf
    fi
}

nginx_test() {
    local conf
    conf=$(nginx_conf_path)
    /usr/sbin/nginx -t -c "$conf" -g 'daemon off;' 2>&1
}

write_nginx_loc() {
    local tmp="$NGX_LOC.new.$$"
    cat > "$tmp" <<'EOF'
# mtun-xd（Kwrt/nginx 版）—— 由 mihomo-kwrt-nginx.sh 生成，重跑会覆盖。
# 16 条内核口子：面板 / API / 配置工具全走同源。
# 写盘 CGI：转给只监听 127.0.0.1:9091 的 uhttpd；GET 由 CGI 自己回 405。
location = /cgi-bin/mihomo-apply {
    proxy_pass http://127.0.0.1:@CGI_PORT@;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}

location ~ ^/(ui|version|logs|traffic|memory|configs|proxies|group|rules|connections|providers|cache|dns|storage|restart|upgrade)(/|$) {
    proxy_pass http://@ADDR@;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $http_connection;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_send_timeout 3600s;
}
EOF
    sed -e "s|@CGI_PORT@|$CGI_PORT|g" -e "s|@ADDR@|$1|g" "$tmp" > "$tmp.out"
    mv "$tmp.out" "$NGX_LOC"
    rm -f "$tmp"
}

restore_nginx_loc() {
    if [ "${NGX_LOC_EXISTED:-0}" = 1 ]; then
        mv "$NGX_LOC.prev.$$" "$NGX_LOC"
    else
        rm -f "$NGX_LOC"
    fi
    /etc/init.d/nginx reload >/dev/null 2>&1
}

# ── 探测 ────────────────────────────────────────────────────────
wait_http() {
    local url="$1" want="$2" i=0 code=''
    while [ "$i" -lt 10 ]; do
        i=$((i + 1))
        code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$url" 2>/dev/null)
        [ "$code" = "$want" ] && return 0
        sleep 1
    done
    printf '%s' "${code:-000}"
    return 1
}

# ── TUN / fw4（自编译系统常见缺口）──────────────────────────────
tun_runtime() {
    local s
    s=$(cfg_secret)
    [ -n "$s" ] || return 1
    curl -s -m 5 -H "Authorization: Bearer $s" \
        "http://127.0.0.1:9090/configs" 2>/dev/null \
        | grep -o '"tun":{[^}]*}' | grep -q '"enable":true'
}

ensure_kmod_tun() {
    # 内核已经带 TUN（built-in 或已加载）就直接过
    grep -qi ' tun' /proc/misc 2>/dev/null && return 0
    [ -e /dev/net/tun ] && return 0
    if command -v opkg >/dev/null 2>&1; then
        if opkg list-installed 2>/dev/null | grep -q '^kmod-tun '; then
            modprobe tun 2>/dev/null || true
            return 0
        fi
        say "→ TUN：装 kmod-tun"
        opkg update >/dev/null 2>&1 || true
        opkg install kmod-tun >/dev/null 2>&1 || return 1
    elif command -v apk >/dev/null 2>&1; then
        if ! apk info -e kmod-tun >/dev/null 2>&1; then
            say "→ TUN：装 kmod-tun"
            apk add kmod-tun >/dev/null 2>&1 || return 1
        fi
    else
        return 1
    fi
    modprobe tun 2>/dev/null || true
    return 0
}

ensure_tun_node() {
    [ -e /dev/net/tun ] && return 0
    mkdir -p /dev/net || return 1
    mknod /dev/net/tun c 10 200 || return 1
    chmod 600 /dev/net/tun
}

ensure_tun_boot() {
    local f=/etc/init.d/mihomo-tun
    if [ ! -x "$f" ]; then
        # 用 printf 逐行写：粘贴版会把行首 # 注释删掉，heredoc 里的 shebang 会被误删
        {
            printf '%s\n' '#!/bin/sh /etc/rc.common'
            printf '%s\n' 'START=98'
            printf '%s\n' 'boot() {'
            printf '%s\n' '    mkdir -p /dev/net'
            printf '%s\n' '    [ -e /dev/net/tun ] || mknod /dev/net/tun c 10 200'
            printf '%s\n' '    chmod 600 /dev/net/tun'
            printf '%s\n' '    modprobe tun 2>/dev/null'
            printf '%s\n' '}'
            printf '%s\n' 'start() { boot; }'
        } > "$f"
        chmod +x "$f"
    fi
    "$f" enable >/dev/null 2>&1 || true
}

ensure_fw4_include() {
    # fw4 start() 最后一句是 test -f /etc/firewall.include && sh ...
    # 文件不存在 ⇒ reload 返回 1 ⇒ mihomo 的 TUN auto-redirect 失败
    [ -e /etc/firewall.include ] || : > /etc/firewall.include
}

clean_stale_passwall() {
    local s p changed=0
    command -v uci >/dev/null 2>&1 || return 0
    for s in passwall2 passwall2_server; do
        p=$(uci -q get "firewall.$s.path" 2>/dev/null)
        [ -n "$p" ] || continue
        [ -e "$p" ] && continue
        [ -f /etc/config/firewall.bak-mihomo ] || \
            cp /etc/config/firewall /etc/config/firewall.bak-mihomo
        uci -q delete "firewall.$s" && changed=1
    done
    if [ "$changed" = 1 ]; then
        uci -q commit firewall
        say "✔ 防火墙：清掉失效的 PassWall2 include"
    fi
}

fw4_reload_ok() {
    local out rc line
    command -v fw4 >/dev/null 2>&1 || return 0
    out=$(fw4 reload 2>&1); rc=$?
    [ "$rc" = 0 ] && return 0
    say "⚠️ 防火墙：fw4 reload 返回 $rc"
    printf '%s\n' "$out" | tail -3 | while IFS= read -r line; do
        say "    $line"
    done
    return 1
}

prepare_tun() {
    local i=0

    if tun_runtime; then
        ensure_tun_boot
        ensure_fw4_include
        say "✔ TUN：已在跑"
        return 0
    fi

    say "→ TUN：检查内核模块"
    ensure_kmod_tun || { say "✘ TUN：kmod-tun 装不上（源里没有？）"; return 1; }
    modprobe tun 2>/dev/null || true
    ensure_tun_node || { say "✘ TUN：/dev/net/tun 建不出来"; return 1; }
    ensure_tun_boot
    ensure_fw4_include
    clean_stale_passwall
    fw4_reload_ok || say "⚠️ TUN：fw4 没过，TUN 可能起不来"

    say "→ 内核：重启并等 TUN"
    /etc/init.d/mihomo restart >/dev/null 2>&1 \
        || { say "✘ 内核：重启失败"; return 1; }
    while [ "$i" -lt 25 ]; do
        i=$((i + 1))
        if tun_runtime; then
            say "✔ TUN：已启动（Meta）"
            return 0
        fi
        sleep 2
    done
    say "✘ TUN：没起来（logread -e mihomo | grep -i tun）"
    return 1
}

# ── 子命令 ──────────────────────────────────────────────────────
do_status() {
    local addr code
    if nginx_owns_80; then say "✔ 环境：nginx 占着 80"; else say "✘ 环境：80 不是 nginx"; fi
    if uhttpd_has_raw_proxy; then
        say "⚠️ uhttpd 带原始流代理 —— 这台用 mtun-xd expose on 就行，不需要本脚本"
    fi
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$CGI_PORT/cgi-bin/mihomo-apply" 2>/dev/null)
    say "→ 写盘口：127.0.0.1:$CGI_PORT → ${code:-无响应}"
    addr=$(cfg_addr)
    code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1/ui/" 2>/dev/null)
    say "→ 80 端口：/ui/ → ${code:-无响应}（内核地址 $addr）"
    if [ -x /usr/sbin/mtun-xd ]; then
        say "→ 套件：expose $(/usr/sbin/mtun-xd expose status 2>/dev/null || echo '?')"
    fi
    if tun_runtime; then say "✔ TUN：enable=true"; else say "✘ TUN：enable=false"; fi
    return 0
}

do_install() {
    local addr

    [ "$(id -u)" = 0 ] || die "要用 root 跑"

    if uhttpd_has_raw_proxy; then
        say "⚠️ uhttpd 已带原始流代理 —— 这台用 mtun-xd expose on 就行，本脚本不动"
        return 0
    fi
    nginx_owns_80 || die "80 端口不是 nginx（pidof nginx 空）—— 这台不适用本脚本"
    [ -f /etc/config/nginx ] || die "没有 /etc/config/nginx —— 不是 nginx 前端"
    [ -x "$APPLY" ] || die "配置工具没装（$APPLY 不在）—— 先跑 mtun-xd tool"
    [ -x /usr/sbin/uhttpd ] || die "没有 uhttpd —— 装一个再跑（opkg install uhttpd）"

    mkdir -p /www/cgi-bin
    if [ ! -e "$WWW_APPLY" ] || [ "$(readlink "$WWW_APPLY" 2>/dev/null)" != "$APPLY" ]; then
        ln -sf "$APPLY" "$WWW_APPLY"
    fi

    if netstat -lnt 2>/dev/null | grep -q ":$CGI_PORT " \
       && [ "$(uci -q get "$UCI_CFG.$UCI_SEC.listen_http" 2>/dev/null)" != "127.0.0.1:$CGI_PORT" ]; then
        die "127.0.0.1:$CGI_PORT 已被占用 —— 把脚本里的 CGI_PORT 改成一个空口再跑"
    fi

    addr=$(pick_addr) || {
        addr=127.0.0.1:9090
        say "⚠️ 内核没应答（$addr）—— 先照这个地址挂，起来了就通"
    }

    say "✔ 环境：nginx 占着 80"
    save_state_once
    say "→ 写盘口：uhttpd 127.0.0.1:$CGI_PORT"

    # 1) uhttpd：main 段停掉（80/443 归 nginx），另起一个只跑 CGI 的段
    uci -q set "$UCI_CFG.main.enabled=0"
    uci -q get "$UCI_CFG.$UCI_SEC" >/dev/null 2>&1 || uci -q set "$UCI_CFG.$UCI_SEC=uhttpd"
    uci -q set "$UCI_CFG.$UCI_SEC.enabled=1"
    uci -q set "$UCI_CFG.$UCI_SEC.listen_http=127.0.0.1:$CGI_PORT"
    uci -q set "$UCI_CFG.$UCI_SEC.home=/www"
    uci -q set "$UCI_CFG.$UCI_SEC.cgi_prefix=/cgi-bin"
    uci -q set "$UCI_CFG.$UCI_SEC.script_timeout=3600"
    uci -q set "$UCI_CFG.$UCI_SEC.network_timeout=30"
    uci -q set "$UCI_CFG.$UCI_SEC.max_requests=50"
    uci -q set "$UCI_CFG.$UCI_SEC.max_connections=100"
    uci -q set "$UCI_CFG.$UCI_SEC.no_dirlists=1"

    # 2) 套件 expose status 的占位
    rm -f "$OFF_MARK"
    strip_our_pfx >/dev/null 2>&1 || true
    write_our_pfx "$addr"
    uci -q commit "$UCI_CFG" || die "uci commit $UCI_CFG 失败"

    /etc/init.d/uhttpd enable >/dev/null 2>&1 || true
    /etc/init.d/uhttpd restart >/dev/null 2>&1 \
        || die "uhttpd 起不来 —— 看 logread -e uhttpd；修不好就 $0 off"

    if ! wait_http "http://127.0.0.1:$CGI_PORT/cgi-bin/mihomo-apply" 405 >/dev/null; then
        local code
        code=$(curl -s -o /dev/null -w '%{http_code}' -m 5 \
               "http://127.0.0.1:$CGI_PORT/cgi-bin/mihomo-apply" 2>/dev/null)
        die "写盘口没执行 CGI（HTTP ${code:-无响应}）—— 看 logread -e uhttpd；修不好就 $0 off"
    fi
    say "✔ 写盘口：127.0.0.1:$CGI_PORT"

    # 3) nginx：16 条口子
    say "→ 80 端口：挂上内核的口子"
    NGX_LOC_EXISTED=0
    if [ -f "$NGX_LOC" ]; then
        cp "$NGX_LOC" "$NGX_LOC.prev.$$"
        NGX_LOC_EXISTED=1
    fi
    write_nginx_loc "$addr"
    if ! nginx_test >/tmp/mihomo-kwrt-nginx.test.$$ 2>&1; then
        cat /tmp/mihomo-kwrt-nginx.test.$$ >&2
        rm -f /tmp/mihomo-kwrt-nginx.test.$$
        restore_nginx_loc
        die "nginx 配置没通过（已还原）—— 看上面的报错；修不好就 $0 off"
    fi
    rm -f /tmp/mihomo-kwrt-nginx.test.$$
    /etc/init.d/nginx reload >/dev/null 2>&1 || die "nginx reload 失败（看 logread -e nginx）"

    if ! wait_http "http://127.0.0.1/ui/" 200 >/dev/null; then
        restore_nginx_loc
        die "80 端口没通（/ui/ 不是 200，已还原 nginx 配置）—— 先 /etc/init.d/mihomo restart 再重跑；修不好就 $0 off"
    fi
    if ! wait_http "http://127.0.0.1/cgi-bin/mihomo-apply" 405 >/dev/null; then
        restore_nginx_loc
        die "80 端口的写盘口没通（GET 不是 405，已还原 nginx 配置）—— 看 logread -e nginx；修不好就 $0 off"
    fi

    [ -f "$NGX_LOC.prev.$$" ] && rm -f "$NGX_LOC.prev.$$"

    printf '%s' "$addr" > "$SUITE_ADDR_CACHE"
    say "✔ 80 端口：已挂好（$addr）"
    if [ -x /usr/sbin/mtun-xd ]; then
        say "✔ 套件：expose $(/usr/sbin/mtun-xd expose status 2>/dev/null || echo '?')"
    fi
    prepare_tun || true
    return 0
}

do_off() {
    [ "$(id -u)" = 0 ] || die "要用 root 跑"
    [ -f "$STATE" ] || die "本脚本没装过（没有 $STATE）"

    if [ -f "$NGX_LOC" ]; then
        rm -f "$NGX_LOC"
        /etc/init.d/nginx reload >/dev/null 2>&1 || true
    fi

    uci -q set "$UCI_CFG.$UCI_SEC.enabled=0" 2>/dev/null || true
    strip_our_pfx >/dev/null 2>&1 || true
    restore_main_enabled
    uci -q commit "$UCI_CFG" 2>/dev/null || true

    if [ "$UHTTPD_WAS_RUNNING" = 1 ]; then
        /etc/init.d/uhttpd restart >/dev/null 2>&1 || true
    else
        /etc/init.d/uhttpd stop >/dev/null 2>&1 || true
    fi
    if [ "$UHTTPD_WAS_ENABLED" = 0 ]; then
        /etc/init.d/uhttpd disable >/dev/null 2>&1 || true
    fi

    rm -f "$ADDR_CACHE"
    : > "$OFF_MARK"
    say "✔ 已关掉：nginx 口子摘了，uhttpd 回原样"
}

do_uninstall() {
    do_off
    uci -q delete "$UCI_CFG.$UCI_SEC" 2>/dev/null || true
    uci -q commit "$UCI_CFG" 2>/dev/null || true
    rm -f "$STATE"
    say "✔ 已卸载"
}

case "${1:-install}" in
    install|on) do_install ;;
    off)       do_off ;;
    status)    do_status ;;
    uninstall) do_uninstall ;;
    *)         die "用法：$0 [install|on|off|status|uninstall]" ;;
esac
