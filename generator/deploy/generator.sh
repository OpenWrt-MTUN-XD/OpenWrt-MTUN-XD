#!/bin/sh
# Mihomo 配置生成器 —— 装 / 撤，一个脚本两个选项。
#
#   curl -fsSL https://mtun-xd.wxcircle.top/generator.sh | sh
#   ... | sh -s i    装        ... | sh -s u    撤
#
# 装：生成器铺到 /etc/mihomo/ui/config/，往 uhttpd 的 CGI 目录挂一条 mihomo-apply 链接（mihomo 的
# API 不能写文件），往面板 config.js 末尾挂一行引入绿点，再把面板的 PWA service worker 换成空 SW
# （它会兜底 /ui/config/，见 tame_sw）。撤：上面几样一起删掉。
#
# 注意：生成器页面本身是公开的（mihomo 把 external-ui 当静态文件发、没有登录层）。删 index.html
# 想让目录 404 不行（Go 的 http.FileServer 会改吐目录列表），把文件搬出去由 CGI 发能真 404 但入口
# 落到 uhttpd 的 80，而这类机器只有 9090 通 —— 所以门放在「写」那一层：没登录就没有「载入配置文件」
# 按钮，写盘接口认 mihomo 的 secret。注意：/etc/mihomo/config.yaml 一个字都不碰。
#
# 说明：`curl … | sh` 时脚本正文在 stdin 上，菜单不能从 stdin 读，得从 /dev/tty 读。本文件由
# scripts/make-router-kit.mjs 发布到套件仓库的 dist/ 和 GitHub 的 genkit release（唯一一份）。

# 默认的下载地址 —— 指到套件那个 Cloudflare 站：生成器自己的站点只发页面，而 GitHub 的 genkit
# release 的包由调用方（套件）下好再用 MIHOMO_KIT_FILE 交过来；本脚本只有单一 URL，不做回退。
# ⚠️ 常规路子还是套件：它自己用镜像把包下好、用 MIHOMO_KIT_FILE 指过来，根本不走这里。
# ⚠️ 地址只放在变量里，不许打印（不想让客户看到托管域名）。
BASE='https://mtun-xd.wxcircle.top'
U="$BASE/mihomo-deploy.zip"
# ⚠️ 没有 unzip 的机器走这份（tar 一定有）。同一份内容，只是外壳不同。
UT="$BASE/mihomo-deploy.tar.gz"
# ⚠️ 老套件没有 console 子命令时，自己去拉一份 install.sh（见 self_upgrade_suite）
SI="$BASE/install.sh"
# ⚠️ 下载地址可以被覆盖：套件（MTUN-XD）直接把自己下好的包用 `MIHOMO_KIT_FILE`
#    指过来（不走这里），也支持用 `MIHOMO_KIT_URL` / `MIHOMO_KIT_TAR_URL` 换地址。
U="${MIHOMO_KIT_URL:-$U}"
UT="${MIHOMO_KIT_TAR_URL:-$UT}"
D=/etc/mihomo/ui
G="$D/config"
# ⚠️ 换包用的暂存目录 —— 故意放在 /ui/ 外面（那底下是公开静态目录），但必须跟 $G 同一个文件系统：
#    最后那一步靠 `mv` 换名，跨盘的 mv 会退化成「复制+删除」，就不原子了。
GNEW='/etc/mihomo/.config.new'
GOLD='/etc/mihomo/.config.old'

# 历史上那几版留下的东西，装 / 撤时一并清掉：
#   · /www/cgi-bin/<这些名字> —— 旧的「入口门」CGI 链接，新方案里没有入口 CGI 了，留着就是悬空链接；
#   · /etc/mihomo/ni、/etc/mihomo-gen、/etc/mihomo/config —— 搬来搬去的旧家。
LEGACY_CGI_NAMES='gen ni config'

# 登录门的「工具密码」明文，就存这一份。
#
# 位置是 `/etc/mihomo-toolpass`：/etc 根下一个带项目前缀的单独文件，不塞进 /etc/mihomo 里添乱，
# 也不会跟别的东西重名；既不在 /ui/ 底下（公开静态目录，明文放那儿谁都能 curl），也不在
# /etc/mihomo 里（mihomo.sh 卸载是 rm -rf /etc/mihomo，会被连带删掉）。
# ⚠️ 换位置只改这一个常量（再往 TOOLFILE_OLD 里加一条迁移即可）。
TOOLFILE='/etc/mihomo-toolpass'
# 工具密码哈希的运行时那份：登录门每次 no-store 现拉这个文件。
# ⚠️ 为什么单独放一个文件：换工具密码（mihomo-apply?rotate=1）要能立刻生效，而 gate.js 带 ?v=
#    缓存，改它浏览器不一定马上看得见。
# ⚠️ 在 /ui/ 底下公开没关系 —— 是哈希，12 位随机反推不出来。
# ⚠️ 路径不单独写常量：装新包时它打在暂存目录上（见 gen_tool_password 的参数）；早先待过的位置
#    装的时候搬过来（别让它凭空生成新密码，把发出去的作废）。
TOOLFILE_OLD='/etc/mihomo/ui/.toolpass /etc/mihomo/.toolpass'

