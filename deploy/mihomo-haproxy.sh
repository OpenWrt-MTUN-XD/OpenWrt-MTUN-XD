#!/bin/sh
# iStoreOS 24.10 等固件的 uhttpd 没有原始流代理：
# 用 HAProxy 在 80 做路径分流 —— /ui、/version 等给 mihomo，其余继续给 LuCI。
set -u

STATE=/etc/mtun-xd.haproxy
UHTTPD_BAK=/etc/mtun-xd.haproxy-uhttpd.bak
HAPROXY_BAK=/etc/mtun-xd.haproxy-cfg.bak
PKG_MARK=/etc/mtun-xd.haproxy-package
CFG=/etc/haproxy.cfg
MARK='# mtun-xd managed HAProxy frontend'

say() { printf '%s\n' "$1"; }
die() { printf '✘ %s\n' "$1" >&2; exit 1; }

restore_uhttpd() {
    # ⚠️ **只还原 listen_http**，不整份 cp 回快照：快照是第一次挂上去那一刻的，
    #    整份还原会把那之后用户自己对 uhttpd 的改动（别的 proxy_prefix、别的选项）
    #    一起抹掉 —— 套件主脚本里对原生方案明令禁止的正是这个动作。
    local v vals=''
    if [ -f "$UHTTPD_BAK" ]; then
        vals=$(sed -n "s/.*listen_http[[:space:]]*'\([^']*\)'.*/\1/p" "$UHTTPD_BAK" 2>/dev/null)
    fi
    uci -q delete uhttpd.main.listen_http
    if [ -n "$vals" ]; then
        for v in $vals; do
            uci add_list uhttpd.main.listen_http="$v"
        done
    else
        uci add_list uhttpd.main.listen_http='0.0.0.0:80'
        uci add_list uhttpd.main.listen_http='[::]:80'
    fi
    uci -q commit uhttpd
}

rollback() {
    /etc/init.d/haproxy stop >/dev/null 2>&1 || true
    restore_uhttpd
    /etc/init.d/uhttpd restart >/dev/null 2>&1 || true
    rm -f "$STATE"
}

status() {
    local code
    [ -f "$STATE" ] || return 1
    command -v haproxy >/dev/null 2>&1 || return 1
    pidof haproxy >/dev/null 2>&1 || return 1
    code=$(curl -sS -o /dev/null -w '%{http_code}' -m 3 http://127.0.0.1/ui/ 2>/dev/null)
    case "$code" in 2??|3??) ;; *) return 1 ;; esac
    printf 'on\n'
}

install_haproxy() {
    if command -v haproxy >/dev/null 2>&1; then
        return 0
    fi
    if command -v apk >/dev/null 2>&1; then
        apk add haproxy >/dev/null 2>&1 || return 1
    elif command -v opkg >/dev/null 2>&1; then
        opkg update >/dev/null 2>&1 || true
        opkg install haproxy >/dev/null 2>&1 || return 1
    else
        return 1
    fi
    command -v haproxy >/dev/null 2>&1 || return 1
    : > "$PKG_MARK"
}

# LuCI（uhttpd）那一侧的后端地址。
# ⚠️ 不能写死 127.0.0.1:8080：uhttpd 的 listen_http 可能是按具体内网地址配的
#    （192.168.100.1:80），挪到 8080 后回环上没人听 —— backend luci 永远 down，
#    除 mihomo 路径外全 503，等于把 LuCI 锁死。按原始监听里第一个非 IPv6 地址推后端。
# ⚠️ 两个坑：① /etc/config/uhttpd 里是 `list listen_http '…'`，匹配要留出空格；
#             ② 第二次 install 时当前配置已经是 :8080，所以要优先读快照。
luci_addr() {
    local v host=''
    if [ -f "$UHTTPD_BAK" ]; then
        for v in $(sed -n "s/.*listen_http[[:space:]]*'\([^']*\)'.*/\1/p" "$UHTTPD_BAK" 2>/dev/null); do
            case "$v" in
                *:*) ;;
                *) continue ;;
            esac
            case "$v" in \[*\]:*) continue ;; esac
            host=${v%:*}; break
        done
    fi
    if [ -z "$host" ]; then
        for v in $(uci -q get uhttpd.main.listen_http 2>/dev/null); do
            case "$v" in
                *:*) ;;
                *) continue ;;
            esac
            case "$v" in \[*\]:*) continue ;; esac
            host=${v%:*}; break
        done
    fi
    case "$host" in ''|0.0.0.0|'*') host=127.0.0.1 ;; esac
    printf '%s:8080' "$host"
}

