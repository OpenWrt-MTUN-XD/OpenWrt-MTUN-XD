# -*- coding: utf-8 -*-
"""Mihomo 管理套件（MTUN-XD）—— 一次造出 .ipk 和 .apk 两种包。

两种包内容完全一样（同一份 package/ + control/ 脚本），只是外壳不同：
    · ipk = 一个 gzip 过的 tar（debian-binary / control.tar.gz / data.tar.gz），纯 python 就能造。
    · apk = ADB 格式，得用 apk-tools 的 mkpkg。注意：路由器上的 apk 不带 mkpkg，
            要用 Alpine 的 apk-tools-static（musl 静态，见 SUITE_APK_MKPKG）。

用法：python build.py            # 两种都造（同时更新 dist/ + 有凭据时发 GitHub Release）
      python build.py ipk|apk    # 只造一种（**不动 dist/**，免得另一种格式的包 404）
      python build.py dist       # 包已在仓库根：只更新 dist/ + SHA256SUMS
      python build.py release    # 包已在仓库根：只建 / 更新 GitHub Release
      python build.py publish    # dist + Release（本地一条龙）
      python build.py version    # 打印版本号（CI 用）
      python build.py sums       # 只重算 dist/SHA256SUMS
"""
import atexit
import gzip, hashlib, io, json, os, re, shlex, shutil, sys, tarfile, tempfile, subprocess
import urllib.request, urllib.error, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.join(HERE, 'package')
CONTROL = os.path.join(HERE, 'control')
# 桌面副本：给了 SUITE_DESKTOP 就用它，否则按当前用户的家目录推（别写死某一个人的路径）
DESKTOP = os.environ.get('SUITE_DESKTOP') or os.path.join(os.path.expanduser('~'), 'Desktop')

# 项目名 = luci-app-mtun-xd（GitHub 上叫 MTUN-XD，中文「Mihomo 管理套件」）
# 界面显示名 = 「MTUN-XD」（见 package/usr/share/luci/menu.d/…json）
NAME = 'luci-app-mtun-xd'
# 版本口径：只有 VERSION，没有 -rNN 那截；套件版本直接跟生成器走（两处只留一个号，
# 优先读 generator/ 的 APP_VERSION，没有才用兜底值），包版本 / 文件名 / tag / latest.txt 全用它。
def _generator_version():
    p = os.path.join(HERE, 'generator', 'app', 'state.js')
    try:
        with open(p, 'r', encoding='utf-8') as f:
            m = re.search(r"APP_VERSION\s*=\s*['\"]v?([^'\"]+)['\"]", f.read())
        if m:
            return m.group(1).strip()
    except OSError:
        pass
    return ''

VERSION = _generator_version() or '8.9.11'
ARCH = 'all'          # 无架构依赖：面板是静态文件、核心装的时候按 CPU 现挑
DESC = 'Mihomo 管理套件：面板 + 核心 + 配置工具，装进 LuCI（服务 → MTUN-XD）'
URL = 'https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD'

# apk 那条要用的路由器（造包用，不是安装目标）；密码不写进仓库，走环境变量 SUITE_APK_PASSWORD
# 或 SSH key（SUITE_APK_KEY）。
HOST = os.environ.get('SUITE_APK_HOST', '192.168.100.1')
USER = os.environ.get('SUITE_APK_USER', 'root')
PW = os.environ.get('SUITE_APK_PASSWORD', '')
KEY = os.environ.get('SUITE_APK_KEY', '')
MKPKG = os.environ.get('SUITE_APK_MKPKG', '/tmp/alpine/x/sbin/apk.static')
RB = os.environ.get('SUITE_APK_RB', '/tmp/suitebuild')


# ── 收集要进包的文件（相对路径 → 绝对路径 + 权限）─────────────────────────
EXEC = {
    'usr/sbin/mtun-xd': 0o755,
    'etc/init.d/mihomo': 0o755,
    'etc/init.d/mtun-xd-selfcheck': 0o755,
    'www/luci-static/resources/mtun-xd/common.js': 0o644,
}
DEFAULT_MODE = 0o644


def check_mirrors():
    """install.sh 和套件脚本里的镜像表必须一模一样（两份是各自独立的常量）。"""
    def mirrors(path):
        try:
            with open(path, encoding='utf-8') as f:
                m = re.search(r'^MIRRORS="([^"]*)"', f.read(), re.M)
            return m.group(1) if m else None
        except OSError:
            return None
    a = mirrors(os.path.join(HERE, 'install.sh'))
    b = mirrors(os.path.join(PKG, 'usr', 'sbin', 'mtun-xd'))
    if a is None or b is None or a != b:
        raise SystemExit('✘ install.sh 与 package/usr/sbin/mtun-xd 的 MIRRORS 不一致')


def collect():
    files = {}
    for root, _dirs, names in os.walk(PKG):
        for fn in names:
            ap = os.path.join(root, fn)
            rel = os.path.relpath(ap, PKG).replace(os.sep, '/')
            files[rel] = (ap, EXEC.get(rel, DEFAULT_MODE))
    # nginx 前端（Kwrt / QWRT 这类）的 80 口适配脚本 —— **源只有一份**（deploy/），
    # 随包带进去：`mtun-xd expose on` 探到 80 归 nginx 时直接调它。
    helper = os.path.join(HERE, 'deploy', 'mihomo-kwrt-nginx.sh')
    if not os.path.isfile(helper):
        raise SystemExit('✘ 缺 deploy/mihomo-kwrt-nginx.sh')
    files['usr/share/mtun-xd/mihomo-kwrt-nginx.sh'] = (helper, 0o755)
    # uhttpd 没有原始流代理的固件（例如 iStoreOS 24.10）走 HAProxy 路径分流。
    helper = os.path.join(HERE, 'deploy', 'mihomo-haproxy.sh')
    if not os.path.isfile(helper):
        raise SystemExit('✘ 缺 deploy/mihomo-haproxy.sh')
    files['usr/share/mtun-xd/mihomo-haproxy.sh'] = (helper, 0o755)
    return versioned_views(files)