# 临时文件一律 mktemp：固定名字并发时会互相踩，而且 root 下在 /tmp 预先放一个同名软链，
# curl -o 就会穿过它写到任意路径（/tmp 是所有人可写）。
K=$(mktemp /tmp/mihomo-kit.zip.XXXXXX) || exit 1
KT=$(mktemp /tmp/mihomo-kit.tar.gz.XXXXXX) || exit 1
W=$(mktemp -d /tmp/mihomo-kit.XXXXXX) || exit 1

# 跟套件共用一把锁（/tmp/mtun-xd.lock）：两边都会改 $D/config，套件换面板时还会
# 整个目录换 $D —— 撞上就是半新半旧。套件自己在跑时会带 MTUN_XD_LOCKED=1
# （锁已经在它手上），那时不再抢、也不去删。
SUITE_LOCK=/tmp/mtun-xd.lock
LOCKED=0
acquire_lock() {
    [ "${MTUN_XD_LOCKED:-0}" = 1 ] && return 0
    if mkdir "$SUITE_LOCK" 2>/dev/null; then
        echo $$ > "$SUITE_LOCK/pid" 2>/dev/null
        LOCKED=1
        return 0
    fi
    old=$(cat "$SUITE_LOCK/pid" 2>/dev/null)
    if [ -n "$old" ] && kill -0 "$old" 2>/dev/null; then
        # ⚠️ 锁的持有者是**调用我们的上层**（老版套件调 tool 时不会带 MTUN_XD_LOCKED，
        #    它自己已经拿着锁）⇒ 那条链子本来就是串行的，别再抢一次把自己判死。
        p=$$
        while [ "$p" != 1 ] && [ -n "$p" ]; do
            p=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)
            [ "$p" = "$old" ] && return 0
        done
        return 1
    fi
    rm -rf "$SUITE_LOCK"
    mkdir "$SUITE_LOCK" 2>/dev/null || return 1
    echo $$ > "$SUITE_LOCK/pid" 2>/dev/null
    LOCKED=1
    return 0
}
cleanup() {
    rm -rf "$W" "$K" "$KT"
    [ "$LOCKED" = 1 ] && rm -rf "$SUITE_LOCK"
    return 0
}
trap cleanup EXIT INT TERM

# 挂在面板 config.js 里的那一行用这个当标记，卸载时按它整段删
MOUNT_TAG='mihomo-generator-button'

# 面板左下角那个绿点：往面板的 config.js 末尾挂一行，把 config/btn.js 引进来。
#
# config.js 是面板官方留的「构建完还能改」的部署期配置 —— nuxt.config.ts 里它以 tagPosition 'head'
# + defer/async 全 false 阻塞加载，而且在 globIgnores 里、不进 SW 预缓存，所以改了立刻生效。
# 幂等：已经有了就不重复加；面板一升级 config.js 会被换回原样，再跑一次本脚本就补回来了。
unmount_button(){
    local js="$D/config.js"
    [ -f "$js" ] || return 0
    if grep -q "$MOUNT_TAG" "$js" 2>/dev/null; then
        sed -i "/$MOUNT_TAG/,\$d" "$js"
    fi
    return 0
}

# 面板 index.html 里那行 `config.js?v=` 跟着 config.js 的 mtime 走 —— 不刷的话，
# 浏览器里那份旧 config.js 会把刚改的东西盖住（mihomo 只发 Last-Modified）。
# ⚠️ 只在这一处写：挂绿点 / 摘绿点都用它，省得两份 sed 哪天改歪一个。
bump_cfg_ver(){
    local js="$D/config.js" idx="$D/index.html" v
    [ -f "$js" ] && [ -f "$idx" ] || return 0
    v=$(date -r "$js" +%s 2>/dev/null || date +%s)
    sed -i "s|src=\"config\.js[^\"]*\"|src=\"config.js?v=$v\"|" "$idx"
    return 0
}

