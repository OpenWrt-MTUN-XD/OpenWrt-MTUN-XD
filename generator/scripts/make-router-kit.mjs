/**
 * 出一个「上路由器」的部署包。用法：bun scripts/make-router-kit.mjs [输出目录]
 *
 * 默认输出到桌面的 mihomo-deploy/：里面只有一个平铺的 config/（app/ 那一层被拍掉、index.html 里
 * 的 app/ 前缀去掉），整个丢进 /etc/mihomo/ui/ 就完事 —— index.html（入口）/ *.js / core/ /
 * vendor/ / style.css / mihomo-apply（写盘 CGI）/ btn.js（面板左下角绿点）。
 *
 * 注意：页面是公开的 —— mihomo 把 external-ui 当静态文件发、没有登录层。删 index.html 不能让目录
 * 404（Go 的 http.FileServer 改吐目录列表），搬出去由 CGI 发能真 404 但入口落到 80 而这类机器只有
 * 9090 通。所以门放在「写」那一层：没登录就没有「载入配置文件」按钮，写盘接口认 mihomo 的 secret。
 * 注意：官方面板一个文件都不改，生成器只是作为 /ui/config/ 挂在面板底下；包里不再有任何静态
 * token（apply.json 把密钥放在公开静态目录里，那是个安全洞）。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const DEPLOY = join(ROOT, 'deploy');
const OUT = resolve(process.argv[2] || join(homedir(), 'Desktop', 'mihomo-deploy'));

/**
 * ⚠️ 这个脚本会 `rm -rf` 输出目录 —— 传错参数就可能是仓库根 / 桌面 / 盘符根。
 * 只允许「名字叫 mihomo-deploy 且不在关键路径上」的目录；真要用别的名字加 --force。
 */
function guardOut(dir) {
  const forced = process.argv.includes('--force');
  const name = dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '';
  // 关键路径：加 --force 也不放行（手滑一次就是清盘 / 清仓库）
  const fatal =
    dir === ROOT ||
    dir === resolve(ROOT, '..') ||
    dir === resolve(homedir()) ||
    dir === resolve('/') ||
    /^[A-Za-z]:[\\/]?$/.test(dir) ||
    dir.length <= 3;
  if (fatal) {
    console.error(`✘ 拒绝清空 ${dir}：这是系统 / 仓库路径，--force 也不放行`);
    process.exit(1);
  }
  // 只有「名字不合规」这一条能用 --force 放行
  if (name !== 'mihomo-deploy' && !forced) {
    console.error(`✘ 拒绝清空 ${dir}`);
    console.error('  输出目录必须叫 mihomo-deploy；确实是它、只是换了名字，加 --force。');
    process.exit(1);
  }
}

// 参数一错就别先跑 build（build.mjs 每次都会 rm -rf dist 重建）
guardOut(OUT);
/**
 * KIT_NO_PUBLISH=1：只生成本地包，**不上传 genkit、也不动 dist**。
 * 预览（把 kit 推给路由器看效果）必须用它 —— 否则 dist 会被这次生成覆盖，
 * 而 GitHub 上的 genkit 又已经换了新包，两边摘要对不上，套件的校验就会报错
 * （2026-11-18 就是这么踩的）。
 */
const NO_PUBLISH = String(process.env.KIT_NO_PUBLISH || '') === '1';

/** 路由器上的 shell 不认 CRLF，写过去的一律转成 LF。 */
const lf = (s) => String(s).replace(/\r\n/g, '\n');

/**
 * 清空一个目录再重建。
 * ⚠️ Windows 上只要有人开着这个文件夹（资源管理器最常见），目录本身被占住删不掉（EBUSY），
 * 但里面的文件能删 —— 删不掉就退而求其次只清空内容，照样能重打。
 */
function resetDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    if (existsSync(dir)) for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