def versioned_views(files):
    """把三页的 js 按「版本号 + 内容指纹」换文件名（upgrade_897_ab12cd.js …）。

    注意：LuCI 静态资源的 `?v=` 不随本包变、uhttpd 的 Last-Modified 又是写死的，浏览器会
    照旧吃缓存 ⇒ 只换版本号不行，得让 URL 变；menu.d 的 path 同步指过去，老的留着不管。
    """
    import re as _re, hashlib as _hl
    tag = _re.sub(r'\D', '', VERSION) or '0'
    # 版本号 + **内容指纹**：同一个版本号下改了 js 也换 URL（否则又吃缓存）
    _h = _hl.md5()
    for _r in ('www/luci-static/resources/mtun-xd/common.js',
               'www/luci-static/resources/view/mtun-xd/upgrade.js',
               'www/luci-static/resources/view/mtun-xd/generator.js',
               'www/luci-static/resources/view/mtun-xd/panel.js'):
        if _r in files:
            with open(files[_r][0], 'rb') as _f:
                _h.update(_f.read())
    tag = tag + '_' + _h.hexdigest()[:6]
    tmp = tempfile.mkdtemp(prefix='mhsuite-ver-')
    # 这个临时目录打包全程都要用，进程结束时收掉（Windows 上 %TEMP% 攒得很快）。
    atexit.register(shutil.rmtree, tmp, True)

    menu_rel = 'usr/share/luci/menu.d/luci-app-mtun-xd.json'
    if menu_rel not in files:
        raise SystemExit('✘ 包里没有 menu.d（%s）' % menu_rel)
    src = io.open(files[menu_rel][0], encoding='utf-8').read()
    n = 0
    for _name in ('generator', 'panel', 'upgrade'):
        old = '"mtun-xd/%s"' % _name
        n += src.count(old)
        src = src.replace(old, '"mtun-xd/%s_%s"' % (_name, tag))
    # 注意：对不上就直接失败 —— 静默不换名 = 缓存那条病原样回来，而且没人能发现
    if n != 3:
        raise SystemExit('✘ menu.d 里三个 view 路径没对上（只换了 %d 个）' % n)
    mp = os.path.join(tmp, 'menu.json')
    io.open(mp, 'w', encoding='utf-8', newline='\n').write(src)
    files[menu_rel] = (mp, files[menu_rel][1])

    base = 'www/luci-static/resources/'
    common_rel = base + 'mtun-xd/common.js'
    if common_rel not in files:
        raise SystemExit('✘ 包里没有 common.js')
    files[base + 'mtun-xd/common_%s.js' % tag] = files[common_rel]

    for name in ('upgrade', 'generator', 'panel'):
        rel = base + 'view/mtun-xd/%s.js' % name
        if rel not in files:
            raise SystemExit('✘ 包里没有 %s.js' % name)
        src = io.open(files[rel][0], encoding='utf-8').read()
        src = src.replace('mtun-xd.common', 'mtun-xd.common_%s' % tag)
        vp = os.path.join(tmp, '%s_%s.js' % (name, tag))
        io.open(vp, 'w', encoding='utf-8', newline='\n').write(src)
        files[base + 'view/mtun-xd/%s_%s.js' % (name, tag)] = (vp, files[rel][1])

    # 不带指纹的原件照样留着：旧会话里 menu.d 的路径还是缓存过的，删了会 404 到退登。
    return files


# ── ipk：光 tar.gz 就行（debian-binary + control.tar.gz + data.tar.gz）──
TEXT_EXT = ('.sh', '.js', '.json', '.css', '.md', '.txt', '.conf', '.lua', '.htm', '.html')

def read_lf(p):
    """按**二进制**读进来，把 CRLF 统一成 LF（只对文本类文件；二进制原样，别改字节）。

    注意：包里那几个 shell 脚本是搬到路由器直接跑的，CRLF 会让第一行变成 `#!/bin/sh\r`、
    内核只报一句光秃秃的 `not found`；.gitattributes 钉了 LF，这里是打包时的兜底。
    """
    with open(p, 'rb') as f:
        data = f.read()
    # 二进制（图标 / lmo / 字体）不能动：改了字节会和实际大小对不上
    ext = os.path.splitext(p)[1].lower()
    if ext not in TEXT_EXT:
        # 无扩展名的脚本（/usr/sbin、init.d、control/*）靠 shebang 认出来
        if not (not ext and data[:2] == b'#!'):
            return data
    return data.replace(b'\r\n', b'\n')