# 后端地址：套件探测到「内核真正应答」的那个 ip:port（见 expose_pick），
# 没传就退回默认。⚠️ 不能写死 127.0.0.1:9090 —— 配置里的 external-controller
# 换过端口 / 绑的是内网地址时，写死的那份会让 /ui、/version 全 502。
# 这个值最终会落进 haproxy.cfg，先按字符集挡住空格 / 换行 / 分号。
write_cfg() {
    local tmp ipv6='' tgt luci
    tgt=${1:-127.0.0.1:9090}
    case "$tgt" in
        *[!0-9A-Za-z.:\[\]-]*) return 1 ;;
        *:*) ;;
        *) return 1 ;;
    esac
    luci=$(luci_addr)
    [ -f /proc/net/if_inet6 ] && ipv6='    bind [::]:80'
    tmp=$(mktemp /tmp/mihomo-haproxy.XXXXXX) || return 1
    cat > "$tmp" <<EOF
$MARK
global
    log stdout format raw local0
    maxconn 2048

defaults
    log global
    mode http
    option httplog
    option dontlognull
    option forwardfor
    retries 2
    timeout connect 5s
    timeout client 300s
    timeout server 300s
    timeout tunnel 1h
    timeout http-request 15s

frontend lan_http
    bind 0.0.0.0:80
$ipv6
    acl is_mihomo path_beg /ui /version /logs /traffic /memory /configs /proxies /group /rules /connections /providers /cache /dns /storage /restart /upgrade
    use_backend mihomo if is_mihomo
    default_backend luci

backend luci
    server uhttpd $luci check

backend mihomo
    server mihomo $tgt check
EOF
    haproxy -c -f "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; return 1; }
    if [ -f "$CFG" ] && ! grep -qF "$MARK" "$CFG" 2>/dev/null; then
        [ -f "$HAPROXY_BAK" ] || cp -p "$CFG" "$HAPROXY_BAK" || { rm -f "$tmp"; return 1; }
    fi
    mv -f "$tmp" "$CFG"
}

move_uhttpd() {
    local old v
    old=$(uci -q get uhttpd.main.listen_http 2>/dev/null)
    if [ -z "$old" ]; then
        old='0.0.0.0:80 [::]:80'
    fi
    uci -q delete uhttpd.main.listen_http
    for v in $old; do
        case "$v" in
            *:80) v="${v%:80}:8080" ;;
            80)   v=8080 ;;                     # 少数固件只写端口，也一起挪走
        esac
        uci add_list uhttpd.main.listen_http="$v"
    done
    uci commit uhttpd
}