mount_button(){
    local js="$D/config.js" cur
    [ -f "$js" ] || return 0
    [ -f "$G/btn.js" ] || return 0

    # 这一行刻意不带任何会变的东西（版本号在运行时拼），所以装过一次之后就永远不变。
    # ⚠️ 版本号必须在运行时拼：zip 里每个文件的时间戳都写死 2020-01-01，mihomo 于是发
    #    Last-Modified: 2020，启发式缓存能把 btn.js 缓存好几个月 —— 所以 ?v= 用 Date.now()。
    # ⚠️ 这一行必须以分号开头：面板自带的 config.js 里那个对象字面量结尾没有分号，紧跟其后的
    #    `(` 会被当成「调用前面那个对象」而抛错，后面全不执行。
    # ⚠️ 判断有没有引过用 document.scripts 遍历，不用 CSS 选择器（属性值带点必须加引号，
    #    `script[src*=btn.js]` 是非法选择器，会直接抛 SyntaxError）。
    # ⚠️ 下面那两行（标记行 + JS 行）MTUN-XD 那边也有一份（它整份重写面板 config.js），
    #    两边必须一字不差：各自都靠这个标记行做「整段比对 / 整段替换」。
    #    改这里 = 同时改 mtun-xd 的 package/usr/sbin/mtun-xd 里的 DOT_HOOK。
    local line='// mihomo-generator-button: configuration generator entry (removed on uninstall)
;(function(){for(var s=document.scripts,i=0;i<s.length;i++){if(/btn\.js/.test(s[i].src))return}document.head.appendChild(Object.assign(document.createElement("script"),{src:"./config/btn.js?v="+Date.now()}))})()'

    # 已经是这一版就什么都不做（别去动 config.js —— 动一次就多一次缓存麻烦）。
    # ⚠️ 必须整段比对：grep -F 碰到带换行的 pattern 会按行拆开匹配，只要标记那句还在旧版里，
    #    就会误判成「已经是最新的」。
    cur="$(sed -n "/$MOUNT_TAG/,\$p" "$js" 2>/dev/null)"
    if [ "$cur" = "$line" ]; then
        return 0
    fi

    # 是旧的一版就换掉：先把旧的那段摘掉（标记行到文件末尾）
    if [ -n "$cur" ]; then
        sed -i "/$MOUNT_TAG/,\$d" "$js"
    fi

    # 文件末尾没换行就先补一个。面板自带那份 config.js 末尾本来就有换行，所以卸载时按标记行整段
    # 删掉之后一个字节不差地还回去；只有极端的「末尾没换行」才会多留一个换行符。
    [ -n "$(tail -c 1 "$js")" ] && printf '\n' >> "$js"
    printf '%s\n' "$line" >> "$js"

    # ⚠️ 顺手把面板 index.html 里那行引用挂上新的 `?v=<config.js 的 mtime>`：不挂的话浏览器里那份
    #    旧的 config.js 会把刚加上的钩子盖住（mihomo 只发 Last-Modified，启发式缓存能留几个钟头）。
    #    套件的 seed_panel_cfg 用的是同一个 sed，所以不打架；只在真改了 config.js 的这条路径上做。
    bump_cfg_ver
}

# ⚠️ 面板的 PWA service worker（`$D/sw.js`）必须收掉 —— 它会把 /ui/config/ 也兜底成面板自己的
# 页面，表现就是打开生成器白屏。它是 `registerRoute(new NavigationRoute(createHandlerBoundToURL("./")))`
# 注册的：作用域 `/ui/`、没有 denylist，会先递给你面板的 HTML，而面板资源全是相对路径、在
# /ui/config/ 下解析成 404。只有 https 会犯（service worker 要安全上下文）。
# 处理：换成什么都不拦的空 SW（请求照走网络，只是没有离线缓存），新 SW 自己 skipWaiting。
# ⚠️ 只在确实带着那句 NavigationRoute 时才动它；面板升级覆盖回来后再跑一次本脚本就补上。
tame_sw(){
    local f="$D/sw.js"
    [ -f "$f" ] || return 0
    grep -q 'createHandlerBoundToURL' "$f" 2>/dev/null || return 0

    # ⚠️ 用 printf 逐行写，不要用 heredoc —— 本脚本是 `curl … | sh` 灌进来的，正文就在 stdin 上，
    #    heredoc 要跟它抢流。
    printf '%s\n' \
'// 由 deploy/generator.sh 换成的空 SW。' \
'// 面板自带那个 sw.js 里有一句 NavigationRoute(createHandlerBoundToURL("./"))，' \
'// 作用域 /ui/ 且没有 denylist，会把 /ui/config/（配置生成器）也兜底成面板自己的' \
'// 页面 —— 面板页里的资源是相对路径，在 /ui/config/ 下全 404，表现就是打开生成器白屏。' \
'// 这里什么都不拦，所有请求照走网络。' \
'self.addEventListener("install", function (e) { e.waitUntil(self.skipWaiting()); });' \
'self.addEventListener("activate", function (e) {' \
'    e.waitUntil(self.clients.claim());' \
'    e.waitUntil(caches.keys().then(function (ks) {' \
'        return Promise.all(ks.map(function (k) { return caches.delete(k); }));' \
'    }));' \
'});' \
'// 顺带把「生成器那个页面本身」改成每次重新校验：' \
'// mihomo 只发 Last-Modified，浏览器按启发式缓存，改完打开还是旧的 ——' \
'// 只盯导航（页面本身），避免改完还要手动刷新。' \
'// 资源照常走缓存（它们带 ?v=内容指纹，内容一变 URL 就变，不用在这儿管）。' \
'self.addEventListener("fetch", function (e) {' \
'    if (e.request.mode !== "navigate") return;' \
'    var u = new URL(e.request.url);' \
'    if (u.origin !== self.location.origin) return;' \
'    if (u.pathname.indexOf("/config/") === -1) return;' \
'    e.respondWith(fetch(e.request, { cache: "no-cache" }));' \
'});' > "$f.new" || { rm -f "$f.new"; return 0; }
    # ⚠️ 写临时文件再换名：直接截断写的话，断电 / 没空间会留下半份 SW，
    #    浏览器照样会去加载它（面板离线缓存就这么废了）
    mv -f "$f.new" "$f"
}

# ── 「信箱」取信脚本 + cron（每分钟一次）─────────────────────────
#
# 有些机器只映射了 9090、够不着 uhttpd 那个写盘口，生成器就把配置投进 mihomo 自己的 /storage
# 信箱，这台机器每分钟取一次、写成 config.yaml 再重载 —— 不用给每台机器多开一个端口。延迟最多
# 1 分钟（cron 的最小粒度）。
PULLER=/usr/bin/mihomo-gen-pull
CRON_TAG='mihomo-gen-pull'