def tar_gz(path, entries):
    """entries: [(arcname, kind, payload, mode)]，kind = 'file'|'bytes'

    注意：目录条目必须一起写进去 —— opkg 不会自己建父目录，只给文件的话一个都落不了盘
    （包装上了、文件不在，LuCI 那边就是 404）；apk 会自己建，所以只在 apk 上试看不出来。
    """
    dirs = []
    seen_dirs = set()
    for arc, _kind, _payload, _mode in entries:
        parts = arc.split('/')
        for i in range(1, len(parts)):          # 丢掉最后的文件名，逐级生成父目录
            d = '/'.join(parts[:i]) + '/'
            if d in seen_dirs or d in ('/', './'):
                continue
            seen_dirs.add(d)
            dirs.append(d)

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tf:
        # 父目录排在子目录前面（先浅后深），tar 提取时才顺
        for d in sorted(dirs, key=lambda x: (x.count('/'), x)):
            ti = tarfile.TarInfo(d)
            ti.type = tarfile.DIRTYPE
            ti.mode = 0o755
            ti.mtime = 1600000000
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = 'root'
            tf.addfile(ti)
        for arc, kind, payload, mode in entries:
            ti = tarfile.TarInfo(arc)
            ti.mtime = 1600000000
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = 'root'
            ti.mode = mode
            if kind == 'file':
                data = read_lf(payload)      # 注意：统一成 LF —— 见 read_lf 的注释
                ti.size = len(data)
                tf.addfile(ti, io.BytesIO(data))
            else:
                ti.size = len(payload)
                tf.addfile(ti, io.BytesIO(payload))
    # 注意：gzip 头里的 mtime 必须钉死 —— 默认写"现在"，同一个包每次打哈希都不一样
    # ⇒ dist/SHA256SUMS 每次发版都变（解压后其实是逐字节相同的）。
    with open(path, 'wb') as f:
        f.write(gzip.compress(buf.getvalue(), compresslevel=9, mtime=0))


def build_ipk(files):
    out = os.path.join(HERE, '%s_%s_%s.ipk' % (NAME, VERSION, ARCH))
    tmp = tempfile.mkdtemp()
    ctl = os.path.join(tmp, 'control.tar.gz')
    dat = os.path.join(tmp, 'data.tar.gz')

    control = (
        'Package: %s\n'
        # 版本号就是 VERSION，没有 -rNN 那截 —— 跟 apk 那边、GitHub 的 tag、latest.txt 一个口径。
        'Version: %s\n'
        'Architecture: %s\n'
        'Maintainer: OpenWrt-MTUN-XD\n'
        'Section: luci\n'
        'Priority: optional\n'
        'Depends: curl, luci-base, ca-bundle, kmod-tun\n'
        'Source: %s\n'
        'SourceName: %s\n'
        'License: MIT\n'
        'Description: %s\n'
        % (NAME, VERSION, ARCH, URL, NAME, DESC)
    )
    tar_gz(ctl, [
        ('./control', 'bytes', control.encode('utf-8'), 0o644),
        ('./postinst', 'file', os.path.join(CONTROL, 'postinst'), 0o755),
        ('./prerm', 'file', os.path.join(CONTROL, 'prerm'), 0o755),
    ])
    tar_gz(dat, [('./' + rel, 'file', ap, mode) for rel, (ap, mode) in sorted(files.items())])

    # 外层还是 tar.gz，但里面装的是上面那两个（gzip mtime 同样钉死，见 tar_gz）
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tf:
        for arc, path in (('./debian-binary', None), ('./control.tar.gz', ctl), ('./data.tar.gz', dat)):
            ti = tarfile.TarInfo(arc)
            ti.mtime = 1600000000
            ti.uid = ti.gid = 0
            ti.uname = ti.gname = 'root'
            ti.mode = 0o644
            if arc == './debian-binary':
                payload = b'2.0\n'
                ti.size = len(payload)
                tf.addfile(ti, io.BytesIO(payload))
            else:
                ti.size = os.path.getsize(path)
                with open(path, 'rb') as fh:
                    tf.addfile(ti, fh)
    with open(out, 'wb') as f:
        f.write(gzip.compress(buf.getvalue(), compresslevel=9, mtime=0))
    shutil.rmtree(tmp, ignore_errors=True)
    return out


# ── apk：传到路由器上用 Alpine 的 apk.static 造，再造好拉回来 ────────────
# 元数据 / 参数只写一份：本机 Linux 那条和 SSH 到路由器那条共用，改一处忘一处就会打出两种包。
def apk_args(out):
    return [
        '-I', 'name:%s' % NAME,
        '-I', 'version:%s' % VERSION,
        '-I', 'arch:noarch',
        '-I', 'description:%s' % DESC,
        '-I', 'license:MIT',
        '-I', 'url:%s' % URL,
        '-I', 'origin:%s' % NAME,
        # 注意：依赖要写在**同一个 -I** 里、空格分隔 —— 重复的 `-I depends:` 是覆盖不是追加
        # （只留下最后一个，curl 会被 luci-base 挤掉）。
        '-I', 'depends:curl luci-base ca-bundle kmod-tun',
    ] + [
        '-F', 'root',
        '-s', 'post-install:./postinst',
        '-s', 'post-upgrade:./postinst',
        '-s', 'pre-deinstall:./prerm',
        '-o', out,
    ]


def build_apk_local(tarpath, out):
    """在**本机 Linux** 上用 apk.static 造包（CI / Docker / WSL 走这条，不连路由器）。

    注意：apk.static 是 Linux 静态二进制，Windows 本机跑不了，那边仍走 SSH 到路由器。
    """
    mk = os.environ.get('SUITE_APK_MKPKG') or shutil.which('apk.static')
    if not mk:
        raise SystemExit('✘ 造 apk 要 apk-tools 3 的 apk.static：设 SUITE_APK_MKPKG，或装 apk-tools-static'
                         '（不带 mkpkg 的 apk 2.x 造不了）')
    work = tempfile.mkdtemp()
    try:
        with tarfile.open(tarpath, 'r:gz') as tf:
            tf.extractall(work)
        for fn in ('postinst', 'prerm'):
            os.chmod(os.path.join(work, fn), 0o755)
        outp = os.path.join(work, '%s-%s.apk' % (NAME, VERSION))
        cmd = [mk, 'mkpkg'] + apk_args(outp)
        print('造包：', ' '.join(cmd))
        subprocess.run(cmd, cwd=work, check=True)
        shutil.copy(outp, out)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return out


