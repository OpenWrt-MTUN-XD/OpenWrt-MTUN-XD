#!/bin/sh
# iStoreOS 24.10 等固件的 uhttpd 没有原始流代理：
# 用 HAProxy 在 80 做路径分流 —— /ui、/version 等给 mihomo，其余继续给 LuCI。
#
# ImmortalWrt / 自编译固件常见 uhttpd 不带原始流代理，需要 HAProxy。
# 系统/其他插件也可能已有 HAProxy 实例：不能覆盖 /etc/haproxy.cfg，也不能停掉别人的实例。
# 这里使用 MTUN-XD 自己的配置 + 自己的 PID + 自己的 init 脚本，
# 只接管 80；外部 HAProxy 继续跑它自己的端口。
set -u

STATE=/etc/mtun-xd.haproxy
UHTTPD_BAK=/etc/mtun-xd.haproxy-uhttpd.bak
CFG=/etc/mtun-xd-haproxy.cfg
PID=/var/run/mtun-xd-haproxy.pid
INIT=/etc/init.d/mtun-xd-haproxy
MARK='# mtun-xd managed HAProxy frontend'

say() { printf '%s\n' "$1"; }
die() { printf '✘ %s\n' "$1" >&2; exit 1; }

uhttpd_listens() {
    local cur snap
    # 当前配置还有 80 就以当前为准；已经挪到 8080 才回看安装前快照。
    cur=$(uci -q get uhttpd.main.listen_http 2>/dev/null | tr '\n' ' ')
    case " $cur " in
        *":80 "*|*" 80 "*) printf '%s\n' $cur; return ;;
    esac
    snap=$(sed -n "s/.*listen_http[[:space:]]*'\([^']*\)'.*/\1/p" "$UHTTPD_BAK" 2>/dev/null)
    if [ -n "$snap" ]; then
        printf '%s\n' $snap
        return
    fi
    printf '0.0.0.0:80\n[::]:80\n'
}

current_listens() {
    uci -q get uhttpd.main.listen_http 2>/dev/null
}

# 只看当前 uci，不看快照 —— 快照回退会把「当前已经 8080」误判成还在 80。
current_has_http80() {
    local v
    for v in $(current_listens); do
        case "$v" in
            80|*:80) return 0 ;;
        esac
    done
    return 1
}

has_http80() {
    local v
    for v in $(uhttpd_listens); do
        case "$v" in
            80|*:80) return 0 ;;
        esac
    done
    return 1
}

# 按原始 listen_http 生成 bind，不因为走了 HAProxy 就擅自监听所有网卡。
listen_binds() {
    local v addr seen='' out=''
    for v in $(uhttpd_listens); do
        case "$v" in
            \[*\]:80) addr=${v%:*} ;;
            *:80) addr=${v%:*} ;;
            80) addr=0.0.0.0 ;;
            *) continue ;;
        esac
        [ -n "$addr" ] || addr=0.0.0.0
        [ "$addr" = '*' ] && addr=0.0.0.0
        case " $seen " in *" $addr "*) continue ;; esac
        seen="$seen $addr"
        out="${out}    bind ${addr}:80
"
    done
    [ -n "$out" ] || out='    bind 0.0.0.0:80
'
    printf '%s' "$out"
}

# 健康检查要打 HAProxy 真正 bind 的地址；只 bind 具体 LAN IP 时不能用 127.0.0.1。
probe_host() {
    local v h
    for v in $(uhttpd_listens); do
        case "$v" in
            \[*\]:80) h=${v%:*}; [ "$h" = '[::]' ] && h='[::1]'; printf '%s' "$h"; return ;;
            *:80) h=${v%:*}; case "$h" in 0.0.0.0|'*') h=127.0.0.1 ;; esac; printf '%s' "$h"; return ;;
            80) printf '127.0.0.1'; return ;;
        esac
    done
    printf '127.0.0.1'
}

restore_uhttpd() {
    # 只还原 listen_http，不整份 cp 快照：避免抹掉用户后来加的别的 uhttpd 选项。
    local v vals='' rc=0
    # 当前已经不在 8080（固件/用户改过端口）就不要按快照硬套；只让调用方清状态。
    uhttpd_has_8080 || return 0
    if [ -f "$UHTTPD_BAK" ]; then
        vals=$(uhttpd_listens)
    fi
    uci -q delete uhttpd.main.listen_http || rc=1
    if [ -n "$vals" ]; then
        for v in $vals; do
            uci add_list uhttpd.main.listen_http="$v" || rc=1
        done
    else
        uci add_list uhttpd.main.listen_http='0.0.0.0:80' || rc=1
        uci add_list uhttpd.main.listen_http='[::]:80' || rc=1
    fi
    uci -q commit uhttpd || rc=1
    return "$rc"
}