# ⚠️ 信箱那条整个撤了（生成器不再往 mihomo 的 /storage 投配置，也不再有每分钟取信的 cron）：
#     它最多慢一分钟，而且落没落盘页面上看不出来。现在只留两条直接写盘的路（见 app/apply.js 的
#     findCgi）⇒ 这个函数反过来：把老机器上残留的取信脚本 + cron 行清掉（幂等，装机时跑）。
uninstall_pull(){
    local f=/etc/crontabs/root rc=0
    if [ -f "$f" ] && grep -q "$CRON_TAG" "$f" 2>/dev/null; then
        # ⚠️ grep 出错（读失败 / 磁盘满）时 tmp 会变成空文件，无条件 mv 就把用户全部的
        #    crontab 清空了。grep -v 没有匹配行时退出码是 1（这是正常结果），其余才是错。
        grep -v "$CRON_TAG" "$f" > "$f.tmp" 2>/dev/null || rc=$?
        if [ "$rc" = 0 ] || [ "$rc" = 1 ]; then
            cp -p "$f" "$f.bak-mihomo" 2>/dev/null
            mv "$f.tmp" "$f" && /etc/init.d/cron restart >/dev/null 2>&1
        else
            rm -f "$f.tmp"
            echo "⚠️ 配置工具：清 cron 那行失败（保留原 crontab 不动）" >&2
        fi
    fi
    [ -f "$PULLER" ] && rm -f "$PULLER"
    return 0
}

# 删掉一条链接 —— 当前的和历史的都算。
# ⚠️ 判断必须用 `-e || -L`：悬空链接 `-e` 是假（它去跟目标，目标没了就是假），只判 `-e` 会漏掉。
drop_link(){
    if [ -e "/www/cgi-bin/$1" ] || [ -L "/www/cgi-bin/$1" ]; then
        rm -f "/www/cgi-bin/$1"
    fi
}

# ── 登录门的「工具密码」（每台装的时候现生成一把）──────────────────────
#
# 机主会把工具发给别人用、但不给面板密码，所以每台机器的工具密码必须各自一把（装的时候现生成）。
#   · 明文 → $TOOLFILE（/etc/mihomo-toolpass，在 /ui/ 外面）
#   · SHA-256 → 注进 $G/gate.js 的 TOOL_HASH 那一行（哈希公开无所谓：12 位随机反推不出来）
# ⚠️ 已经装过就不重新生成 —— 重装一次就把发出去的密码作废掉。想换一把：rm -f "$TOOLFILE" 再重装。
tool_hash(){
    if command -v sha256sum >/dev/null 2>&1; then
        printf '%s' "$1" | sha256sum | cut -d' ' -f1
    elif command -v openssl >/dev/null 2>&1; then
        printf '%s' "$1" | openssl dgst -sha256 | sed 's|.*[ =]||'
    else
        echo "⚠️ 这台既没有 sha256sum 也没有 openssl —— 工具密码装不上" >&2
        return 1
    fi
}