def build_apk(files):
    out = os.path.join(HERE, '%s-%s.apk' % (NAME, VERSION))

    tmp = tempfile.mkdtemp()
    tarpath = os.path.join(tmp, 'build.tgz')
    # 注意：**不能用 tf.add()**（它照搬文件系统上的权限，Windows 上编出来是 0664 →
    # 装完脚本没有执行位、postinst 直接跳过），跟 ipk 那边一样逐条写 TarInfo 把权限写死。
    tar_gz(tarpath, [('root/' + rel, 'file', ap, mode) for rel, (ap, mode) in sorted(files.items())]
           + [(fn, 'file', os.path.join(CONTROL, fn), 0o755) for fn in ('postinst', 'prerm')])

    if os.environ.get('SUITE_APK_LOCAL') == '1':
        try:
            return build_apk_local(tarpath, out)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    import paramiko
    c = paramiko.SSHClient()
    c.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kw = dict(timeout=15, allow_agent=True, look_for_keys=True)
    if PW:
        kw['password'] = PW
    if KEY:
        kw['key_filename'] = KEY
    try:
        c.connect(HOST, 22, USER, **kw)
    except paramiko.AuthenticationException:
        print('✘ 造 apk 连不上 %s：设 SUITE_APK_PASSWORD，或配好 SSH key（SUITE_APK_KEY）' % HOST)
        raise
    sf = c.open_sftp()

    def run(cmd, t=300):
        """跑一条远端命令，返回 (退出码, 输出)。注意：退出码必须回传 —— mkpkg 失败时
        若照样继续 sf.get，会把上一次同版本留下的旧包当成新的发出去。"""
        _i, o, e = c.exec_command(cmd, timeout=t)
        out = o.read().decode('utf-8', 'replace') + e.read().decode('utf-8', 'replace')
        return o.channel.recv_exit_status(), out.rstrip()

    run('rm -rf %s && mkdir -p %s' % (RB, RB))
    sf.put(tarpath, RB + '/build.tgz')
    # 注意：postinst / prerm 已经在 build.tgz 里了，别再单独传一遍（传了也会被解压覆盖）
    print(run('cd %s && tar xzf build.tgz && chmod +x postinst prerm && ls' % RB)[1])

    remote_pkg = '/tmp/%s-%s.apk' % (NAME, VERSION)
    # 注意：先删掉同名旧包 —— 远端路径是固定的，重跑同一版时留下的旧文件在 mkpkg 失败后
    # 会被原样取回来当成"新包"。
    run('rm -f %s' % remote_pkg)
    argv = [MKPKG, 'mkpkg'] + apk_args(remote_pkg)
    cmd = 'cd %s && %s' % (RB, ' '.join(shlex.quote(a) for a in argv))
    print('造包：', cmd)
    rc, msg = run(cmd)
    print(msg or '(无输出)')
    if rc != 0:
        raise SystemExit('✘ apk 打包失败（mkpkg 退出码 %s）' % rc)
    rc, msg = run('ls -l %s' % remote_pkg)
    print(msg)
    if rc != 0:
        raise SystemExit('✘ apk 没生成（%s 不在）' % remote_pkg)
    sf.get(remote_pkg, out)
    sf.close()
    c.close()
    if not os.path.isfile(out) or os.path.getsize(out) == 0:
        raise SystemExit('✘ 取回来的 apk 是空的')
    shutil.rmtree(tmp, ignore_errors=True)
    return out