# 进程活着且不是僵尸（kill -0 对僵尸也成功）。
pid_alive() {
    local st
    kill -0 "$1" 2>/dev/null || return 1
    st=$(sed -n 's/^[0-9]*[[:space:]]*([^)]*)[[:space:]]*\([^ ]*\).*/\1/p' "/proc/$1/stat" 2>/dev/null)
    [ "$st" = 'Z' ] && return 1
    return 0
}

stop_haproxy() {
    local d p pids='' seen='' cmd='' i=0 alive=''
    # 只收 cmdline 含本配置的进程（防重复 install 留下两个实例）。
    # 不直接信 PID 文件：陈旧 PID 可能已经被别的进程复用。
    for d in /proc/[0-9]*; do
        [ -r "$d/cmdline" ] || continue
        p=${d##*/}
        cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
        case "$cmd" in
            *"$CFG"*) pids="$pids $p" ;;
        esac
    done
    for p in $pids; do
        case " $seen " in *" $p "*) continue ;; esac
        seen="$seen $p"
        [ -r "/proc/$p/cmdline" ] || continue
        cmd=$(tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null)
        case "$cmd" in
            *"$CFG"*) kill "$p" 2>/dev/null || true ;;
            *) continue ;;
        esac
    done
    while [ "$i" -lt 10 ]; do
        i=$((i + 1))
        alive=''
        for p in $seen; do
            pid_alive "$p" && alive="$alive $p"
        done
        [ -z "$alive" ] && break
        sleep 1
    done
    for p in $seen; do
        pid_alive "$p" || continue
        kill -9 "$p" 2>/dev/null || true
    done
    i=0
    while [ "$i" -lt 10 ]; do
        i=$((i + 1))
        alive=''
        for p in $seen; do
            pid_alive "$p" && alive="$alive $p"
        done
        [ -z "$alive" ] && break
        sleep 1
    done
    for p in $seen; do
        pid_alive "$p" && return 1
    done
    rm -f "$PID"
    return 0
}

rollback() {
    stop_haproxy || { printf '✘ 自有 HAProxy 停不下来，保留状态，不继续回滚\n' >&2; return 1; }
    restore_uhttpd || true
    /etc/init.d/uhttpd restart >/dev/null 2>&1 || true
    # 回滚也必须确认 80 真的有人听；验证失败则保留快照，不能把退路删掉。
    i=0
    while [ "$i" -lt 10 ]; do
        netstat -lnt 2>/dev/null | grep -q ':80 ' && break
        i=$((i + 1))
        sleep 1
    done
    if ! netstat -lnt 2>/dev/null | grep -q ':80 '; then
        printf '✘ 回滚后 80 没恢复；保留 %s，修好后再处理\n' "$UHTTPD_BAK" >&2
        return 1
    fi
    rm -f "$CFG" "$INIT" "$PID" "$STATE" "$UHTTPD_BAK"
    [ -L /etc/rc.d/S99mtun-xd-haproxy ] && rm -f /etc/rc.d/S99mtun-xd-haproxy
    return 0
}

status() {
    local code p='' host
    [ -f "$STATE" ] || return 1
    [ -f "$PID" ] || return 1
    p=$(cat "$PID" 2>/dev/null)
    [ -n "$p" ] && kill -0 "$p" 2>/dev/null || return 1
    host=$(probe_host)
    code=$(curl -sS -o /dev/null -w '%{http_code}' -m 3 "http://$host/ui/" 2>/dev/null)
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
}

# LuCI（uhttpd）后端地址：只取原始 80 监听；IPv6-only 也返回 IPv6 回环/原地址。
luci_addr() {
    local v host='' v6=''
    for v in $(uhttpd_listens); do
        case "$v" in
            \[*\]:80) v6=${v%:*};;
            *:80) host=${v%:*}; break ;;
            80) host=127.0.0.1; break ;;
        esac
    done
    [ -n "$host" ] || host="$v6"
    [ -n "$host" ] || host=127.0.0.1
    case "$host" in
        0.0.0.0|'*') host=127.0.0.1 ;;
        '[::]') host='[::1]' ;;
    esac
    printf '%s:8080' "$host"
}