gen_tool_password(){
    # ⚠️ 参数是**要打补丁的目录**（默认 $G）：装新包的时候补丁打在**暂存目录**上，
    #    换名上去的那一刻就是全的 —— 不会出现"页面已经新了、密码哈希还是旧的"那一瞬。
    local base="${1:-$G}" h tp
    TOOLPW=''
    [ -f "$base/gate.js" ] || return 0

    # 早先待过的位置有就搬过来 —— 不然会凭空生成一把新的，发出去的旧密码全作废
    if [ ! -s "$TOOLFILE" ]; then
        for old in $TOOLFILE_OLD; do
            [ -s "$old" ] || continue
            mv "$old" "$TOOLFILE" 2>/dev/null
            if [ -s "$TOOLFILE" ]; then
                echo "→ 工具密码已从 $old 搬到 $TOOLFILE"
            fi
            break
        done
    fi

    local fresh=0
    if [ -s "$TOOLFILE" ]; then
        tp=$(cat "$TOOLFILE")
    else
        fresh=1
        tp=''
        while [ ${#tp} -lt 12 ]; do
            tp=$(head -c 256 /dev/urandom | tr -dc 'A-Za-z0-9' | head -c 12)
        done
        ( umask 077; printf '%s\n' "$tp" > "$TOOLFILE" ) || {
            echo "⚠️ 配置工具：工具密码存不下来（$TOOLFILE）—— 跳过，登录门会不认它"
            return 0
        }
    fi

    h=$(tool_hash "$tp") || return 0

    # 运行时那份哈希（门每次现拉的就是它）—— 每次装都重写一遍，保证跟明文对得上
    printf '%s\n' "$h" > "$base/toolhash.txt" 2>/dev/null

    # ⚠️ 工具密码交给调用方最后统一打（见 install_gen 收尾那两行）：在这儿打会排在「换名上去」
    #    之前，看着像已经装好了。
    # ⚠️ 只在密码是新生成的这一趟打（= 头一次装）：已经装过的机器每次 tool 都把那行重打一遍纯属
    #    噪音。想看它：`generator.sh p`，或者直接 cat $TOOLFILE。
    [ "$fresh" = 1 ] && TOOLPW="$tp" || TOOLPW=''

    # 页面里已经是这个哈希就什么都不做（别白刷一遍 mtime）
    if grep -q "TOOL_HASH = '$h'" "$base/gate.js" 2>/dev/null; then
        return 0
    fi

    # 只替换 TOOL_HASH 那一行，别的字节一个不碰
    if ! sed -i "s|^\( *var TOOL_HASH = '\)[0-9a-f]*\(';\)|\1$h\2|" "$base/gate.js"; then
        echo "⚠️ 配置工具：工具密码注不进 gate.js（页面里那行改了？）"
        return 0
    fi
}

show_tool_password(){
    if [ ! -s "$TOOLFILE" ]; then
        echo "✘ 配置工具：还没装（没有 $TOOLFILE）"
        return 1
    fi
    # 套件调用时一律闭嘴（密码由它自己在最后统一打）—— 这条对 `p` 动作同样生效
    if [ "${MIHOMO_KIT_QUIET:-0}" = 1 ]; then
        echo "✔ 配置工具：工具密码见 $TOOLFILE"
        return 0
    fi
    echo "✔ 配置工具：工具密码 $(cat "$TOOLFILE")（$TOOLFILE）"
}

# ── 老机器上「工具升级」顺手把控制台也升上来 ────────────────────────────────
# 新界面有「控制台升级」，但旧界面上那个按钮还叫「工具升级」—— 不在这儿接一把，那台永远停在
# 旧界面：点一次只换了 kit，包本身没动。判据：套件装着、且它报的版本跟 kit 的版本不一样。
# ⚠️ MIHOMO_KIT_NO_SELFUPGRADE=1 是递归闸：install.sh 收尾会再调 tool → generator，那一趟不能
#    再触发一次升级。
# ⚠️ MTUN_XD_LOCKED=1：锁在我们手上，子进程别再抢。
BRIDGED=0
# ver_gt <a> <b>：a 比 b 新返回 0（逐段比数字；段数不同按 0 补齐）
ver_gt() {
    awk -v a="$1" -v b="$2" 'BEGIN{
        na = split(a, x, "."); nb = split(b, y, ".");
        n = (na > nb) ? na : nb;
        for (i = 1; i <= n; i++) {
            va = (i <= na) ? x[i] : 0;
            vb = (i <= nb) ? y[i] : 0;
            if (va + 0 == va && vb + 0 == vb) {
                if (va + 0 > vb + 0) exit 0;
                if (va + 0 < vb + 0) exit 1;
            } else {
                if (va > vb) exit 0;
                if (va < vb) exit 1;
            }
        }
        exit 1;
    }'
}

self_upgrade_suite(){
    [ -x /usr/sbin/mtun-xd ] || return 0
    [ "${MIHOMO_KIT_NO_SELFUPGRADE:-0}" = 1 ] && return 0
    local cur kitv tmp
    cur=$(/usr/sbin/mtun-xd version 2>/dev/null)
    kitv=$(awk -F"'" '/APP_VERSION/ {print $2; exit}' "$G/state.js" 2>/dev/null | sed 's/^v//')
    [ -n "$cur" ] && [ -n "$kitv" ] || return 0
    [ "$cur" = "$kitv" ] && return 0
    # ⚠️ 只升不降：版本号从 8.9.x 换成日期式（2026.11.1）之后，机器上留着的老人 kit（8.9.67）会被
    #    判成「版本不一样」，然后「顺手升级」把控制台降级回旧版。这里按段比数字，只有 kit 真的
    #    更新才动手。
    ver_gt "$kitv" "$cur" || return 0
    echo "→ 控制台：升级到 $kitv"
    if grep -q 'console) upgrade_console' /usr/sbin/mtun-xd 2>/dev/null; then
        # 新套件：直接用它的 console（它自己会拉 install.sh，而且会先拷一份再覆盖自己）
        BRIDGED=1
        MTUN_XD_LOCKED=1 /usr/sbin/mtun-xd console
        return 0
    fi
    # 老套件没有 console 子命令：自己拉 install.sh 走 pkg 模式。
    # ⚠️ 放后台、隔两秒再跑：调我们的那个老套件进程还在读 /usr/sbin/mtun-xd，而 install.sh
    #    会原地覆盖它 —— 前台跑等于一边读一边被换（老版本没自我拷贝那套）。
    tmp=$(mktemp /tmp/mihomo-install.XXXXXX 2>/dev/null) || return 0
    if curl -fsSL --retry 2 --connect-timeout 15 -m 60 --user-agent "Mozilla/5.0" \
            -o "$tmp" "$SI" 2>/dev/null; then
        echo "→ 控制台：升级在后台继续（装完刷新页面）"
        ( sleep 2
          MIHOMO_KIT_NO_SELFUPGRADE=1 MTUN_XD_LOCKED=1 MTUN_XD_CONSOLE=1 \
              sh "$tmp" pkg >> /tmp/mtun-xd.log 2>&1
          rm -f "$tmp"
        ) >/dev/null 2>&1 &
    else
        rm -f "$tmp"
        echo "⚠️ 控制台：安装脚本没下来（网络？）"
    fi
    return 0
}

install_gen(){
    local kit_owned=0 have_unzip=0 use_tar=0 src='' kit_is_tar=0 rc=0
    TOOLPW=''
    acquire_lock || { echo "⚠️ 另一个套件操作正在进行，稍后再试"; return 1; }
    command -v unzip >/dev/null 2>&1 && have_unzip=1
    # ⚠️ 没有 unzip 是常态（iStoreOS / Kwrt 的 busybox 不带它）⇒ 改走 tar.gz。
    #    MIHOMO_KIT_TAR=1 是测试用的强制开关（有 unzip 也走 tar）。
    [ "${MIHOMO_KIT_TAR:-0}" = 1 ] && use_tar=1

    # ⚠️ 包可以由宿主先下好再叫我们（`MIHOMO_KIT_FILE` 指过来就跳过下载）。套件就是这么干的：它那
    #    套镜像会挨个回退，而我们这里只有一个 URL —— URL 指到 github.com 时它会 302 到
    #    release-assets.githubusercontent.com，那个域名在国内基本连不上，而镜像（ghfast / gh-proxy）
    #    是代理内容、不 302，所以能下来。
    #    所以：下包这事交给有回退的那一方；这条老路（站点）保持不变。
    if [ -n "${MIHOMO_KIT_FILE:-}" ]; then
        case "$MIHOMO_KIT_FILE" in
            *.tar.gz|*.tgz) kit_is_tar=1 ;;
        esac
        # 宿主给的是 zip 而本机没有 unzip（或者强制走 tar）→ 忽略它，改下 tar.gz。
        if [ "$kit_is_tar" = 1 ] || { [ "$have_unzip" = 1 ] && [ "$use_tar" = 0 ]; }; then
            [ -s "$MIHOMO_KIT_FILE" ] || { echo "✘ $MIHOMO_KIT_FILE 不在或者是空的"; return 1; }
            src="$MIHOMO_KIT_FILE"
            use_tar="$kit_is_tar"
            # ⚠️ 这份是**宿主**（套件）的临时文件，不是我们下的 —— 装完不能删别人的东西。
        fi
    fi

    if [ -z "$src" ]; then
        kit_owned=1
        if [ "$use_tar" = 1 ] || [ "$have_unzip" = 0 ]; then
            src="$KT"
            # ⚠️ `2>/dev/null` 不能省：`-S` 会在失败时把完整 URL（带托管域名）打到屏幕上，失败由
            #    下面那句报。
            if ! curl -fsSL --retry 2 --connect-timeout 15 -m 300 -o "$src" "$UT" 2>/dev/null; then
                rm -f "$src"
                echo "✘ 下载失败"
                return 1
            fi
        else
            src="$K"
            if ! curl -fsSL --retry 2 --connect-timeout 15 -m 300 -o "$src" "$U" 2>/dev/null; then
                rm -f "$src"
                echo "✘ 下载失败"
                return 1
            fi
        fi
        if [ ! -s "$src" ]; then
            rm -f "$src"
            echo "✘ 下回来是空的"
            return 1
        fi
    fi

    rm -rf "$W"
    mkdir -p "$W"
    # ⚠️ 认的是 index.html（mihomo 只认这个名字当目录首页）+ mihomo-apply。
    #    名字写错了的话，每次装都会报「解压失败」。
    if [ "$use_tar" = 1 ]; then
        tar -xzf "$src" -C "$W"
        rc=$?
    else
        unzip -oq "$src" -d "$W"
        rc=$?
    fi
    if [ "$rc" != 0 ] || [ ! -f "$W/config/index.html" ] || [ ! -f "$W/config/mihomo-apply" ] \
       || [ ! -f "$W/config/mihomo-sub" ]; then
        rm -rf "$W"
        [ "$kit_owned" = 1 ] && rm -f "$src"     # 宿主给的包不归我们删
        echo "✘ 解压失败"
        return 1
    fi
    [ "$kit_owned" = 1 ] && rm -f "$src"         # 宿主给的包不归我们删

    # ⚠️ zip 里每个文件的时间戳都是写死的 2020-01-01（为了让打包产物确定）。解压出来 mtime 就是
    #    2020，mihomo 于是发 Last-Modified: 2020，启发式缓存能把整个页面缓存大半年。所以在这儿
    #    统一把 mtime 改成现在，让它每次都能正常 revalidate。
    # ⚠️ 放在搬进暂存目录之后做：跨盘的 `mv` 行为依实现而定，在这儿 touch 一遍就不依赖它了。

    # 写盘 CGI 得有执行位（zip 里存了权限，但解压器不一定认；
    # ⚠️ 少了这个 chmod，uhttpd 会给 403，写盘永远失败）
    chmod +x "$W/config/mihomo-apply"
    chmod +x "$W/config/mihomo-sub"

    # ── 先铺到暂存目录，机器相关的补丁也打在这儿，最后一步才换名 ──────────────
    # 不原地铺（rm -rf $G 再铺的话中间那段目录是半新半旧的，撞上就 404/白屏，断电还留残目录）：
    # 铺到 $GNEW（跟 $G 同盘）→ 打完补丁 → 两次 rename 换上来，空窗只剩两次 rename 之间。
    mkdir -p "$D"
    # ⚠️ 上次换到一半被打断（断电 / 被杀）：$G 不在、$GOLD 是唯一一份完整的 ——
    #    先挪回去，别让下面那行 rm -rf 把最后的副本删了。
    if [ ! -f "$G/index.html" ] && [ -d "$GOLD" ]; then
        [ -d "$G" ] && rm -rf "$G"
        mv "$GOLD" "$G" 2>/dev/null
    fi
    rm -rf "$GNEW" "$GOLD"
    if ! mv "$W/config" "$GNEW"; then
        echo "✘ 铺暂存目录失败（$GNEW）"
        rm -rf "$W"
        return 1
    fi
    rm -rf "$W"

    find "$GNEW" -type f -exec touch {} \; 2>/dev/null

    # 登录门的「工具密码」：第一次装现生成一把，之后每次重装都把同一把的哈希重新注进新下载的
    # gate.js（不然重装一次就把发出去的密码作废了）。
    gen_tool_password "$GNEW"

    # ── 换上去：同一个盘上的两次 rename，都是瞬间的 ──
    # ⚠️ 第一次 rename 的退出码必须看：失败（目录被占 / immutable）时 $G 还在，紧跟着的
    #    `mv $GNEW $G` 会变成把新目录塞进旧目录里并返回 0 —— 屏幕上打着「已就位」，线上还是旧的。
    if [ -d "$G" ] && ! mv "$G" "$GOLD"; then
        echo "✘ 旧目录挪不走（$G 被占用？）"
        rm -rf "$GNEW"
        return 1
    fi
    if mv "$GNEW" "$G"; then
        rm -rf "$GOLD"
    else
        echo "✘ 换上去失败，把旧的那份挪回来"
        [ -d "$GOLD" ] && mv "$GOLD" "$G"
        rm -rf "$GNEW"
        return 1
    fi

    # 旧布局的残留（这几个目录都当过家），一并清掉
    for old in /etc/mihomo/ni /etc/mihomo-gen; do
        [ -d "$old" ] && rm -rf "$old"
    done
    # ⚠️ 注意别把**真正在跑的那份配置**删了 —— /etc/mihomo/config.yaml 是个文件不是目录
    [ -d /etc/mihomo/config ] && rm -rf /etc/mihomo/config

    # 老布局把 btn.js 单独摆在 /ui/ 根下一个（那时它不在生成器目录里）—— 清掉。
    # 现在它就在 $G 里，跟生成器一起走。
    [ -f "$D/btn.js" ] && rm -f "$D/btn.js"

    # uhttpd 的 CGI 目录里只需一条链接：写盘（mihomo 自己的 API 不能写文件，PUT /configs 只改内存、
    # 不落盘）。历史版本还挂过「入口门」CGI（gen / ni / config），新方案没有了 —— 全清掉，否则
    # /www/cgi-bin/ 下留着悬空链接。
    # ⚠️ 目录不存在就建：没有这条链接，「载入配置文件」永远 403，而屏幕上还打着「已就位」。
    mkdir -p /www/cgi-bin 2>/dev/null
    ln -sf "$G/mihomo-apply" /www/cgi-bin/mihomo-apply 2>/dev/null
    ln -sf "$G/mihomo-sub" /www/cgi-bin/mihomo-sub 2>/dev/null
    # ⚠️ 链接建不上（/www 只读、overlay 满）不能当成功：页面一切正常、只有「载入配置文件」
    #    永远 404。这里明说，别让人到用的时候才发现。
    if [ ! -x /www/cgi-bin/mihomo-apply ]; then
        echo "✘ 配置工具：写盘接口没挂上（/www/cgi-bin/mihomo-apply）—— 检查 /www 是否可写" >&2
        rc=1
    fi
    if [ ! -x /www/cgi-bin/mihomo-sub ]; then
        echo "✘ 配置工具：订阅拉取接口没挂上（/www/cgi-bin/mihomo-sub）—— 检查 /www 是否可写" >&2
        rc=1
    fi
    for n in $LEGACY_CGI_NAMES; do drop_link "$n"; done

    # 面板左下角那个绿点：挂着 —— 用户要拿它管「不带公网、只映射了 9090」那类机器：那种机器进不了
    # uhttpd 上那排 LuCI 入口，绿点是进生成器的唯一门；LuCI 那条照旧，两条并存。
    # ⚠️ 幂等：当前这一版的也挂着了就什么都不动（整段比对，见 mount_button）；面板一升级 config.js
    #    会被换回原样，重新跑一次本脚本就补回来了。
    mount_button

    # ⚠️ 清那行内网地址提示（mount_lan_hint）**不在**这儿 —— 它在换名之前就做在暂存
    #    目录上了（见上面那段）。

    # 面板那个会兜底 /ui/config/ 的 service worker 得收掉，否则 https 下打开生成器白屏
    tame_sw

    # 信箱那条撤了（见文件头）—— 这里反过来清掉老机器上残留的取信脚本 + cron 行
    uninstall_pull

    # ⚠️ 生成器是**整个目录**换新的，套件写进去的 theme.js（面板跟随路由器主题用）
    #    不在 kit 里 ⇒ 装一次就没了（表现：LuCI 亮色、面板还是黑的）。
    #    套件在就让它自己补一遍（幂等、只写本地文件）；单独装生成器时没有这段也无所谓。
    if [ -x /usr/sbin/mtun-xd ]; then
        /usr/sbin/mtun-xd seed-panel >/dev/null 2>&1 || true
    fi

    # 老界面只有「工具升级」—— 顺手把控制台正文升上来（版本不一致才动）
    self_upgrade_suite

    # ⚠️ 绿点挂上去时 mount_button 顺手把 index.html 里 `config.js?v=` 也换掉了，所以不用再让用户
    #    按 Ctrl+F5；之后本脚本就不碰这两个文件了。
    # ⚠️ 收尾就这两行，工具密码只在这儿打一次；刚把控制台升上来那一趟，最后那行 ✔ 由 install.sh
    #    打过了，这里再打一句就是把同一件事说两遍。
    [ "$BRIDGED" = 1 ] && return 0
    # 写盘口没挂上就别打「已就位」（上面的 rc 只是记号，真正决定收尾话术的是这句）
    if [ "$rc" = 1 ] || [ ! -x /www/cgi-bin/mihomo-apply ]; then
        echo "⚠️ 配置工具：页面已就位，但「载入配置文件」的写盘口没挂上"
        return 1
    fi
    echo "✔ 配置工具：已就位"
    # ⚠️ 写成 if 而不是 `[ -n … ] && echo …`：后者在 TOOLPW 为空时整体返回 1，而它正好是函数最后
    #    一句 ⇒ 调用方会当成「安装失败」，在后面补一个 ✘。
    # ⚠️ 套件调这个脚本时会带 MIHOMO_KIT_QUIET=1（工具密码由它最后统一打），这里再打一遍就重复；
    #    单独跑本脚本时照旧打。
    if [ -n "${TOOLPW:-}" ] && [ "${MIHOMO_KIT_QUIET:-0}" != 1 ]; then
        echo "    工具密码 $TOOLPW（$TOOLFILE）"
    fi
    return 0
}