install_all() {
    local ok=0 i root_code ui_code ver_code tgt old
    tgt=${1:-127.0.0.1:9090}
    if [ -f "$STATE" ]; then
        # 已经由我们管理：uhttpd 可能被固件升级重置，仍然幂等地移到 8080。
        move_uhttpd || die '修改 uhttpd 监听失败'
        # 后端地址变过（改了 external-controller / 换了监听端口）或配置文件丢了
        # → 重写一份；否则 HAProxy 还往老地址转，面板和 API 全 502。
        old=$(cat "$STATE" 2>/dev/null | tr -d '\r\n')
        if [ "$old" != "$tgt" ] || [ ! -s "$CFG" ] \
           || ! grep -qF "$MARK" "$CFG" 2>/dev/null; then
            # ⚠️ 这里失败必须回滚：uhttpd 已经被挪到 8080，HAProxy 又起不来的话
            #    80 上就没人听了 —— 那是"把 LuCI 锁死"，绝不允许。
            write_cfg "$tgt" || { rollback; die 'HAProxy 配置生成或校验失败'; }
            printf '%s\n' "$tgt" > "$STATE"
        fi
    else
        if pidof haproxy >/dev/null 2>&1 && ! grep -qF "$MARK" "$CFG" 2>/dev/null; then
            die 'HAProxy 已被其他配置占用，拒绝覆盖'
        fi
        # LuCI 得真由 uhttpd 提供，否则把 80 让给 HAProxy 等于把 LuCI 关掉。
        if [ "$(uci -q get uhttpd.main.enabled 2>/dev/null)" = 0 ]; then
            die 'uhttpd 主服务是停用的 —— 不能走 HAProxy 分流（先把 LuCI 恢复）'
        fi
        [ -f "$UHTTPD_BAK" ] || cp -p /etc/config/uhttpd "$UHTTPD_BAK" || die '备份 uhttpd 失败'
        install_haproxy || die 'HAProxy 安装失败（检查软件源/网络）'
        write_cfg "$tgt" || die 'HAProxy 配置生成或校验失败'
        move_uhttpd || die '修改 uhttpd 监听失败'
        printf '%s\n' "$tgt" > "$STATE"
    fi

    /etc/init.d/uhttpd restart >/dev/null 2>&1 || { rollback; die 'uhttpd 重启失败'; }
    /etc/init.d/haproxy enable >/dev/null 2>&1
    /etc/init.d/haproxy restart >/dev/null 2>&1 || { rollback; die 'HAProxy 启动失败'; }

    i=0
    while [ "$i" -lt 10 ]; do
        i=$((i + 1))
        root_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1/ 2>/dev/null)
        ui_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1/ui/ 2>/dev/null)
        ver_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 5 http://127.0.0.1/version 2>/dev/null)
        case "$root_code:$ui_code:$ver_code" in
            2??:2??:401|2??:2??:200|3??:2??:401|3??:2??:200) ok=1; break ;;
        esac
        sleep 1
    done
    [ "$ok" = 1 ] || { rollback; die "/ui 或 /version 健康检查失败（$root_code/$ui_code/$ver_code）"; }
    printf 'on\n'
}

off() {
    [ -f "$STATE" ] || { printf 'off\n'; return 0; }
    /etc/init.d/haproxy stop >/dev/null 2>&1 || true
    /etc/init.d/haproxy disable >/dev/null 2>&1 || true
    restore_uhttpd
    /etc/init.d/uhttpd restart >/dev/null 2>&1 || true
    # ⚠️ 还原完要**确认 80 上真的有人听**再删快照：删早了就成了"关掉之后
    #    80 空着、也没有东西能恢复"—— 那是把 LuCI 锁死。
    if ! netstat -lnt 2>/dev/null | grep -q ':80 '; then
        printf '✘ 80 端口没恢复（uhttpd 没起来）—— 快照保留在 %s，修好后再跑一次 off\n' "$UHTTPD_BAK" >&2
        return 1
    fi
    if [ -f "$HAPROXY_BAK" ]; then
        cp -p "$HAPROXY_BAK" "$CFG"
    fi
    if [ -f "$PKG_MARK" ]; then
        if command -v apk >/dev/null 2>&1; then
            apk del haproxy >/dev/null 2>&1 || true
        elif command -v opkg >/dev/null 2>&1; then
            opkg remove haproxy >/dev/null 2>&1 || true
        fi
    fi
    rm -f "$STATE" "$UHTTPD_BAK" "$HAPROXY_BAK" "$PKG_MARK"
    printf 'off\n'
}

case "${1:-status}" in
    install|on) install_all "${2:-}" ;;
    off|uninstall) off ;;
    status) status ;;
    *) say '用法: mihomo-haproxy.sh install [ip:port] | off | status'; exit 2 ;;
esac