// ── 一个极小的 ZIP 打包器 ──────────────────────────────────────
// 为什么自己写：项目零依赖（工具链只有 bun），而 Windows 和 Cloudflare 的构建机上都不保证有
// `zip` 命令。只用 Node 自带的 zlib，不引任何包。
// 时间戳写死 → 产出是确定性的：内容没改，zip 字节就一模一样，不会在版本库里瞎抖。
const DOS_TIME = 0;                                        // 00:00:00
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1;      // 2020-01-01
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** 递归收集文件（名字排序，保证确定性）。名字一律用 /，中文靠 UTF-8 标志位。 */
function walk(dir, base) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (lstatSync(full).isSymbolicLink()) {
      // 符号链接一律拒绝：跟着链接走会把仓库外的内容打进包，而且没有任何提示
      throw new Error(`包里不允许符号链接：${rel}（把它换成真实文件/目录）`);
    }
    if (statSync(full).isDirectory()) {
      out.push({ name: `${rel}/`, data: Buffer.alloc(0), mode: 0o40755, dir: true });
      out.push(...walk(full, rel));
    } else {
      out.push({ name: rel, data: readFileSync(full) });
    }
  }
  return out;
}

/** entries 里的 mode 不传就按扩展名猜（ZIP 里存的是 Unix 权限位）。 */
function makeZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = deflateRawSync(e.data, { level: 9 });
    const store = comp.length >= e.data.length;              // 压不动就原样存
    const body = store ? e.data : comp;
    const method = store ? 0 : 8;
    const crc = crc32(e.data);
    // 名字是拼音/中文的一律当普通文件，除非显式给了 mode
    // ⚠️ CGI 得带上执行位 —— 少了的话 uhttpd 会直接给 403，写盘就永远失败
    const mode = e.mode || (/\.sh$/.test(e.name) || /mihomo-apply$/.test(e.name) ? 0o100755 : 0o100644);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);            // 需要 2.0
    lh.writeUInt16LE(0x0800, 6);        // 文件名是 UTF-8（中文要靠这一位）
    lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBuf, body);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(0x031E, 4);        // 由 Unix 系统打的包（外部属性里是 Unix 权限）
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt16LE(DOS_TIME, 12);
    ch.writeUInt16LE(DOS_DATE, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(e.data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE((((mode << 16) | (e.dir ? 0x10 : 0)) >>> 0), 38);   // 高 16 位 Unix 权限；低 16 位 DOS 属性（目录要 0x10）
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, eocd]);
}

// ⚠️ 包里不放任何静态钥匙：现生成 token、写进 apply.json、再塞进 mihomo-apply 等于把钥匙和门
//    放在同一个不用登录就能进的地方。写盘认证走 mihomo 自己的 secret。

// ① 构建生成器
execFileSync(process.execPath, [join(ROOT, 'scripts', 'build.mjs')], { stdio: 'inherit' });

/**
 * tar.gz 版的同一份包。
 *
 * ⚠️ 为什么非要有它：不少路由器（iStoreOS / Kwrt 的 busybox）没有 unzip，而 tar 一定有；
 * 安装脚本在没 unzip 时改下这份，用 `tar -xzf` 解。
 * 时间戳 / uid / gid 全写死 0，gzip 的 mtime 也是 0 —— 内容没变字节就不变；名字全在 100
 * 字节以内（config/ 下那层），不用 ustar 的 prefix 字段。
 */
function tarOctal(n, len) {
  const s = n.toString(8);
  return '0'.repeat(Math.max(0, len - 1 - s.length)) + s + '\0';
}

