#!/bin/sh
# mihomo-sub CGI 回归测试：直接构造 CGI 环境变量，不依赖 uhttpd。
#
# 覆盖：认证、secret 缺失、错误 secret、3.9/4.1 MiB、重定向到 ftp、SSRF、超时。
# 本地 HTTP 服务通过 sub.127.0.0.1.nip.io 访问，避免测试自身命中 SSRF 黑名单。
set -u

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../../.." && pwd)
CGI="$ROOT/generator/deploy/mihomo-sub"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/mihomo-sub-test.XXXXXX") || exit 1
SERVER_PID=''
PORT=''

cleanup() {
    [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null || true
    sleep 0.1
    rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

fail() {
    echo "FAIL: $*" >&2
    exit 1
}

status_of() { sed -n 's/^Status: //p' "$1" | head -1 | tr -d '\r'; }
reason_of() { sed -n 's/^X-Sub-Reason: //p' "$1" | head -1 | tr -d '\r'; }
body_of() { sed '1,/^[[:space:]]*$/d' "$1" | tr -d '\r'; }

assert_status() {
    got=$(status_of "$TMP/out")
    [ "$got" = "$1" ] || fail "status: got [$got], want [$1]"
}
assert_reason() {
    got=$(reason_of "$TMP/out")
    [ "$got" = "$1" ] || fail "reason: got [$got], want [$1]"
}
call_cgi() {
    cfg=$1
    auth=$2
    url=$3
    route=${4:-direct}
    len=$(printf '%s' "$url" | wc -c | tr -d ' ')
    printf '%s' "$url" | env \
        REQUEST_METHOD=POST \
        CONTENT_LENGTH="$len" \
        HTTP_AUTHORIZATION="$auth" \
        HTTP_HOST=router.example \
        HTTP_X_SUB_ROUTE="$route" \
        MIHOMO_SUB_CONFIG="$cfg" \
        sh "$CGI" > "$TMP/out"
}

# 真实 uhttpd 不传自定义头，走 query。
call_cgi_query() {
    cfg=$1
    auth=$2
    url=$3
    route=${4:-tun}
    len=$(printf '%s' "$url" | wc -c | tr -d ' ')
    printf '%s' "$url" | env \
        REQUEST_METHOD=POST \
        CONTENT_LENGTH="$len" \
        HTTP_AUTHORIZATION="$auth" \
        HTTP_HOST=router.example \
        QUERY_STRING="route=$route" \
        MIHOMO_SUB_CONFIG="$cfg" \
        sh "$CGI" > "$TMP/out"
}

printf 'secret: "test-secret"\n' > "$TMP/config-good"
printf 'secret: ""\n' > "$TMP/config-empty"
HOST='sub.127.0.0.1.nip.io'
PY=${PYTHON:-python3}

# 本地 HTTP 服务
cat > "$TMP/server.py" <<'PY'
import http.server, os, sys, time

root, port = sys.argv[1], int(sys.argv[2])

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def do_GET(self):
        if self.path.startswith('/ping'):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'ok')
            return
        if self.path.startswith('/slow'):
            time.sleep(40)
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'slow')
            return
        if self.path.startswith('/redirect'):
            self.send_response(302)
            self.send_header('Location', 'ftp://example.com/x')
            self.end_headers()
            return
        return super().do_GET()

os.chdir(root)
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
PY

mkdir -p "$TMP/www"
"$PY" - <<'PY' > "$TMP/port"
import socket
s = socket.socket()
s.bind(('127.0.0.1', 0))
print(s.getsockname()[1])
s.close()
PY
PORT=$(tr -d '\r\n' < "$TMP/port")
dd if=/dev/zero of="$TMP/www/normal" bs=1024 count=3990 2>/dev/null
dd if=/dev/zero of="$TMP/www/large" bs=1024 count=4200 2>/dev/null
"$PY" "$TMP/server.py" "$TMP/www" "$PORT" >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

# 等端口起来；最多 5 秒
i=0
while [ "$i" -lt 50 ]; do
    if curl -fsS -m 1 "http://$HOST:$PORT/ping" >/dev/null 2>&1; then break; fi
    i=$((i + 1))
    sleep 0.1
done
[ "$i" -lt 50 ] || fail "test HTTP server did not start"

BASE="http://$HOST:$PORT"

# 1. 无 Authorization
call_cgi "$TMP/config-good" '' "$BASE/normal" direct
assert_status '401 Unauthorized'
assert_reason 'no-auth'

# 2. secret 为空
call_cgi "$TMP/config-empty" 'Bearer x' "$BASE/normal" direct
assert_status '403 Forbidden'
assert_reason 'no-secret'

# 3. secret 错误
call_cgi "$TMP/config-good" 'Bearer bad' "$BASE/normal" direct
assert_status '403 Forbidden'
assert_reason 'bad-secret'

# 4. SSRF（目标 127.0.0.1）
call_cgi "$TMP/config-good" 'Bearer test-secret' "http://127.0.0.1:$PORT/normal" direct
assert_status '400 Bad Request'
assert_reason 'ssrf'

# 5. 3.9 MiB，经 tun（无本地端口 → tun-plain）
call_cgi "$TMP/config-good" 'Bearer test-secret' "$BASE/normal" tun
assert_status '200 OK'
[ "$(sed -n 's/^X-Sub-Upstream: //p' "$TMP/out" | tr -d '\r')" = '200' ] || fail 'missing upstream 200'

# 6. 4.1 MiB + 临时文件清理
call_cgi "$TMP/config-good" 'Bearer test-secret' "$BASE/large" tun
assert_status '413 Payload Too Large'
if find /tmp -maxdepth 1 \( -name 'mihomo-sub.*' -o -name 'mihomo-sub-err.*' \) | grep -q .; then
    fail 'mihomo-sub temp files remain after 413'
fi

# 7. 302 到 ftp
call_cgi "$TMP/config-good" 'Bearer test-secret' "$BASE/redirect" tun
status=$(status_of "$TMP/out")
[ "$status" = '502 Bad Gateway' ] || [ "$status" = '400 Bad Request' ] || fail "ftp redirect status: $status"
body_of "$TMP/out" | grep -q '只允许 http/https' || { echo "redirect_status=$(status_of "$TMP/out")" >&2; body_of "$TMP/out" | head -c 300 >&2; echo >&2; fail 'ftp redirect body lacks protocol message'; }

# 8. 服务器 sleep 40s，CGI 总超时 25s
call_cgi "$TMP/config-good" 'Bearer test-secret' "$BASE/slow" tun
assert_status '504 Gateway Timeout'
assert_reason 'timeout'

# 9. route=tun 且无本地端口 → tun-plain（query 形式，模拟 uhttpd）
call_cgi_query "$TMP/config-good" 'Bearer test-secret' "$BASE/normal" tun
assert_status '200 OK'
[ "$(sed -n 's/^X-Sub-Route: //p' "$TMP/out" | tr -d '\r')" = 'tun-plain' ] || fail 'route should be tun-plain'

# 10. direct 且解析不到 → 409 / direct-unavailable
call_cgi "$TMP/config-good" 'Bearer test-secret' 'http://no-such-host.invalid/' direct
assert_status '409 Conflict'
assert_reason 'direct-unavailable'

echo "✔ subscription CGI tests passed"
