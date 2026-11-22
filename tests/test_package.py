#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""打包自检 —— build.py 造出来的 ipk 里到底装了什么。

用法（仓库根）：

    python3 tests/test_package.py            # 造一遍 + 检
    python3 tests/test_package.py --no-build # 用现有的包检（CI 里已经造过时）

查的都是只有上机才暴露、本地 CI 一直绿的那类事：control 字段 / 版本号跟生成器一致、
三页 js 文件名带「版本 + 内容指纹」且 menu.d 指的路径真实存在、common_<版本>_<指纹>.js 在、
shell 脚本带执行位、目录条目齐全（opkg 不建父目录）、postinst / prerm 是 0755、
同样源码连造两次字节一致、install.sh 不写死包版本号。

退出码：0 全过；1 有失败项（逐条打出来）。
"""
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAME = 'luci-app-mtun-xd'
ARCH = 'all'

fails = []
notes = []


def check(cond, msg, detail=''):
    if cond:
        notes.append('  ✔ ' + msg)
    else:
        fails.append(msg + (('（%s）' % detail) if detail else ''))


def generator_version():
    p = os.path.join(ROOT, 'generator', 'app', 'state.js')
    m = re.search(r"APP_VERSION\s*=\s*['\"]v?([^'\"]+)['\"]", open(p, encoding='utf-8').read())
    if not m:
        raise SystemExit('✘ 读不到 generator/app/state.js 里的 APP_VERSION')
    return m.group(1).strip()


def build():
    r = subprocess.run([sys.executable, 'build.py', 'ipk'], cwd=ROOT,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    if r.returncode != 0:
        sys.stdout.write(r.stdout.decode('utf-8', 'replace'))
        raise SystemExit('✘ build.py ipk 失败')


def tar_members(tf):
    return {m.name.lstrip('./'): m for m in tf.getmembers() if m.name not in ('.', './')}


def main():
    no_build = '--no-build' in sys.argv
    ver = generator_version()
    ipk = os.path.join(ROOT, '%s_%s_%s.ipk' % (NAME, ver, ARCH))

    created_pkg = not os.path.exists(ipk)
    if not no_build or not os.path.exists(ipk):
        build()
    if not os.path.exists(ipk):
        raise SystemExit('✘ 没找到 %s' % os.path.basename(ipk))

    size = os.path.getsize(ipk)
    check(0 < size < 2 * 1024 * 1024, '包体积合理', '%d 字节' % size)

    with tarfile.open(ipk, 'r:gz') as outer:
        om = tar_members(outer)
        check('debian-binary' in om, '外层有 debian-binary')
        check('control.tar.gz' in om and 'data.tar.gz' in om, '外层有 control/data.tar.gz')
        ctl_bytes = outer.extractfile(om['control.tar.gz']).read()
        dat_bytes = outer.extractfile(om['data.tar.gz']).read()

    # ── control ────────────────────────────────────────────────────────────
    with tarfile.open(fileobj=io.BytesIO(ctl_bytes), mode='r:gz') as ctl:
        cm = tar_members(ctl)
        control = ctl.extractfile(cm['control']).read().decode('utf-8')
        postinst = cm.get('postinst')
        prerm = cm.get('prerm')
        check(postinst is not None and prerm is not None, '维护脚本齐全')
        check(postinst is not None and postinst.mode & 0o111 != 0,
              'control.tar.gz 里 postinst 可执行', oct(postinst.mode) if postinst else '缺失')
        check(prerm is not None and prerm.mode & 0o111 != 0,
              'control.tar.gz 里 prerm 可执行', oct(prerm.mode) if prerm else '缺失')

    fields = dict(re.findall(r'^([A-Za-z-]+):\s*(.*)$', control, re.M))
    check(fields.get('Package') == NAME, 'Package 名对', fields.get('Package'))
    check(fields.get('Version') == ver, 'Version 跟生成器一致', '%s vs %s' % (fields.get('Version'), ver))
    check(fields.get('Architecture') == ARCH, 'Architecture: all', fields.get('Architecture'))
    check(set(x.strip() for x in (fields.get('Depends') or '').split(',') if x.strip())
          == {'curl', 'luci-base', 'ca-bundle', 'kmod-tun'},
          'Depends 含 curl / luci-base / ca-bundle / kmod-tun', fields.get('Depends'))
    check('\r' not in control, 'control 里没有 CRLF（路由器不认）')

    # acl.d 写坏了要到路由器上才发现 —— 这里先解析一遍
    import json as _json
    acl_path = os.path.join(ROOT, 'package', 'usr', 'share', 'rpcd', 'acl.d', '%s.json' % NAME)
    try:
        _acl = _json.load(open(acl_path, encoding='utf-8'))
        check(NAME in _acl, 'acl.d 是合法 JSON 且含本包条目')
    except Exception as e:
        check(False, 'acl.d 能解析', str(e))

    # ── data ──────────────────────────────────────────────────────────────
    with tarfile.open(fileobj=io.BytesIO(dat_bytes), mode='r:gz') as dat:
        dm = tar_members(dat)
        names = set(dm)

        for rel in ('usr/sbin/mtun-xd', 'etc/init.d/mihomo',
                    'etc/init.d/mtun-xd-selfcheck',
                    'usr/share/luci/menu.d/%s.json' % NAME,
                    'usr/share/rpcd/acl.d/%s.json' % NAME,
                    'usr/share/mtun-xd/mihomo-kwrt-nginx.sh',
                    'usr/share/mtun-xd/mihomo-haproxy.sh',
                    'www/luci-static/resources/mtun-xd/common.js'):
            check(rel in names, '包里在 %s' % rel)
        for rel in ('usr/sbin/mtun-xd', 'etc/init.d/mihomo',
                    'etc/init.d/mtun-xd-selfcheck',
                    'usr/share/mtun-xd/mihomo-kwrt-nginx.sh',
                    'usr/share/mtun-xd/mihomo-haproxy.sh'):
            if rel in names:
                check(dm[rel].mode & 0o111 != 0, '%s 有执行位' % rel, oct(dm[rel].mode))

        # 三页 js：文件名必须带 版本+指纹（老的那份不带指纹的留着给老会话兜底）
        views = sorted(n for n in names if n.startswith('www/luci-static/resources/view/mtun-xd/')
                       and n.endswith('.js') and n.count('/') == 5)
        fingerprinted = [n for n in views
                         if re.search(r'(generator|panel|upgrade)_\d+_[0-9a-f]{6}\.js$', n)]
        check(len(fingerprinted) == 3, '三页 js 都带「版本+指纹」文件名',
              ','.join(os.path.basename(n) for n in fingerprinted))

        commons = [n for n in names if re.match(r'www/luci-static/resources/mtun-xd/common_\d+_[0-9a-f]{6}\.js$', n)]
        check(len(commons) == 1, 'common_<版本>_<指纹>.js 恰好一份', ','.join(commons))

        # menu.d 指的三个页面，包里必须真有
        menu_rel = 'usr/share/luci/menu.d/%s.json' % NAME
        if menu_rel in names:
            menu_src = dat.extractfile(dm[menu_rel]).read().decode('utf-8')
            try:
                json.loads(menu_src)
                check(True, 'menu.d 是合法 JSON')
            except Exception as e:
                check(False, 'menu.d 不是合法 JSON', str(e))
            paths = re.findall(r'"path"\s*:\s*"([^"]+)"', menu_src)
            check(len(paths) == 3, 'menu.d 里有 3 个页面路径', str(paths))
            for p in paths:
                want = 'www/luci-static/resources/view/%s.js' % p
                check(p.startswith('mtun-xd/') and re.search(r'_\d+_[0-9a-f]{6}$', p) is not None,
                      'menu.d 路径带指纹：%s' % p)
                check(want in names, 'menu.d 指的页面在包里：%s' % want)

        # 目录条目：opkg 不会自己建父目录
        dirs = {n.rstrip('/') for n, m in dm.items() if m.isdir()}
        need_dirs = set()
        for n in names:
            parts = n.split('/')
            for i in range(1, len(parts)):
                need_dirs.add('/'.join(parts[:i]))
        missing_dirs = sorted(d for d in need_dirs if d not in dirs)
        check(not missing_dirs, '父目录条目齐全', ','.join(missing_dirs[:3]))

        # 开发文件不许进包
        junk = [n for n in names if n.endswith(('.md', '.py', '.mjs', '.test.js'))
                or '/tests/' in n or n.startswith('tests/')]
        check(not junk, '包里没有开发文件', ','.join(junk[:3]))

    # N-12/N-13/N-17/N-18：状态三分支、失败原因、禁用态类名
    ui_src = open(os.path.join(ROOT, 'package/www/luci-static/resources/view/mtun-xd/upgrade.js'),
                  encoding='utf-8').read()
    check("raw.indexOf('未运行') === -1" not in ui_src, '内核不再用「未运行」单条判据（N-12 根因已删）')
    check(ui_src.count('版本读不出') >= 2 and 'unknown:' in ui_src,
          '「装了但版本读不出」有独立文案与橙色胶囊')
    check(ui_src.count('errText(') >= 3, '失败原因经过 errText() 带出（coreAct + 两个启动失败出口）')
    check('.mh-btn[disabled]' in ui_src and 'mh-core-btn' not in ui_src,
          '禁用态类名统一为 .mh-btn（升级按钮与启停按钮一致）')

    # 视图文件自愈：menu.d 引用带戳文件名、view 里 require 带戳模块，缺了都会整页 404
    post = open(os.path.join(ROOT, 'control/postinst'), encoding='utf-8').read()
    check('视图文件自愈' in post and '模块自愈' in post, 'postinst 同时自愈 view 与 require 的模块')
    check('0-9a-fA-F' in post, '剥戳正则同时兼容大小写十六进制')
    check('if [ "$fixed" = 1 ]; then' in post, '无需修补时整段不返回非零')
    sh_bin = ('C:/Program Files/Git/usr/bin/sh.exe' if os.path.exists('C:/Program Files/Git/usr/bin/sh.exe')
              else shutil.which('sh'))
    if sh_bin:
        import tempfile
        start_i = post.find('# ── 0.5) 视图文件自愈')
        end_i = post.find('# ── 开机自检')
        snippet = post[start_i:end_i] if start_i != -1 and end_i > start_i else ''
        check(bool(snippet), '能取出 postinst 的自愈片段')

        def run_selfheal(menu_paths, views, mods, pre_views=None):
            td = tempfile.mkdtemp(prefix='mtun-selfheal-')
            vdir = os.path.join(td, 'view'); os.makedirs(vdir)
            cdir = os.path.join(td, 'common'); os.makedirs(cdir)
            for name, body in views.items():
                open(os.path.join(vdir, name), 'w', encoding='utf-8').write(body)
            for name, body in mods.items():
                open(os.path.join(cdir, name), 'w', encoding='utf-8').write(body)
            for name, body in (pre_views or {}).items():
                open(os.path.join(vdir, name), 'w', encoding='utf-8').write(body)
            menu = os.path.join(td, 'menu.json')
            with open(menu, 'w', encoding='utf-8') as f:
                json.dump([{'action': {'path': p}} for p in menu_paths], f)
            env = dict(os.environ, VSUITE_MENU=menu, VSUITE_VDIR=vdir, VSUITE_CDIR=cdir,
                       PATH=os.path.dirname(sh_bin) + os.pathsep + os.environ.get('PATH', ''))
            r = subprocess.run([sh_bin, '-c', snippet], env=env, capture_output=True,
                               encoding='utf-8', errors='replace')
            stamped = os.path.join(vdir, 'upgrade_20261110_ABCDEF.js')
            return {
                'rc': r.returncode, 'out': r.stdout or '',
                'view': os.path.exists(stamped),
                'module': os.path.exists(os.path.join(cdir, 'common_20261110_ABCDEF.js')),
                'modules': sorted(os.listdir(cdir)),
                'stamped': open(stamped, encoding='utf-8').read() if os.path.exists(stamped) else None,
            }

        a = run_selfheal(['mtun-xd/upgrade_20261110_ABCDEF'],
                         {'upgrade.js': ('var C = require mtun-xd.common_20261110_ABCDEF as C;\n'
                                         'var U = require mtun-xd.util_20261110_ABCDEF;\n')},
                         {'common.js': '// common\n', 'util.js': '// util\n'})
        check(a['view'], '带戳 view 被补出（含大写十六进制）')
        check(a['module'], '带戳 require 模块被补出（带 as 别名）')
        check('util_20261110_ABCDEF.js' in a['modules'], '无 as 别名的 require 也能补出')
        check('视图文件自愈' in a['out'] and '模块自愈' in a['out'], '两类自愈都有可见提示')
        check(a['rc'] == 0, '自愈成功时 postinst 片段返回 0')

        b = run_selfheal(['mtun-xd/upgrade_20261110_ABCDEF'], {}, {},
                         pre_views={'upgrade_20261110_ABCDEF.js': '// keep\n'})
        check('自愈' not in b['out'], '文件已在时不重复复制')
        check(b['stamped'] == '// keep\n', '已存在文件内容不被覆盖')

        c = run_selfheal(['mtun-xd/upgrade_20261110_ABCDEF'], {}, {})
        check('视图文件缺失' in c['out'], '没有不带戳源文件时给出告警')
        check(c['rc'] == 0, '告警不把 postinst 判成失败')

    # ── install.sh：不再写死版本号 ─────────────────────────────────────────
    sh = open(os.path.join(ROOT, 'install.sh'), encoding='utf-8').read()
    check('VER_PKG' not in sh, 'install.sh 里没有写死的 VER_PKG')
    check('FILE="$PKG-$latest.apk"' in sh and 'FILE="${PKG}_${latest}_all.ipk"' in sh,
          'install.sh 用线上 latest 拼包文件名')
    check("OK: .* in [0-9]" in sh, 'install.sh 过滤 apk 的 OK 汇总行')
    check('ui_step "安装 mtun-xd"' in sh and 'ui_step "1/6 安装套件"' in sh,
          '安装输出使用步骤式标题')
    check('--no-scripts' in sh and 'MTUN_XD_STEPS=1 MTUN_XD_EMBEDDED=1' in sh,
          '安装器统一接管 postinst 后的结构化部署')
    check('不管核心 / 面板是不是已经齐全，都完整跑一遍六步' in sh,
          '已有组件时也始终显示完整安装步骤')

    # 主脚本要真的会调随包的 nginx 适配（80 归 nginx 的固件）
    cli = open(os.path.join(ROOT, 'package', 'usr', 'sbin', 'mtun-xd'), encoding='utf-8').read()
    check('NGINX_HELPER=/usr/share/mtun-xd/mihomo-kwrt-nginx.sh' in cli,
          '主脚本指向包内的 nginx 适配脚本')
    check('"$NGINX_HELPER" install' in cli, 'expose_on 会调 nginx 适配')
    check('haproxy_ready()' in cli and 'HAPROXY_STATE' in cli,
          'expose_on 能识别 HAProxy 80 端口分流')
    check('从 HAProxy 迁回 uhttpd' in cli and 'Proxy raw stream' in cli,
          '固件恢复原生 80 代理后自动迁回 uhttpd')
    check('HAPROXY_HELPER=/usr/share/mtun-xd/mihomo-haproxy.sh' in cli
          and '"$HAPROXY_HELPER" install' in cli,
          '不支持原始流代理时自动调用 HAProxy 助手')
    # 注意：HAProxy 两侧后端都得跟着现场走，写死会把面板或 LuCI 打到 502/503 ——
    # 内核侧地址由 expose_pick 探出来，LuCI 侧跟随 uhttpd 原来的监听地址（绑内网 IP 的固件回环上没有 8080）。
    helper_src = open(os.path.join(ROOT, 'deploy', 'mihomo-haproxy.sh'), encoding='utf-8').read()
    check('"$HAPROXY_HELPER" install "$a"' in cli,
          'HAProxy 后端用内核实际应答的地址（不写死 9090）')
    check('install_all "${2:-}"' in helper_src and 'server mihomo $tgt check' in helper_src,
          'HAProxy 助手按参数写后端地址')
    check('luci_addr()' in helper_src and 'server uhttpd $luci check' in helper_src,
          'HAProxy 的 LuCI 后端跟随 uhttpd 原监听（不写死 127.0.0.1:8080）')
    # 随包的两个 80 端口适配脚本也得过语法检查（CI 容易漏掉 deploy/ 这一层）
    for wf in ('ci.yml', 'release.yml'):
        wsrc = open(os.path.join(ROOT, '.github', 'workflows', wf), encoding='utf-8').read()
        check('sh tools/check-shell.sh' in wsrc,
              '%s 走统一的 shell 检查（覆盖 deploy/ 等全部脚本）' % wf)
    # 维护中心：start() 是 view 的方法、不在 render 闭包里 —— 里面只能碰 self._btnStart /
    # self._btnStop；直接写 btnStart 会抛 ReferenceError（点更新没反应、按钮还灰着）。
    upg = open(os.path.join(ROOT, 'package/www/luci-static/resources/view/mtun-xd/upgrade.js'),
               encoding='utf-8').read()
    sm = upg.find('start: function')
    se = upg.find('poll: function')
    body = upg[sm:se] if sm != -1 and se > sm else ''
    check(bool(body), 'upgrade.js 能定位 start() 函数体')
    # 只看「没有 self._ 前缀」的裸引用；self._btnStart.disabled 里也含 btnStart.，不能用 in
    bare = re.search(r'(?<![\w.])btn(Start|Stop)\.', body)
    check(bare is None,
          'start() 里不直接引用 render 闭包里的 btnStart/btnStop（必须 self._btnStart）')
    check('self._btnStart' in body and 'self._btnStop' in body,
          'start() 通过 self._btnStart / self._btnStop 锁启停按钮')

    # poll() 同样是 view 方法：里面只能调 self._coreRefresh，裸的 coreRefresh 会抛
    # ReferenceError，被 poll 的 catch 当成「DONE 还没好」→ 状态行永远停在「升级中…」。
    pm = upg.find('poll: function')
    pe = upg.find('handleSaveApply', pm) if pm != -1 else -1
    poll_body = upg[pm:pe] if pm != -1 and pe > pm else ''
    check(bool(poll_body), 'upgrade.js 能定位 poll() 函数体')
    bare_ref = re.search(r'(?<![\w._])coreRefresh\(', poll_body)
    check(bare_ref is None, 'poll() 里不直接引用 render 闭包里的 coreRefresh（必须 self._coreRefresh）')
    check('self._coreRefresh' in poll_body, 'poll() 通过 self._coreRefresh 恢复启停按钮')

    # UI 规范（AGENTS.md「UI 视觉与交互规范」）：五种状态色在明暗两套主题里都必须定义；
    # 日志只给状态值上色 —— 时间戳前缀与「状态：」必须保持正文色。
    css = open(os.path.join(ROOT, 'package/www/luci-static/resources/mtun-xd/common.js'),
               encoding='utf-8').read()
    for var in ('--mh-ok', '--mh-idle', '--mh-busy', '--mh-warn', '--mh-err'):
        check(css.count(var + ':') >= 2, '状态色 %s 在明暗两套主题里都有定义' % var)
    upgrade = open(os.path.join(ROOT, 'package/www/luci-static/resources/view/mtun-xd/upgrade.js'),
                   encoding='utf-8').read()
    check("addText(prefix, P.muted)" in upgrade, '日志时间戳前缀用 muted（不参与语义色）')
    check("addText(st[1], '')" in upgrade and "addText(st[2], lineColor(st[2]))" in upgrade,
          '日志只给「状态：」后面的值着色')

    # UI 规范（AGENTS.md）静态闸门：作用域、按钮尺寸、日志字号/着色、状态语义、文案
    upg = open(os.path.join(ROOT, 'package/www/luci-static/resources/view/mtun-xd/upgrade.js'),
               encoding='utf-8').read()
    st_i, po_i = upg.find('start: function'), upg.find('poll: function')
    rs_i, rs_end = upg.find('refreshStatus: function'), upg.find('start: function')
    for name, a, b in (('start', st_i, po_i), ('poll', po_i, upg.find('handleSaveApply')),
                       ('refreshStatus', rs_i, rs_end)):
        body = upg[a:b] if a != -1 and b > a else ''
        check(bool(body), 'upgrade.js 能定位 %s() 函数体' % name)
        for fn in ('coreRefresh', 'btnStart', 'btnStop'):
            bare = re.search(r'(?<![\w._])' + fn + r'\s*\(', body)
            check(bare is None, '%s() 里不裸引用 render 闭包的 %s' % (name, fn))
    btn_block = upg[upg.find('var BTN'):upg.find('var CARDS')]
    check('border-radius:6px' in btn_block and 'font-size:13px' in btn_block
          and 'min-width:92px' in btn_block,
          '升级按钮与启停按钮同一套尺寸（radius 6 / 13px / 92px）')
    check('font-size:15px' not in upg, '日志正文不得顶到 15px（保持低于 16px 标题）')
    check('font-size:14px; line-height:1.65' in upg, '日志正文 14px / 行高 1.65')
    lc = upg[upg.find('var LINE_COLORS'):upg.find('];', upg.find('var LINE_COLORS'))]
    check('▶' in lc and '→' in lc, 'LINE_COLORS 覆盖 ▶ 与 →')
    check("m[1] === '内核'" in upg and '已安装' in upg,
          '面板/控制台走安装态语义（未安装/已安装），不冒充运行中')
    ll = upg[upg.find('function logLine'):upg.find('return view.extend')]
    check('.replace(/\s+$/' in ll, 'logLine 追加前 trimEnd，杜绝连续空行')
    check("coreLog('状态：" not in upg, '状态快照不写进日志（胶囊的职责）')
    check("coreLog('OK" not in upg and "coreLog('FAIL" not in upg,
          '页面日志不用 ASCII OK/FAIL（统一 ✔/✘）')
    check("'读不出版本：'" not in upg and "'读不出版本：' +" not in upg,
          '读版本失败用固定中文文案，不贴 rpcd 英文原文')

    # 风险提示只放「运行日志」标题右侧，不冒充日志条目；正则只认基础码点
    check('（升级核心会断网几秒，失败自动回滚）' in upg, '风险提示常驻在「运行日志」同一排、水平居中')
    check('withPrefix' not in upg and '_prefix' not in upg,
          '日志首行不再注入页面自造的提示（前缀机制已移除）')
    check("logLine(out, '⚠️" not in upg, '日志里不再有页面自造的 ⚠️ 行')
    check('/^⚠/' in upg and '/^⚠️/' not in upg,
          '⚠️ 规则只认基础码点（不依赖 U+FE0F 变体选择符）')

    # 写盘 CGI 路径在 apply.js / btn.js 里是**刻意复制**的两份（两套 bundle 各自独立）：
    # 断言两边的字面量集合一致，改一处漏另一处会立刻红，比注释里的「两边一起改」可靠。
    cgi = {}
    for rel in ('generator/app/apply.js', 'generator/deploy/btn.js'):
        src = open(os.path.join(ROOT, rel), encoding='utf-8').read()
        cgi[rel] = set(re.findall(r"/cgi-bin/mihomo-apply", src))
    check(len(cgi['generator/app/apply.js']) > 0 and
          cgi['generator/app/apply.js'] == cgi['generator/deploy/btn.js'],
          '写盘 CGI 路径两边一致（apply.js / btn.js）')
    # 安装器挂的是 /www/cgi-bin/<名字>，名字必须跟 JS 调的那条路径的尾名一致
    gsh = open(os.path.join(ROOT, 'generator', 'deploy', 'generator.sh'), encoding='utf-8').read()
    mounted = set(re.findall(r'/www/cgi-bin/(mihomo-apply)', gsh))
    check(mounted == {'mihomo-apply'} and 'mihomo-apply' in
          set(p.rsplit('/', 1)[-1] for p in cgi['generator/app/apply.js']),
          '安装器挂载名与页面调用路径一致（mihomo-apply）')

    # 变量遮蔽：内层 `var X` 撞掉模块级同名变量时，node --check / 单测全绿，只有真的点一下才炸
    #（2026-11 实际事故：apply.js 的 `var doc` 让「载入配置文件」点了没反应）。零依赖、几秒钟。
    node = shutil.which('node')
    if node:
        r = subprocess.run([node, 'tools/check-shadow.mjs'], cwd=ROOT,
                           stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        out = r.stdout.decode('utf-8', 'replace').strip()
        check(r.returncode == 0, '生成器没有变量遮蔽', out.splitlines()[-1] if out else '')
    else:
        check(True, '变量遮蔽检查（跳过：没有 node）')

    check('expose_off' in cli and 'HAPROXY_UHTTPD_BAK' in cli,
          'expose off / uninstall 会恢复 uhttpd 80 监听')
    check('expose_ensure >/dev/null 2>&1 || true' in cli,
          '开机自检会重新收敛 80 端口路由')
    # 「已挂好 / on」必须真的能在 80 上打开面板，不能只看内核应答（假成功会让人以为面板能用）
    check('expose_live()' in cli and 'expose_probe "$cur" && expose_live' in cli,
          '80 端口状态以 /ui/ 实际可达为准')
    # 开机自检补装包：先落盘再执行（`curl | sh` 会把 curl 的失败吞成成功）
    check('selfcheck-install.sh' in cli and 'sh "$tmp" >/dev/null 2>&1' in cli,
          '开机自检补装时先下载再执行')

    # 装完先等 API 真应答，再挂 80 —— core_alive 只证明进程在，不证明 9090 能答
    _i_wait = cli.find('while core_alive && ! expose_probe "$(expose_addr)"')
    _i_on = cli.find('if expose_on; then expose_ok=1; fi')
    check(_i_wait != -1 and _i_on != -1 and _i_wait < _i_on,
          'setup 先等单点 expose_probe 应答再挂 80')
    check('expose_pick >/dev/null 2>&1' not in cli,
          '等待循环不整轮跑全地址 expose_pick')
    check('已挂好（$cur，内核重启中）' in cli and '已挂载，但内核未运行' in cli,
          '已挂载但内核未运行时有独立文案')
    check('面板仅本机 $(expose_addr)' in cli,
          '提示里的面板地址来自 expose_addr')
    check('expose_mounted()' in cli
          and '[ -f "$HAPROXY_STATE" ]' in cli
          and '[ -f "$NGINX_STATE" ]' in cli,
          'doctor 的挂载判据覆盖 uhttpd / HAProxy / nginx')
    check('已挂载，但 /ui/ 打不开' in cli,
          '已挂载但 /ui/ 失败时按 core_alive 归因')
    check('pidof haproxy' in cli and '[ -f "$NGINX_LOC" ]' in cli,
          '挂载判据校验 HAProxy 进程 / nginx 挂载点')
    check('80 端口：已挂载（${mounted:-$(expose_addr)}）' in cli,
          'SOFT 文案用实际挂载地址')
    check('仍可使用 9090' not in cli,
          '失败文案不再建议访问不可达的 9090')

    # 内核判活唯一入口：core_alive；按钮命令不得再裸 pidof
    check(cli.count('pidof mihomo') == 1, 'pidof mihomo 只出现在 core_alive 内')
    core_seg = cli[cli.find('core_alive()'):]
    core_seg = core_seg[:core_seg.find('\n}\n')]
    check('curl' not in core_seg and '9090' not in core_seg, 'core_alive 不依赖端口/API')
    check(' -t ' in core_seg, 'core_alive 排除 -t 校验进程')
    probe_seg = cli[cli.find('expose_probe()'):]
    check('core_alive || return 1' in probe_seg[:400], 'expose_probe 先短路 core_alive')
    for fn in ('core-state)', 'core-start)', 'core-stop)'):
        part = cli[cli.find(fn):]
        part = part[:part.find(';;')]
        check('core_alive' in part and 'pidof' not in part, fn[:-1] + ' 走 core_alive')

    # 生成器 CGI：先确认是我们自己的进程，再看 API；不再写死 9090
    cgi_path = os.path.join(ROOT, 'generator', 'deploy', 'mihomo-apply')
    if os.path.exists(cgi_path):
        cgi = open(cgi_path, encoding='utf-8').read()
        ch = cgi[cgi.find('core_healthy()'):]
        ch = ch[:ch.find('\n}\n')]
        check('core_alive || return 1' in ch, 'mihomo-apply 先判进程再探 API')
        check('127.0.0.1:9090' not in ch, 'mihomo-apply 不写死 9090')
        check('pidof' not in cgi, 'mihomo-apply 不自己判活（调 core-state）')
        check('/usr/sbin/mtun-xd core-state' in cgi, 'mihomo-apply 复用套件判活')
        check('docker' not in cgi, 'mihomo-apply 不保留 Docker 兜底')
        check("'/mihomo/'" not in cgi, 'mihomo-apply 不按进程名挑监听')

    # 卸载默认保留用户数据；只有显式 --purge 才全删；nginx 那套也要撤
    check('KEEP_CONFIG' in cli and 'uninstall [--purge|--keep-config]' in cli,
          'uninstall 支持安全保留与显式 purge')
    check('KEEP_CONFIG=1' in cli and '--purge|--all|purge)' in cli and 'ask_purge()' in cli,
          'uninstall 默认保留、交互确认后才 purge')
    check('[ -t 0 ]' in cli and '</dev/tty' not in cli, '非交互卸载不访问 /dev/tty')
    for step in ('1/4 停止服务', '2/4 删除核心', '3/4 卸载面板与配置工具', '4/4 清理数据'):
        check('ui_step "%s"' % step in cli, '卸载步骤：%s' % step)
    check('/tmp/mtun-xd.uninstall.log' in cli and 'mtun-xd 已完全卸载' in cli,
          '卸载隐藏包管理器流水账并收尾')
    for step in ('1/6 安装套件', '2/6 部署核心', '3/6 初始化默认配置', '4/6 部署 GEO 数据',
                 '5/6 部署面板与配置工具', '6/6 配置面板转发'):
        check('ui_step "%s"' % step in cli, '安装步骤：%s' % step)
    check('sh "$TMP/generator.sh" i >>"$STEP_LOG" 2>&1' in cli,
          '步骤模式收拢配置工具子安装器输出')
    check('"$NGINX_HELPER" uninstall' in cli, 'uninstall 会撤 nginx 那套')
    check('rm -rf "$BASE"' in cli, 'uninstall 会清 /etc/mihomo')
    # 核心 / 面板从官方 Release 下载前拿到 digest，第三方镜像也必须逐份校验
    check('release_asset_sha()' in cli and 'dl <github 路径> <落地文件> [期望 SHA-256]' in cli,
          '下载支持 SHA-256 校验')
    check("release_asset_sha MetaCubeX/mihomo \"$ver\" \"$f\"" in cli,
          '核心下载会查官方 SHA-256')
    check('release_asset_sha MetaCubeX/metacubexd "$ver" compressed-dist.tgz' in cli,
          '面板下载会查官方 SHA-256')
    # TUN（没有 /dev/net/tun 的固件）：装的时候补、卸的时候撤
    check('ensure_tun()' in cli and 'ensure_tun || say' in cli, 'setup 会补 TUN')
    check('rm -f "$TUN_INIT"' in cli, 'uninstall 会撤 TUN 补丁')
    # 装的时候环境要满足正常运行：预检 + 配置内核自检 + 起没起来
    check('preflight()' in cli and 'preflight || ok=0' in cli, 'setup 会做环境预检')
    check('"$BIN" -t -d' in cli, '起服务前用内核自检配置')
    check('core_running()' in open(os.path.join(ROOT, 'install.sh'), encoding='utf-8').read(),
          'install.sh 最后确认内核在跑')
    ins = open(os.path.join(ROOT, 'install.sh'), encoding='utf-8').read()
    check('mtun-xd.install.log' in ins and 'setsid' in ins, 'install.sh 支持后台安装（bg）')
    check(ins.count('luci-indexcache') >= 3, 'install.sh 装前 / 装后都清 LuCI 菜单缓存')
    check('install-log' in cli, 'CLI 有 install-log')
    # 开机自检：固件升级重启后自动补齐
    check('selfcheck()' in cli and 'pkg_registered()' in cli, 'CLI 有开机自检')
    check('mtun-xd-selfcheck enable' in open(os.path.join(ROOT, 'control', 'postinst'), encoding='utf-8').read(),
          'postinst 会启用开机自检')
    # 没变化就不重启内核（SSH 走代理出站，重启必断线）
    check('restart_needed()' in cli and 'START_STAMP' in cli, 'setup 没变化就不重启内核')

    # 「载入配置文件」要先用内核校验，失败恢复旧文件
    apply = open(os.path.join(ROOT, 'generator', 'deploy', 'mihomo-apply'), encoding='utf-8').read()
    check('"$TBIN" -t -d "$BASE" -f "$tmp"' in apply, '载入配置文件前会跑 mihomo -t')
    check('core_healthy()' in apply and 'core_restart && core_healthy' in apply,
          '载入配置文件后确认内核真的回来了（起不来就回滚）')
    check('501 Not Implemented' in apply and 'command -v mihomo' in apply,
          '找不到校验器时拒绝写盘，而不是跳过校验')
    check('date +%s > /etc/mtun-xd.start.stamp' in apply,
          '载入配置文件成功后会更新启动时间戳（免得重装套件白重启内核）')
    check('CFG_BAK' in apply and 'mv -f "$CFG_BAK" "$CONFIG"' in apply,
          '载入配置文件失败会恢复旧配置')
    check('CFG_KEEP_BAK=1' in apply, '恢复失败时保留旧配置备份')
    check('count=10241' in apply and '10485760' in apply, '载入配置文件限制 10 MiB')

    common = open(os.path.join(ROOT, 'package', 'www', 'luci-static', 'resources',
                               'mtun-xd', 'common.js'), encoding='utf-8').read()
    check("window.location.origin + '/version'" in common and 'res.status === 401' in common,
          '面板通过同源 /version 检查 80 反代')

    # curl 失败时会把**完整 URL** 打到 stderr（`-S` 是 show-error）——
    # 所有 curl 调用都必须把 stderr 吃掉，不然域名就从这里漏给用户了。
    naked = []
    for rel in ('install.sh', 'package/usr/sbin/mtun-xd', 'generator/deploy/generator.sh'):
        lines = open(os.path.join(ROOT, rel), encoding='utf-8').read().split('\n')
        i = 0
        while i < len(lines):
            block = lines[i]
            start = i + 1
            while block.rstrip().endswith('\\') and i + 1 < len(lines):
                i += 1
                block += ' ' + lines[i]
            s = block.strip()
            if not s.startswith('#') and re.search(r'(^|[\s($])curl\s+-', block):
                if not re.search(r'2>\s*/dev/null|2>&1', block):
                    naked.append('%s:%d' % (rel, start))
            i += 1
    check(not naked, 'curl 的报错（含 URL）都被吞掉了', ','.join(naked[:3]))

    sys.path.insert(0, ROOT)
    import build as build_mod
    check('location.origin' in build_mod.INDEX_HTML, '下载页按当前域名现拼安装命令')
    check('/tmp/mtun-xd-install.sh' in build_mod.INDEX_HTML,
          '下载页使用先下载再执行，避免双 Shell 提示符')

    # dist 的保留策略：当前版 + 上一版，两种外壳都要留
    names = [
        '%s-8.9.36.apk' % NAME, '%s_8.9.36_all.ipk' % NAME,
        '%s-8.9.35.apk' % NAME, '%s_8.9.35_all.ipk' % NAME,
        '%s-8.9.34.apk' % NAME, '%s_8.9.34_all.ipk' % NAME,
        'install.sh', 'latest.txt',
    ]
    kept = build_mod.keep_pkgs(names, '8.9.36')
    want = {'%s-8.9.36.apk' % NAME, '%s_8.9.36_all.ipk' % NAME,
            '%s-8.9.35.apk' % NAME, '%s_8.9.35_all.ipk' % NAME}
    check(kept == want, 'dist 只留当前版 + 上一版', ','.join(sorted(kept)))
    check(build_mod.keep_pkgs(['%s-8.9.36.apk' % NAME], '8.9.36') == {'%s-8.9.36.apk' % NAME},
          '还没有上一版时只留当前')

    # ── CHANGELOG 必须真的写了这一版 ───────────────────────────────────────
    # ⚠️ 必须调 build.py 的生产函数，别在这儿另写一份正则：两边规则一分家，
    #    测试就会在「发版说明要丢整节」的那一刻恰好变绿（比没有断言更糟）。
    if os.path.exists(os.path.join(ROOT, 'CHANGELOG.md')):
        sec = build_mod.changelog_section(ver)
        check(len(sec) > 40, 'build.py 能从 CHANGELOG 取到当前版本说明（%s）' % ver, '%d 字符' % len(sec))

    # ── 状态文案 ↔ 安装脚本判据必须一致 ──────────────────────────────────
    # install.sh 的 core_running() 是「跑 status | head -1 | grep 运行中」；
    # 文案一改就静默失配（2026-11-17 客户案例：内核正常，安装却报「没在跑」）。
    sbin_src = open(os.path.join(ROOT, 'package/usr/sbin/mtun-xd'), encoding='utf-8').read()
    inst_src = open(os.path.join(ROOT, 'install.sh'), encoding='utf-8').read()
    check('（运行中）' in sbin_src, 'status 输出含「（运行中）」')
    check('corestate' in inst_src, 'install.sh 用 corestate 判断内核状态')
    # 封死「改个引号就绕过」：只要 install.sh 里出现「运行中」就算失败
    check('运行中' not in inst_src, 'install.sh 不再依赖显示文案判断内核状态')
    check('corestate()' in sbin_src, '套件提供 corestate 命令')

    # ── 终端输出排版：标题/结论前不允许自带空行（交互输出用真终端验证过，这里做静态兜底）──
    check("printf '\\n▶" not in sbin_src and "printf '\\n▶" not in inst_src,
          '步骤标题前不补空行')
    check("printf '\\n✔" not in sbin_src and "printf '\\n✔" not in inst_src,
          '结论行前不补空行')
    check("printf '\\n  是否" not in sbin_src, '卸载提问前不补空行')
    check("printf '\\n  ✘" not in sbin_src, '失败行前不补空行')

    # ── 固件编译适配层（openwrt/）：不能和独立安装跑出两套逻辑 ──────────────
    fw_mk = os.path.join(ROOT, 'openwrt/Makefile')
    fw_boot = os.path.join(ROOT, 'openwrt/files/mtun-xd-firstboot')
    fw_cfg = os.path.join(ROOT, 'openwrt/files/mtun-xd.config')
    check(os.path.exists(fw_mk), '固件包定义 openwrt/Makefile 存在')
    check(os.path.exists(fw_boot) and os.path.exists(fw_cfg), '固件首次开机脚本与配置齐全')
    if os.path.exists(fw_mk):
        mk = open(fw_mk, encoding='utf-8').read()
        app_ver = re.search(r"APP_VERSION\s*=\s*'v([^']+)'",
                            open(os.path.join(ROOT, 'generator/app/state.js'), encoding='utf-8').read())
        want = app_ver.group(1) if app_ver else ''
        got = re.search(r'PKG_VERSION:=([0-9.]+)', mk)
        check(bool(got) and got.group(1) == want,
              '固件包版本与 APP_VERSION 一致（%s）' % want)
        check('$(PKG_BUILD_DIR)/package/.' in mk, '固件包直接复用 package/ 目录')
        check('mtun-xd setup' not in mk, '固件包不重复实现 setup')
    if os.path.exists(fw_boot):
        boot = open(fw_boot, encoding='utf-8').read()
        check('mtun-xd setup' in boot, '首次开机调用同一个 setup 实现')
        check('mtun-xd-firstboot.done' in boot, '首次开机有完成标记，不重复执行')

    # ── 可复现：同源码连造两次字节一致 ──────────────────────────────────────
    if not no_build:
        h1 = hashlib.sha256(open(ipk, 'rb').read()).hexdigest()
        build()
        h2 = hashlib.sha256(open(ipk, 'rb').read()).hexdigest()
        check(h1 == h2, '连造两次字节完全一致', '%s vs %s' % (h1[:12], h2[:12]))

    for line in notes:
        print(line)
    if fails:
        print('\n✘ 打包自检失败 %d 项：' % len(fails))
        for f in fails:
            print('  · %s' % f)
        return 1
    print('\n✔ 打包自检通过（%d 项）' % len(notes))
    # 自检过程自己打的包别留在仓库根（.gitignore 挡得住提交，挡不住它一直躺着）
    if created_pkg and os.path.exists(ipk):
        try:
            os.remove(ipk)
        except OSError:
            pass
    return 0


if __name__ == '__main__':
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
    sys.exit(main())