def gh_token():
    """拿 GitHub 凭据：**先看环境变量**（CI 的 GITHUB_TOKEN / GH_TOKEN），
    再回落到 GCM（本机）。**不落盘、不打印。** 拿不到返回空串。"""
    for k in ('GITHUB_TOKEN', 'GH_TOKEN'):
        v = os.environ.get(k, '').strip()
        if v:
            return v
    # 注意：别在命令串里用 shell 的 `timeout` —— Git for Windows 没有它（System32 那个不认管道），
    # 整条会静默失败 ⇒ 本机发版永远跳过 Release；用 subprocess 自己的超时。
    try:
        out = subprocess.run(['git', 'credential', 'fill'],
                             input='protocol=https\nhost=github.com\n\n',
                             capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return ''
    m = re.search(r'^password=(.+)$', out, re.M)
    return m.group(1).strip() if m else ''


def changelog_section(ver):
    """从 CHANGELOG.md 里取 `## <ver>` 那一段（去掉标题行），取不到返回空串。"""
    path = os.path.join(HERE, 'CHANGELOG.md')
    try:
        text = io.open(path, encoding='utf-8').read()
    except OSError:
        return ''
    # 标题可能带后缀（`## 2026.11.05（未发布）`）：只按版本号精确匹配会把整节吞掉
    m = re.search(r'^## %s[^\n]*\n(.*?)(?=^## |\Z)' % re.escape(ver), text, re.M | re.S)
    return m.group(1).strip() if m else ''


def release_body():
    """Release 页的说明：更新内容 + 版本 + 包列表 + 一键安装。"""
    ver = VERSION
    changes = changelog_section(ver) or '- 维护性更新（详见 CHANGELOG.md）'
    return '\n'.join([
        '## 📣 更新内容',
        '',
        changes,
        '',
        '## 💽 MTUN-XD 信息',
        '',
        '**版本**：`%s`' % ver,
        '',
        '## 📦 Packages List',
        '',
        '| 包 | 版本 | 用途 |',
        '| --- | --- | --- |',
        '| 🧊 APK | `%s` | 手动安装（apk 固件） |' % ver,
        '| 🧊 IPK | `%s` | 手动安装（opkg 固件） |' % ver,
        '| 🧊 APK | `%s-r1` | 固件集成编译（OpenWrt 25.12 SDK） |' % ver,
        '| 🧊 IPK | `%s-r1` | 固件集成编译（OpenWrt 24.10 SDK） |' % ver,
        '',
    ])


def publish_release(made):
    """把这次的包也发到 **GitHub Releases** —— 用户自己上网页下载方便。

    仓库已开源，附件任何人都能下载；国内访问不稳时可走镜像（见 README）。
    失败只警告，GitHub 不通 / 没凭据都不该拦着本地打包。
    只在两种包都造出来时才发（`python build.py ipk` 那种半份不发）。
    """
    tok = gh_token()
    if not tok:
        print('⚠️ 没发 GitHub Release（GCM 里没有 GitHub 凭据）—— 不影响本地和 CF')
        return False
    tag = 'v%s' % VERSION
    body = release_body()

    def api(url, data=None, method=None, ctype='application/json'):
        r = urllib.request.Request(url, data=data, method=method)
        r.add_header('Authorization', 'token ' + tok)
        r.add_header('Accept', 'application/vnd.github+json')
        if data is not None:
            r.add_header('Content-Type', ctype)
        try:
            with urllib.request.urlopen(r, timeout=120) as f:
                return f.status, json.loads(f.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as e:
            # 错误页不一定是 JSON（502 那种 HTML）—— 解析失败就当空对象，别把整趟抛掉
            try:
                return e.code, json.loads(e.read().decode('utf-8') or '{}')
            except ValueError:
                return e.code, {}
        except (urllib.error.URLError, OSError, ValueError):
            # DNS / TLS / 连接被掐：返回 0 让调用方按「没发出去」处理，别把整趟抛掉
            return 0, {}

    repo = 'OpenWrt-MTUN-XD/OpenWrt-MTUN-XD'
    st, d = api('https://api.github.com/repos/%s/releases' % repo,
                json.dumps({'tag_name': tag, 'name': tag, 'body': body},
                           ensure_ascii=False).encode('utf-8'))
    if st == 422:   # 已经有了（重跑同版本）
        st, d = api('https://api.github.com/repos/%s/releases/tags/%s' % (repo, tag))
        # 说明也一起刷新：模板改过 / CHANGELOG 补过之后，重跑能同步到已发布的版本
        if st == 200 and d.get('id'):
            api('https://api.github.com/repos/%s/releases/%d' % (repo, d['id']),
                json.dumps({'body': body}, ensure_ascii=False).encode('utf-8'), method='PATCH')
    if st not in (200, 201):
        print('⚠️ 没发 GitHub Release（HTTP %s）—— 不影响本地和 CF' % st)
        return False
    rid = d['id']
    # 注意：同名附件不能覆盖：先删旧的再传（重跑同版本时会碰到）
    st, assets = api('https://api.github.com/repos/%s/releases/%d/assets' % (repo, rid))
    have = {a['name']: a['id'] for a in (assets or [])} if isinstance(assets, list) else {}
    bad = False
    for p in made:
        fn = os.path.basename(p)
        if fn in have:
            api('https://api.github.com/repos/%s/releases/assets/%d' % (repo, have[fn]), method='DELETE')
        up = 'https://uploads.github.com/repos/%s/releases/%d/assets?name=%s' % (repo, rid, urllib.parse.quote(fn))
        st, _ = api(up, open(p, 'rb').read(), 'POST', 'application/octet-stream')
        if st == 201:
            print('  GitHub 附件 → %s' % fn)
        else:
            bad = True
            print('  ⚠️ 附件没传上：%s（HTTP %s）' % (fn, st))
    if bad:
        # 半份 Release 不能当成功（下次重跑会补传——见 release.yml 的判定）
        print('⚠️ Release 建好了，但有附件没传上 —— 再跑一次')
        return False
    print('GitHub Release → %s' % tag)
    return True


INDEX_HTML = '''<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="dark">
<title>MTUN-XD · 墨枢云境</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NCA2NCI+PHJlY3Qgd2lkdGg9IjY0IiBoZWlnaHQ9IjY0IiByeD0iMTQiIGZpbGw9IiMwYjEyMjAiLz48cGF0aCBkPSJNOCA0OCBMMjYgMjAgTDM2IDM1IEw0MyAyNiBMNTYgNDggWiIgZmlsbD0iIzU4YTZmZiIvPjxjaXJjbGUgY3g9IjQ4IiBjeT0iMTYiIHI9IjUiIGZpbGw9IiMzZmI5NTAiLz48L3N2Zz4=">
<meta name="theme-color" content="#0b1220">
<style>
  :root { --bg:#0b1220; --card:#121a2b; --line:#233046; --text:#e6edf3; --muted:#8b949e; --accent:#3fb950; --blue:#58a6ff; }
  * { box-sizing:border-box; }
  body { margin:0; background:radial-gradient(1200px 600px at 50% -10%, #17233a 0%, var(--bg) 55%);
         color:var(--text); font:15px/1.7 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         min-height:100vh; }
  main { max-width:880px; margin:0 auto; padding:56px 22px 64px; }
  .head { text-align:center; margin-bottom:34px; }
  .badge { display:inline-block; padding:3px 10px; border:1px solid var(--line); border-radius:999px;
           color:var(--muted); font-size:12.5px; letter-spacing:.3px; }
  h1 { font-size:34px; letter-spacing:1px; margin:16px 0 6px; }
  h1 small { display:block; font-size:15px; letter-spacing:6px; color:var(--muted); font-weight:400; margin-top:8px; }
  .sub { color:var(--muted); margin:0 auto; max-width:640px; }
  .cmd { display:flex; gap:10px; align-items:stretch; margin:28px 0 34px; }
  .cmd pre { flex:1; min-width:0; margin:0; padding:13px 15px; background:#0d1524; border:1px solid var(--line);
             border-radius:10px; color:#c9d1d9; font:13px/1.6 ui-monospace,Consolas,Menlo,monospace;
             overflow:auto; white-space:pre; }
  .cmd button { flex:0 0 auto; padding:0 18px; border:1px solid var(--line); border-radius:10px;
                background:#182338; color:var(--text); font-size:13.5px; cursor:pointer; }
  .cmd button:hover { border-color:#3d5170; }
  h2 { font-size:13px; letter-spacing:2px; color:var(--muted); font-weight:600; margin:32px 0 12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:12px; }
  .card { display:block; padding:16px 18px; background:var(--card); border:1px solid var(--line);
          border-radius:12px; color:var(--text); text-decoration:none; transition:border-color .15s, transform .15s; }
  .card:hover { border-color:#3d5170; transform:translateY(-1px); }
  .card b { display:block; font-size:15px; margin-bottom:4px; }
  .card span { display:block; color:var(--muted); font-size:12.5px; word-break:break-all; }
  .card .tag { display:inline-block; margin-top:8px; padding:2px 8px; border-radius:6px;
               background:#16233a; color:var(--blue); font-size:11.5px; font-style:normal; }
  .prev { margin:28px 0 0; color:var(--muted); font-size:13px; text-align:center; }
  a { color:var(--blue); }
  .foot { margin-top:44px; padding-top:18px; border-top:1px solid var(--line); color:var(--muted);
          font-size:12.5px; text-align:center; line-height:2; }
  .foot a { color:var(--muted); }
  @media (max-width:520px) { h1 { font-size:27px; } .cmd { flex-direction:column; } .cmd button { padding:10px; } }
</style>
</head>
<body>
<main>
  <div class="head">
    <div class="badge">LuCI 套件 · v@@VER@@</div>
    <h1>MTUN-XD<small>墨 枢 云 境</small></h1>
    <p class="sub">面板 + 核心 + 配置工具，打成一个 LuCI 包。<br>装的时候现拉核心 / 面板，所以包只有几十 KB。</p>
  </div>

  <div class="cmd">
    <pre id="cmd">curl -fsSL ./install.sh -o /tmp/mtun-xd-install.sh &amp;&amp; sh /tmp/mtun-xd-install.sh</pre>
    <button id="copy" type="button">复制</button>
  </div>

  <h2>下载</h2>
  <div class="grid">
    <a class="card" href="./luci-app-mtun-xd-@@VER@@.apk">
      <b>OpenWrt 25.x</b>
      <span>luci-app-mtun-xd-@@VER@@.apk</span>
      <i class="tag">apk</i>
    </a>
    <a class="card" href="./luci-app-mtun-xd_@@VER@@_all.ipk">
      <b>OpenWrt 24.10 及以前</b>
      <span>luci-app-mtun-xd_@@VER@@_all.ipk</span>
      <i class="tag">opkg</i>
    </a>
  </div>

  <h2>配置工具（生成器）</h2>
  <div class="grid">
    <a class="card" href="./generator.sh">
      <b>generator.sh</b>
      <span>一行部署到路由器</span>
      <i class="tag">脚本</i>
    </a>
    <a class="card" href="./mihomo-deploy.zip">
      <b>mihomo-deploy.zip</b>
      <span>离线包（Windows / macOS）</span>
      <i class="tag">zip</i>
    </a>
    <a class="card" href="./mihomo-deploy.tar.gz">
      <b>mihomo-deploy.tar.gz</b>
      <span>离线包（Linux / 路由器）</span>
      <i class="tag">tar.gz</i>
    </a>
  </div>

  @@PREV@@

  <div class="foot">
    装完：路由器界面 → 服务 → <b>墨枢云境</b><br>
    <a href="./latest.txt">latest.txt</a> · <a href="./SHA256SUMS">SHA256SUMS</a> ·
    <a href="https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD">GitHub</a>
  </div>
</main>

<script>
  // 安装命令按当前访问的域名现拼：页面里不写死托管域名，换域名或反代时同样可用。
  var origin = location.origin; if (origin.slice(-1) === '/') origin = origin.slice(0, -1);
  var cmd = 'curl -fsSL ' + origin + '/install.sh -o /tmp/mtun-xd-install.sh && sh /tmp/mtun-xd-install.sh';
  document.getElementById('cmd').textContent = cmd;
  document.getElementById('copy').addEventListener('click', function () {
    var b = this, t = b.textContent;
    var done = function () { b.textContent = '已复制'; setTimeout(function () { b.textContent = t; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(cmd).then(done, done);
    } else {
      var r = document.createRange(); r.selectNodeContents(document.getElementById('cmd'));
      var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      try { document.execCommand('copy'); } catch (e) {}
      done();
    }
  });
</script>
</body>
</html>
'''


def write_index(d):
    """首页的包链接跟着 VERSION 走 —— 手写的那种一版就过时。

    注意：dist/ 里留着上一版（回滚用），首页一并列出来 —— 出毛病时不用翻 GitHub 历史。
    """
    prev = previous_version(d)
    extra = ''
    if prev:
        extra = (
            '<p class="prev">上一版（回滚用）：'
            '<a href="./%s-%s.apk">%s apk</a> · '
            '<a href="./%s_%s_%s.ipk">%s ipk</a></p>'
            % (NAME, prev, prev, NAME, prev, ARCH, prev)
        )
    with open(os.path.join(d, 'index.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(INDEX_HTML.replace('@@VER@@', VERSION).replace('@@PREV@@', extra))


def publish_kit(src):
    """把 make-router-kit 产出的 kit 复制进 dist/，并重算索引与 SHA256SUMS。

    只认脚本产出的三件：mihomo-deploy.tar.gz / .zip / generator.sh。
    禁止手工 cp —— 发版纪律要求 dist/ 只能由 build.py 写入。
    """
    d = os.path.join(HERE, 'dist')
    os.makedirs(d, exist_ok=True)
    for name in ('mihomo-deploy.tar.gz', 'mihomo-deploy.zip', 'generator.sh'):
        p = os.path.join(src, name)
        if not os.path.isfile(p):
            raise SystemExit('✘ kit 产物缺失：%s' % p)
        shutil.copy2(p, os.path.join(d, name))
    write_index(d)
    write_sums(d)
    print('kit → %s（3 个文件，SHA256SUMS 已重算）' % d)


def publish_dist(made):
    """把「路由器 / 别人要从网上拿的那几样」拷进 dist/ —— 随仓库一起发布的静态目录。

    注意：CF 连的就是这个仓库，所以路由器从 CF 域名下载跟仓库公不公开无关；
    之所以不走 Release 附件 + raw.githubusercontent，是因为那些要求仓库公开。
    生成器的 kit 由 `build.py kit <make-router-kit 输出目录>` 复制进来。
    """
    d = os.path.join(HERE, 'dist')
    os.makedirs(d, exist_ok=True)
    # 文件名带版本号：**只留当前版本 + 上一版**（上一版是回滚用的，见 keep_pkgs）
    keep = keep_pkgs(os.listdir(d)) | set(os.path.basename(x) for x in made)
    for f in sorted(os.listdir(d)):
        if f.startswith(NAME) and f not in keep and (f.endswith('.apk') or f.endswith('.ipk')):
            os.remove(os.path.join(d, f))
            print('  drop old pkg: %s' % f)
    for p in made:
        shutil.copy2(p, os.path.join(d, os.path.basename(p)))
    shutil.copy2(os.path.join(HERE, 'install.sh'), os.path.join(d, 'install.sh'))
    # 让 install.sh 从 CF 上直接知道最新版本号（不用调 API，省配额）
    with open(os.path.join(d, 'latest.txt'), 'w', newline='\n') as f:
        f.write('v%s\n' % VERSION)
    write_index(d)
    write_sums(d)
    print('dist/ → %s（%d 个，CF 那份；改完记得提交）' % (d, len(os.listdir(d))))


def write_sums(d):
    """给 dist/ 里每个文件出一份 SHA256SUMS —— install.sh 下完包先对一遍再装。

    注意：**不含它自己**；按文件名排序，内容稳定（同一批产物每次生成都逐字一样）。
    管的是我们自己发出去的那几样 —— 上游核心 / 面板的哈希走 Release 里的 digest。
    """
    names = sorted(f for f in os.listdir(d)
                   if f != 'SHA256SUMS' and os.path.isfile(os.path.join(d, f)))
    with open(os.path.join(d, 'SHA256SUMS'), 'w', newline='\n') as out:
        for f in names:
            h = hashlib.sha256()
            with open(os.path.join(d, f), 'rb') as fp:
                for chunk in iter(lambda: fp.read(1 << 20), b''):
                    h.update(chunk)
            out.write('%s  %s\n' % (h.hexdigest(), f))


def same_version(fn):
    """文件名里是不是**当前 VERSION**（两种外壳的写法都认）。"""
    return ('_%s_' % VERSION) in fn or ('-%s.' % VERSION) in fn


def pkg_version(fn):
    """从包文件名里取出里面带的版本号；不是我们的包就返回 None。"""
    m = re.match(r'^%s[-_](.+?)(?:\.apk|_all\.ipk)$' % re.escape(NAME), fn)
    return m.group(1) if m else None


def ver_key(v):
    """'8.9.35' → (8, 9, 35)；遇到非数字（预发布之类）返回 None，别硬比。"""
    try:
        return tuple(int(x) for x in str(v).split('.'))
    except ValueError:
        return None


def keep_pkgs(names, current=None):
    """dist/ 里该留哪些包：**当前版本 + 上一版**（两种外壳都留）。

    注意：留上一版是为了新版本有毛病时还能装回去；再多留就是白占仓库（每个包都要进 git）。
    """
    cur = current or VERSION
    have = {}
    for fn in names:
        v = pkg_version(fn)
        if v:
            have.setdefault(v, []).append(fn)
    keep = set(have.get(cur, []))
    curk = ver_key(cur)
    # 注意：只认**比当前小**的版本当"上一版" —— dist 里若残留一个更新的版本，按 max 取
    # 会把真正的上一版删掉，而首页「上一版」链接按 `< 当前` 找 ⇒ 正好在要回滚时 404。
    older = [(ver_key(v), v) for v in have if v != cur]
    older = [(k, v) for k, v in older if k is not None and (curk is None or k < curk)]
    if older:
        keep.update(have[max(older)[1]])
    return keep


def previous_version(dirpath):
    """dist/ 里比当前版本小的那个最高版本（没有就返回空串）—— 首页「上一版」那行用。"""
    cur = ver_key(VERSION)
    vs = [(ver_key(pkg_version(fn)), pkg_version(fn)) for fn in os.listdir(dirpath)]
    vs = [(k, v) for k, v in vs if k is not None and cur is not None and k < cur]
    return max(vs)[1] if vs else ''


def tidy_pkgs(dirpath, keep):
    """把目录里**别的版本**的套件包删掉（当前版本两种格式都留）。

    注意：只认 `luci-app-mtun-xd*` 的 .apk/.ipk，别的文件一律不碰（dist/ 里还有
    install.sh / latest.txt / 生成器那份 mihomo-deploy.zip）；不能只按这次造了哪种格式来留 ——
    `python build.py ipk` 时 dist/ 里同版本的 apk 也是要发的，删了另一边的用户就 404。
    """
    if not os.path.isdir(dirpath):
        return
    for f in sorted(os.listdir(dirpath)):
        if not f.startswith(NAME) or f in keep:
            continue
        if not (f.endswith('.apk') or f.endswith('.ipk')):
            continue
        if same_version(f):
            continue
        try:
            os.remove(os.path.join(dirpath, f))
            print('  清旧包 %s: %s' % (os.path.basename(dirpath), f))
        except OSError:
            pass


def existing_pkgs():
    """仓库根上已经躺着的两种包（CI 下载下来的 artifact / 本机刚造完）。缺一种就失败。"""
    check_mirrors()
    made = []
    for n in ('%s-%s.apk' % (NAME, VERSION), '%s_%s_%s.ipk' % (NAME, VERSION, ARCH)):
        p = os.path.join(HERE, n)
        if not os.path.isfile(p):
            raise SystemExit('✘ 缺 %s' % n)
        made.append(p)
    return made


def publish_existing():
    """包已经在仓库根：dist + SHA256SUMS + Release（本地一条龙用，CI 拆成 dist / release 两步）。

    注意：**不重新造包**；两种包缺一种就失败（半份发布比不发更糟）。
    """
    made = existing_pkgs()
    publish_dist(made)
    if not publish_release(made):
        raise SystemExit('✘ publish: Release 没发出去')


def main():
    # 注意：Windows 控制台默认 GBK（cp936），本脚本满屏 ✔ / ⚠️ ⇒ 走到某条带表情的分支时
    # Python 会抛 UnicodeEncodeError 判死整次构建；只放宽编码错误的处理，不改控制台编码。
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(errors='replace')
        except Exception:
            pass
    which = sys.argv[1] if len(sys.argv) > 1 else 'both'
    # 注意：先验参数再动文件 —— 参数打错时不该去碰仓库里的东西
    if which not in ('ipk', 'apk', 'both', 'publish', 'dist', 'kit', 'release', 'version', 'sums'):
        print('用法: python build.py [ipk|apk|both|publish|dist|kit <dir>|release|version|sums]')
        sys.exit(2)
    if which == 'version':
        print(VERSION)
        return
    if which == 'sums':
        write_sums(os.path.join(HERE, 'dist'))
        return
    if which == 'publish':
        publish_existing()
        return
    if which == 'dist':
        publish_dist(existing_pkgs())
        return
    if which == 'kit':
        if len(sys.argv) < 3:
            print('用法: python build.py kit <make-router-kit 输出目录>')
            sys.exit(2)
        publish_kit(sys.argv[2])
        return
    if which == 'release':
        if not publish_release(existing_pkgs()):
            sys.exit(1)
        return

    check_mirrors()
    files = collect()
    print('进包文件：%d 个' % len(files))
    made = []
    if which in ('ipk', 'both'):
        p = build_ipk(files)
        made.append(p)
        print('ipk → %s (%.2f MB)' % (p, os.path.getsize(p) / 1024 / 1024))
    if which in ('apk', 'both'):
        p = build_apk(files)
        made.append(p)
        print('apk → %s (%.2f MB)' % (p, os.path.getsize(p) / 1024 / 1024))
    keep = set(os.path.basename(p) for p in made)
    # 注意：桌面 / 仓库根目录只留这一版，不然发一版堆一版（dist/ 那边 publish_dist 自己会清）。
    for d in (DESKTOP, HERE):
        tidy_pkgs(d, keep)
    if os.path.isdir(DESKTOP):
        for p in made:
            dst = os.path.join(DESKTOP, os.path.basename(p))
            with open(p, 'rb') as a, open(dst, 'wb') as b:
                b.write(a.read())
            print('桌面副本 → %s' % dst)
    else:
        print('⚠️ 桌面目录不存在（%s）—— 跳过桌面副本' % DESKTOP)
    # 注意：只有**两种都造出来**才动 dist/ 和 Release —— 单造一种时清掉另一种，对应的用户 404。
    if which == 'both':
        publish_dist(made)
        publish_release(made)
    else:
        print('（只造了 %s：dist/ 和 Release 没动 —— 免得另一种格式的包 404）' % which)


if __name__ == '__main__':
    main()