uninstall_gen(){
    acquire_lock || { echo "⚠️ 另一个套件操作正在进行，稍后再试"; return 1; }
    # ⚠️ **故意不删 $TOOLFILE**（工具密码）—— 装回来时应该还是发出去的那一把，
    #    悄悄换掉的话，你发给人家的密码全作废了。真想换：rm -f "$TOOLFILE"。
    echo "→ 工具密码留在 $TOOLFILE（想换一把就删掉它再装）"

    # 面板 config.js 里挂的那一段先摘掉（标记行到文件末尾就是它）
    unmount_button
    bump_cfg_ver

    # 当前 + 所有历史名字都清一遍（悬空链接也算，见 drop_link 的注释）
    for n in $LEGACY_CGI_NAMES; do drop_link "$n"; done
    drop_link mihomo-apply
    drop_link mihomo-sub

    [ -d "$G" ] && rm -rf "$G"

    # 换包用的暂存目录（正常装完就清了；装到一半被打断会留下，顺便收掉）
    rm -rf "$GNEW" "$GOLD"

    # 老布局可能把 btn.js 单独摆在这儿
    [ -f "$D/btn.js" ] && rm -f "$D/btn.js"

    # 我们换掉过面板的 sw.js（见 tame_sw）—— 撤掉，别留个来历不明的文件。还原不了原版（它跟面板
    # 一起走），删掉之后浏览器取 sw.js 会 404、注册被注销，面板退回「没有 service worker」，照样能用。
    # ⚠️ 只删我们自己写的那份（看文件头的标记）：在没装过生成器 / 面板 sw.js 本来就不带
    #    NavigationRoute 的机器上跑 `u`，不能把面板原版一起删了。
    if [ -f "$D/sw.js" ] && grep -q '由 deploy/generator.sh 换成的空 SW' "$D/sw.js" 2>/dev/null; then
        rm -f "$D/sw.js"
    fi

    # 更早那几版的残留
    for old in /etc/mihomo/ni /etc/mihomo-gen; do
        [ -d "$old" ] && rm -rf "$old"
    done
    [ -d /etc/mihomo/config ] && rm -rf /etc/mihomo/config

    # 取信脚本 + 它那行 cron
    uninstall_pull

    echo "✔ 撤干净了"
}