write_cfg() {
    local tmp binds luci tgt
    tgt=${1:-127.0.0.1:9090}
    case "$tgt" in
        *[!0-9A-Za-z.:\[\]-]*) return 1 ;;
        *:*) ;;
        *) return 1 ;;
    esac
    binds=$(listen_binds)
    luci=$(luci_addr)
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
$binds
    acl is_mihomo path_beg /ui /version /logs /traffic /memory /configs /proxies /group /rules /connections /providers /cache /dns /storage /restart /upgrade
    use_backend mihomo if is_mihomo
    default_backend luci

backend luci
    server uhttpd $luci check

backend mihomo
    server mihomo $tgt check
EOF
    haproxy -c -f "$tmp" >/dev/null 2>&1 || { rm -f "$tmp"; return 1; }
    mv -f "$tmp" "$CFG" || { rm -f "$tmp"; return 1; }
}

install_init() {
    cat > "$INIT" <<'EOF'
#!/bin/sh /etc/rc.common
START=99
STOP=10
start() {
    [ -f /etc/mtun-xd-haproxy.cfg ] || return 0
    /usr/sbin/haproxy -D -f /etc/mtun-xd-haproxy.cfg -p /var/run/mtun-xd-haproxy.pid
}
stop() {
    [ -f /var/run/mtun-xd-haproxy.pid ] || return 0
    kill "$(cat /var/run/mtun-xd-haproxy.pid)" 2>/dev/null || true
    rm -f /var/run/mtun-xd-haproxy.pid
}
EOF
    chmod 755 "$INIT" || return 1
    "$INIT" enable >/dev/null 2>&1 || return 1
}

move_uhttpd() {
    local old v rc=0
    old=$(uci -q get uhttpd.main.listen_http 2>/dev/null)
    if [ -z "$old" ]; then
        old='0.0.0.0:80 [::]:80'
    fi
    uci -q delete uhttpd.main.listen_http || rc=1
    for v in $old; do
        case "$v" in
            *:80) v="${v%:80}:8080" ;;
            80)   v=8080 ;;
        esac
        uci add_list uhttpd.main.listen_http="$v" || rc=1
    done
    uci commit uhttpd || rc=1
    return "$rc"
}

install_all() {
    local ok=0 i root_code ui_code ver_code tgt host
    tgt=${1:-127.0.0.1:9090}

    if [ ! -f "$STATE" ]; then
        # 初始安装：uhttpd 必须在 80，否则不能安全接管。
        [ -f "$UHTTPD_BAK" ] || cp -p /etc/config/uhttpd "$UHTTPD_BAK" || die '备份 uhttpd 失败'
        if ! current_has_http80; then
            die 'uhttpd 未监听 80，拒绝接管（可能是非标准端口配置）'
        fi
        if [ "$(uci -q get uhttpd.main.enabled 2>/dev/null)" = 0 ]; then
            die 'uhttpd 主服务是停用的 —— 不能走 HAProxy 分流（先把 LuCI 恢复）'
        fi
        install_haproxy || die 'HAProxy 安装失败（检查软件源/网络）'
    elif current_has_http80; then
        # 固件升级/手动改回 80 后，旧快照已过期；当前还在 80 时刷新一次。
        cp -p /etc/config/uhttpd "$UHTTPD_BAK" || die '刷新 uhttpd 快照失败'
    elif ! uhttpd_has_8080; then
        die '当前 uhttpd 既不在 80 也不在 8080，拒绝按快照接管'
    fi

    # 先腾 80 再动 uhttpd：失败就停手，不能留下「新配置 + 旧实例」的半截状态。
    stop_haproxy || die '旧 HAProxy 实例停不下来（保留状态，不覆盖）'
    write_cfg "$tgt" || { rollback; die 'HAProxy 配置生成或校验失败'; }
    move_uhttpd || { rollback; die '修改 uhttpd 监听失败'; }
    /etc/init.d/uhttpd restart >/dev/null 2>&1 || { rollback; die 'uhttpd 重启失败'; }
    sleep 1
    printf '%s\n' "$tgt" > "$STATE" || { rollback; die '写 HAProxy 状态失败'; }
    install_init || { rollback; die '安装 HAProxy 启动脚本失败'; }

    "$INIT" enable >/dev/null 2>&1 || true
    "$INIT" start >/dev/null 2>&1 || { rollback; die 'HAProxy 启动失败'; }

    # 快照已存在，这里才能按原始监听推导健康检查地址（具体 LAN IP / IPv6）。
    host=$(probe_host)
    i=0
    while [ "$i" -lt 10 ]; do
        i=$((i + 1))
        root_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 5 "http://$host/" 2>/dev/null)
        ui_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 5 "http://$host/ui/" 2>/dev/null)
        ver_code=$(curl -sS -o /dev/null -w '%{http_code}' -m 5 "http://$host/version" 2>/dev/null)
        case "$root_code:$ui_code:$ver_code" in
            2??:2??:401|2??:2??:200|3??:2??:401|3??:2??:200) ok=1; break ;;
        esac
        sleep 1
    done
    [ "$ok" = 1 ] || { rollback; die "/ui 或 /version 健康检查失败（$root_code/$ui_code/$ver_code）"; }
    printf 'on\n'
}