function makeTarGz(entries) {
  const parts = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = !!e.dir;
    const data = isDir ? Buffer.alloc(0) : e.data;
    const mode = e.mode || (isDir ? 0o40755 : (/\.sh$/.test(e.name) || /mihomo-apply$/.test(e.name) ? 0o100755 : 0o100644));

    const h = Buffer.alloc(512);
    name.copy(h, 0, 0, Math.min(name.length, 100));
    h.write(tarOctal(mode, 8), 100);
    h.write(tarOctal(0, 8), 108);              // uid
    h.write(tarOctal(0, 8), 116);              // gid
    h.write(tarOctal(data.length, 12), 124);
    h.write(tarOctal(0, 12), 136);             // mtime
    h.write('        ', 148);                  // chksum 先用 8 个空格算
    h.write(isDir ? '5' : '0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    h.write('root', 265);
    h.write('root', 297);
    h.write(tarOctal(0, 8), 329);              // devmajor
    h.write(tarOctal(0, 8), 337);              // devminor

    let sum = 0;
    for (let i = 0; i < 512; i++) sum += h[i];
    h.write(tarOctal(sum, 7) + ' ', 148);

    parts.push(h);
    if (!isDir) {
      parts.push(data);
      const pad = (512 - (data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    }
  }
  parts.push(Buffer.alloc(1024));              // 两个全零块 = 结束
  return gzipSync(Buffer.concat(parts), { level: 9 });
}

// ② 摊开
const GEN = join(OUT, 'config');
resetDir(OUT);
mkdirSync(GEN, { recursive: true });
cpSync(DIST, GEN, { recursive: true });
for (const extra of ['README.md', 'LICENSE']) rmSync(join(GEN, extra), { force: true });

// ②′ 拍平：把 app/ 里的东西提到 config/ 根下（就一层目录），index.html 里 href="app/xxx" /
//     src="app/xxx" 的前缀跟着去掉。app/ 里的 JS 互相没有引用（全是 index.html 按顺序加载，
//     也没有 fetch/import 指向 app/），所以全仓库只有 index.html 这一处要改。
//     ⚠️ 只动 href/src 属性，别碰到正文里提到「app/embed.js」的注释。
const APP = join(GEN, 'app');
for (const name of readdirSync(APP)) renameSync(join(APP, name), join(GEN, name));
rmSync(APP, { recursive: true, force: true });

// ②″ 入口保持 index.html，资源改回相对路径。
//     所以：入口还叫 index.html，资源用相对路径（拍平只去掉 app/ 前缀）。
//
// ②‴ 顺给每个 js/css 挂上内容版本号（`?v=<内容指纹前 8 位>`）。
//     ⚠️ 为什么非做不可：mihomo 发静态文件只给 `Last-Modified`、没有 Cache-Control 也没有 ETag，
//     浏览器按「启发式」自己算新鲜度（约 = 文件年龄的 10%），改完东西打开还是旧的、得手动 Ctrl+F5。
//     内容一变 URL 就变，浏览器不可能再给旧的；版本号按内容算，内容没变就是同一个 URL（照样命中缓存）。
let genHtml = lf(readFileSync(join(GEN, 'index.html'), 'utf8'))
  .replace(/((?:href|src)=")app\//g, '$1')
  .replace(/((?:href|src)=")([^":?]+\.(?:js|css))"/g, function (m, pre, file) {
    const p = join(GEN, file);
    if (!existsSync(p)) return m;
    return pre + file + '?v=' + createHash('md5').update(readFileSync(p)).digest('hex').slice(0, 8) + '"';
  });
writeFileSync(join(GEN, 'index.html'), genHtml);

// ③ 写盘 CGI，直接摆在 config/ 根下（拍平后没有 app/ 那一层）。
//    ⚠️ 它不认任何 token —— 认证走 mihomo 自己的 secret，原样拷过去就行。
//    （写盘接口的地址和「监听地址」都由生成器从它自己的 URL 推出来，换 IP / 网络 / 浏览器都不会填错。）
writeFileSync(join(GEN, 'mihomo-apply'), lf(readFileSync(join(DEPLOY, 'mihomo-apply'), 'utf8')));
try { chmodSync(join(GEN, 'mihomo-apply'), 0o755); } catch { /* Windows 上无所谓 */ }

// ③′ 「取信」脚本已撤（信箱那条不稳，见 deploy/generator.sh 那段）；kit 里不再带 mihomo-pull，
//     装的时候反过来把老机器上残留的那一套清掉。

// ④ 面板左下角那个「配置生成器」跳转按钮的本体。generator.sh 会在面板 config.js 末尾挂一行
//    <script src="./config/btn.js"> 引进来 —— 按钮代码跟着生成器包一起更新，不用动 config.js。
writeFileSync(join(GEN, 'btn.js'), lf(readFileSync(join(DEPLOY, 'btn.js'), 'utf8')));

// ⑤ 部署说明.txt 不放 —— 形态是 config/ 里干干净净只有生成器那些文件。
//    （怎么装见 deploy/generator.sh 的注释，路由器上跑它就行。）

// ⑤′ 自检：本地这份包必须是完整的。缺东西宁可在这里炸掉，也别让人拿着没写盘脚本的包去传，
//     最后卡在「载入配置文件 403」上找半天。
for (const rel of ['config/index.html', 'config/secret.js', 'config/mihomo-apply', 'config/btn.js', 'config/ui.js']) {
  if (!existsSync(join(OUT, rel))) throw new Error(`打包不完整，少了 ${rel} —— 重跑一次`);
}
// ⚠️ **这两样是「没登录就 404」的命根子**，缺一个整道门就白做：
//   · 入口必须是 index.html（mihomo 只认它当目录首页）
//   · 资源必须是相对路径（拍平后就在同目录）
if (!existsSync(join(GEN, 'index.html'))) throw new Error('config/index.html 不见了 —— 入口没了');
const appHtml = readFileSync(join(GEN, 'index.html'), 'utf8');
if (/(?:href|src)="app\//.test(appHtml)) throw new Error('index.html 里还有 app/ 前缀 —— 拍平那一步没生效');
// 不该再有指向 /cgi-bin/ 的资源（那是上一版「搬出去 + CGI 发」留下的，现在入口是静态的）
if (/(?:href|src)="\/cgi-bin\//.test(appHtml)) throw new Error('index.html 里的资源还挂在 /cgi-bin/ 上');

// ⑥ 网页版那份 zip —— 桌面这份原样打包。
//    ⚠️ 包里已经没有任何密钥（写盘认证走 mihomo 自己的 secret），所以不用挑文件排除、也不用
//    把 mihomo-apply 换成模板：谁下到它都只能得到一个「生成 YAML 的网页」。里面不放说明文件。
const ZIP_NAME = 'mihomo-deploy.zip';
// ⚠️ 同一份内容的 tar.gz：给**没有 unzip** 的路由器（busybox 的 tar 一定有）。
const TAR_NAME = 'mihomo-deploy.tar.gz';
const webEntries = walk(OUT, '');
const zipBuf = makeZip(webEntries);
const tarBuf = makeTarGz(webEntries);

// ⑤″ 自检二：手写的 ZIP/TAR 结构必须能解回来，条目数也得对得上。
//    （只查「文件在不在」拦不住打包器自己改坏 —— 目录条目漏了、名字截断了都看不出来）
{
  const eocdAt = zipBuf.length - 22;
  if (zipBuf.readUInt32LE(eocdAt) !== 0x06054b50) throw new Error('zip 末尾没有 EOCD，打包器坏了');
  const zipCount = zipBuf.readUInt16LE(eocdAt + 10);
  if (zipCount !== webEntries.length) throw new Error(`zip 条目数不对：${zipCount} != ${webEntries.length}`);

  const raw = gunzipSync(tarBuf);
  const heads = [];
  for (let off = 0; off + 512 <= raw.length; off += 512) {
    if (raw[off] === 0) break;                       // 全零块 = 结束
    const name = raw.subarray(off, off + 100).toString('utf8').replace(/\0+$/, '');
    if (name) heads.push(name);
    const size = parseInt(raw.subarray(off + 124, off + 136).toString('utf8').replace(/\0+$/, '').trim() || '0', 8);
    off += Math.ceil(size / 512) * 512;
  }
  if (heads.length !== webEntries.length) throw new Error(`tar 条目数不对：${heads.length} != ${webEntries.length}`);

  // ustar 头里名字只有 100 字节；超了会被静默截断，解包后文件名就是错的
  for (const e of webEntries) {
    if (Buffer.byteLength(e.name, 'utf8') > 100) throw new Error(`名字超过 ustar 100 字节：${e.name}`);
  }
}

// ⑦ 部署包只发两处：下面第 ⑧ 步的 GitHub 滚动 release（tag `genkit`），和套件仓库的 `dist/`。


// ⑧ 顺手发一份到独立仓库 MTUN-XD-genkit 的滚动 release（tag `genkit`）—— 套件的「工具升级」就是从这里
//    拉的（套件只认 GitHub，走它自己那套镜像）。
//    ⚠️ 必须是 prerelease：GitHub 的 `releases/latest` 只算正式版；做成正式版的话套件 install.sh
//    解析「最新版」会解析到它，然后去找 luci-app-mtun-xd-*.apk，那个 release 里根本没有。
//    ⚠️ 附件不能覆盖、只能删了重传；下载 URL 是稳的：releases/download/genkit/<名字>。
//    ⚠️ 失败只警告：网络 / 凭据不通不该拦着本地打包。
async function publishKit(files) {
  const repo = 'OpenWrt-MTUN-XD/genkit';
  const tag = 'genkit';
  // CI 里没有 GCM：优先用环境变量（GitHub Actions 的 GITHUB_TOKEN / GH_TOKEN），
  // 本机再回落到 git credential fill。
  let tok = (process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '').trim();
  if (!tok) {
    // ⚠️ 别用 shell 的 `timeout`：Windows 自带那个不认管道（Git Bash 也没有 GNU 版）⇒ 本机会
    //    永远走「没凭据」分支。用 execFileSync 自己的超时。
    try {
      const out = execFileSync('git', ['credential', 'fill'],
        { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', timeout: 60000 });
      const m = /^password=(.+)$/m.exec(out);
      tok = m ? m[1].trim() : '';
    } catch { /* 没凭据就按下面的错抛 */ }
  }
  if (!tok) throw new Error('拿不到 GitHub 凭据（环境变量 / git credential fill 都没有）');
  const api = (p, init = {}) => fetch('https://api.github.com/repos/' + repo + p, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json',
      'User-Agent': 'OpenWrt-MTUN-XD', ...(init.headers || {}),
    },
  });

  let rel = await api('/releases/tags/' + tag);
  if (rel.status === 404) {
    rel = await api('/releases', {
      method: 'POST',
      body: JSON.stringify({
        tag_name: tag, name: '生成器部署包（滚动）', prerelease: true, draft: false,
        body: '给 MTUN-XD 的「工具升级」用的：生成器的部署包 + 安装脚本，每次打包覆盖一次。\n'
          + '⚠️ 别当安装包使 —— 装套件请去正式版（`v*`）。',
      }),
    });
  }
  if (!rel.ok) throw new Error('release 拿不到 / 建不了：HTTP ' + rel.status);
  const id = (await rel.json()).id;

  for (const a of await (await api('/releases/' + id + '/assets?per_page=100')).json()) {
    if (files.some((f) => f.name === a.name)) {
      const del = await api('/releases/assets/' + a.id, { method: 'DELETE' });
      // 404 = 别人刚删掉，不算错；其余状态留着让下面上传时报 422，能看到真实原因
      if (!del.ok && del.status !== 404) console.log(`  ⚠️ 删旧资产 ${a.name} 失败：HTTP ${del.status}`);
    }
  }
  for (const f of files) {
    const up = await fetch('https://uploads.github.com/repos/' + repo + '/releases/' + id +
      '/assets?name=' + f.name, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + tok, 'Content-Type': 'application/octet-stream',
        'User-Agent': 'OpenWrt-MTUN-XD',
      },
      body: f.data,
    });
    if (!up.ok) throw new Error('传 ' + f.name + ' 失败：HTTP ' + up.status);
  }
  return 'https://github.com/' + repo + '/releases/download/' + tag + '/';
}


// 顺手把 kit 也丢进套件仓库的 dist/（Cloudflare 托管那份）：仓库转私有之后，路由器上的
// 「工具升级」从这儿拉。⚠️ 找不到那个目录就算了，两个仓库没放在一起时不该拦着打包。
const SUITE_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist');
if (NO_PUBLISH) {
  console.log('  KIT_NO_PUBLISH=1：不动 dist/（预览不改变发布产物）');
} else if (existsSync(SUITE_DIST)) {
  const kitFiles = [ZIP_NAME, TAR_NAME, 'generator.sh'];
  writeFileSync(join(SUITE_DIST, ZIP_NAME), zipBuf);
  writeFileSync(join(SUITE_DIST, TAR_NAME), tarBuf);
  // ⚠️ 必须过一遍 lf()：GitHub 那份（publishKit）已经是 LF，而这里原样 cp 的话，
  //    工作区一旦被洗成 CRLF，CF 托管那份就成了 `#!/bin/sh\r`（内核报 not found）。
  writeFileSync(join(SUITE_DIST, 'generator.sh'),
    lf(readFileSync(join(DEPLOY, 'generator.sh'), 'utf8')));
  // ⚠️ 这三样换了，SHA256SUMS 必须跟着改 —— 否则单独跑这个脚本时发出去的校验和是旧的，
  //    install.sh 会拒装。
  updateSums(SUITE_DIST, kitFiles);
  console.log(`  也放进套件仓库的 dist/（CF 托管那份）：${SUITE_DIST}`);
}

let KIT_URL = '';
if (NO_PUBLISH) {
  console.log('  KIT_NO_PUBLISH=1：跳过 genkit 发布（只生成本地包）');
} else try {
  KIT_URL = await publishKit([
    { name: ZIP_NAME, data: zipBuf },
    { name: TAR_NAME, data: tarBuf },
    { name: 'generator.sh', data: Buffer.from(lf(readFileSync(join(DEPLOY, 'generator.sh'), 'utf8'))) },
  ]);
} catch (e) {
  console.log(`  ⚠️ 没发上 GitHub（${e.message}）`);
  console.log(`     dist/ 已是新版、genkit 还是上一版 —— 重跑一次本脚本补齐（发布顺序故意的：先本地后远端）`);
}

function updateSums(dir, names) {
  const p = join(dir, 'SHA256SUMS');
  const nameOf = (ln) => ln.trim().split(/\s+/).slice(1).join(' ').replace(/^\*/, '');
  let lines = existsSync(p) ? readFileSync(p, 'utf8').split('\n').filter(Boolean) : [];
  for (const n of names) {
    const h = createHash('sha256').update(readFileSync(join(dir, n))).digest('hex');
    lines = lines.filter((ln) => nameOf(ln) !== n);
    lines.push(h + '  ' + n);
  }
  // 字节序排序：localeCompare 在不同机器/locale 下顺序可能不同，会让 SHA256SUMS 产生无意义 diff
  lines.sort((a, b) => { const x = nameOf(a), y = nameOf(b); return x < y ? -1 : x > y ? 1 : 0; });
  writeFileSync(p, lines.join('\n') + '\n');
}

console.log(`\n打包完成 → ${OUT}`);
console.log(`  里头就一个目录 config/（平铺）—— 整个丢进 /etc/mihomo/ui/`);
console.log(`  config/index.html     入口（页面本身是公开的，见文件头）`);
console.log(`  config/mihomo-apply   写盘 CGI（认 mihomo 的 secret）`);
console.log(`  ⚠️ 没登录就没有「载入配置文件」按钮；硬 POST 也是 403`);
console.log(`  发布到 GitHub     ${KIT_URL || (NO_PUBLISH ? '(已跳过 —— KIT_NO_PUBLISH=1)' : '(没发上 —— 见上面的警告)')}`);
console.log(`  套件 dist/ 那份   随仓库发布（GitHub Releases）`);