menu(){
    while :; do
        echo
        # ⚠️ 居中是算出来的，不是随手敲的空格：分隔线 14 列宽，`配置生成器` 5 个汉字 = 10 列，
        #    所以左右各补 2 个空格正好 14 列。
        echo "──────────────"
        echo "  配置生成器  "
        echo "──────────────"
        echo "[1] 安装生成器"
        echo "[2] 卸载生成器"
        echo "[3] 看工具密码"
        echo "[0] 优雅的退出"
        echo "──────────────"
        printf "选择: "

        # 把整组重定向到 /dev/null：/dev/tty 打不开时是 **shell 自己**报错，
        # 直接挂在 read 上的 2>/dev/null 压不掉它，得套一层 { }。
        c=
        if ! { read -r c < /dev/tty; } 2>/dev/null; then
            # ⚠️ 这里不打印下载地址（不想让客户看到托管域名），只给一句「带动作再跑一次」。
            echo
            echo "读不到终端 —— 带动作再跑一次：i 安装 / u 卸载 / p 看工具密码"
            return 1
        fi

        case "$c" in
            1) install_gen ;;
            2) uninstall_gen ;;
            3) show_tool_password ;;
            0) return 0 ;;
            *) echo "无效" ;;
        esac
    done
}

# 带参数就直接执行，不进菜单
case "$1" in
    i|install)   install_gen; exit $? ;;
    u|uninstall) uninstall_gen; exit $? ;;
    p|pass|tool) show_tool_password; exit $? ;;
esac

menu