uhttpd_has_8080() {
    local v
    for v in $(uci -q get uhttpd.main.listen_http 2>/dev/null); do
        case "$v" in 8080|*:8080) return 0 ;; esac
    done
    return 1
}

off() {
    local i=0 failed=0
    # 没有安装痕迹就不要动 uhttpd：这可能是原生/nginx 路径，只是有人误跑了 off。
    if [ ! -f "$STATE" ] && [ ! -f "$UHTTPD_BAK" ] && [ ! -f "$CFG" ] && [ ! -f "$INIT" ]; then
        printf 'off\n'
        return 0
    fi
    stop_haproxy || { printf '✘ 自有 HAProxy 停不下来，保持原样\n' >&2; return 1; }
    restore_uhttpd || failed=1
    /etc/init.d/uhttpd restart >/dev/null 2>&1 || failed=1

    # 还原完确认 80 真的恢复；失败则把我们的实例拉回原样，不能停在半关状态。
    i=0
    while [ "$i" -lt 10 ]; do
        netstat -lnt 2>/dev/null | grep -q ':80 ' && break
        i=$((i + 1))
        sleep 1
    done
    if [ "$failed" = 1 ] || ! netstat -lnt 2>/dev/null | grep -q ':80 '; then
        # 只有在 uhttpd 还被我们留在 8080 时才把 HAProxy 拉回；
        # 否则先把 uhttpd 的 listen 退回安装前，再决定。
        if uhttpd_has_8080; then
            [ -x "$INIT" ] && "$INIT" enable >/dev/null 2>&1 || true
            [ -x "$INIT" ] && "$INIT" start >/dev/null 2>&1 || true
            printf '✘ 80 端口没恢复 —— 已把 MTUN-XD HAProxy 拉回；快照保留在 %s，修好后再跑一次 off\n' "$UHTTPD_BAK" >&2
            return 1
        fi
        restore_uhttpd >/dev/null 2>&1 || true
        /etc/init.d/uhttpd restart >/dev/null 2>&1 || true
        i=0
        while [ "$i" -lt 10 ]; do
            netstat -lnt 2>/dev/null | grep -q ':80 ' && break
            i=$((i + 1)); sleep 1
        done
        if ! netstat -lnt 2>/dev/null | grep -q ':80 '; then
            printf '✘ 80 端口没恢复，uhttpd 也回不到安装前；快照保留在 %s，先修 uhttpd 再 off\n' "$UHTTPD_BAK" >&2
            return 1
        fi
    fi
    # 只有确认 80 已由 uhttpd 接管，才允许关闭自启和删文件。
    [ -x "$INIT" ] && "$INIT" disable >/dev/null 2>&1 || true
    rm -f "$STATE" "$CFG" "$INIT" "$PID" "$UHTTPD_BAK"
    [ -L /etc/rc.d/S99mtun-xd-haproxy ] && rm -f /etc/rc.d/S99mtun-xd-haproxy
    printf 'off\n'
}

case "${1:-status}" in
    install|on) install_all "${2:-}" ;;
    off|uninstall) off ;;
    status) status ;;
    *) say '用法: mihomo-haproxy.sh install [ip:port] | off | status'; exit 2 ;;
esac
