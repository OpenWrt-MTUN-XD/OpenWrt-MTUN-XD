'use strict';
'require fs';
'require baseclass';

/*
 * Mihomo 管理套件 —— 三个页面（控制面板 / 配置工具 / 维护中心）的公共件。
 * 注意：顶上标签用主题原生的 `#tabmenu`（menu.d 正好是「一个父节点挂三个 view 子节点」），
 * 别自绘、也别藏起来；另外 LuCI 的 require 只认类，必须 baseclass.extend（否则整页白屏）。
 */

// 注意：脚本名 / 日志名要跟 /usr/sbin/mtun-xd 里的常量一致
var SCRIPT = '/usr/sbin/mtun-xd';
// 「自己好」正在跑 —— 同一页里两条触发路径（探活失败 + 没挂上）别并发跑两遍 ensure。
var healing = false;

return baseclass.extend({
	SCRIPT: SCRIPT,
	LOG: '/tmp/mtun-xd.log',
	DONE: '/tmp/mtun-xd.done',

	// 把这一页撑满到「页脚上方」：页脚（Powered by LuCI …）就始终落在底边。
	// 主题那层还有自己的 margin/padding，撑完要按超出量缩回来（不然多 16px 撑出滚动条）。
	fill: function (node) {
		// 版本标记只放版本号（包名那截太长、还跟左上角菜单同名，纯噪音），问不到就整枚不显示；
		// 位置按 #tabmenu 自己算 —— 注意：不能给父容器用 top:50%，Argon 里那个父容器比标签条高得多。
		var BADGE_ID = 'mtun-xd-ver';
		var badge = null, badgeAbs = null;   // 全页**只有一枚** badge（abs=贴在标签条上 / 不然贴内容顶上）
		var makeBadge = function (abs) {
			// fill() 每次调用都是新闭包 —— 上一枚还在（同一个 document 里重渲染）就先摘掉，别出现两个同 id 的
			var prev = document.getElementById(BADGE_ID);
			if (prev && prev.parentNode) prev.parentNode.removeChild(prev);
			var b = E('div', {
				id: BADGE_ID,
				style: (abs ? 'position:absolute; right:12px; z-index:1; ' : 'text-align:right; padding:0 2px 8px; ') +
					'font-size:12.5px; color:var(--mh-muted); white-space:nowrap; pointer-events:none; ' +
					'font-family:ui-monospace, Consolas, Menlo, monospace;'
			}, '');
			fs.exec(SCRIPT, ['version']).then(function (res) {
				if (!b.parentNode) return;   // 已被新的徽标替换掉
				var v = ((res && res.stdout) || '').replace(/\s+$/, '');
				if (v) b.textContent = 'v' + v;
				else b.style.display = 'none';
			}).catch(function () { if (b.parentNode) b.style.display = 'none'; });
			return b;
		};
		// 注意：只能有**一枚**。fill() 跑时节点还没插进文档，#tabmenu 往往还不存在 ⇒ 先退回"贴内容顶上"；
		// 等 apply() 再跑时标签条又出现了，再建一枚就会重复 —— 所以两种形态互斥、共用同一个变量。
		var placeBadge = function () {
			var tab = document.getElementById('tabmenu');
			var host = tab && tab.parentNode;
			if (!host) {
				// 这页没有标签条（理论上遇不到）：退回贴内容顶上
				if (!badge || badgeAbs) {
					if (badge) badge.remove();
					badge = makeBadge(false);
					badgeAbs = false;
					node.insertBefore(badge, node.firstChild);
				}
				return false;
			}
			if (window.getComputedStyle(host).position === 'static') host.style.position = 'relative';
			if (!badge || !badgeAbs) {
				if (badge) badge.remove();
				badge = makeBadge(true);
				badgeAbs = true;
				host.appendChild(badge);
			}
			var hr = host.getBoundingClientRect(), tr = tab.getBoundingClientRect();
			badge.style.top = Math.round(tr.top - hr.top + tr.height / 2) + 'px';
			badge.style.transform = 'translateY(-50%)';
			return true;
		};
		placeBadge();

		var apply = function () {
			var f = document.querySelector('#maincontent footer');
			var fh = f ? f.getBoundingClientRect().height : 0;
			// 注意：夹到 0 —— 页面滚下去之后 top 是负的，不夹的话每 resize 一次高度就多长一截。
			var top = Math.max(0, node.getBoundingClientRect().top);
			var h = Math.max(200, window.innerHeight - top - fh);
			// 注意：根节点可能带 zoom（?scale= 临时缩）—— 上面量到的 h 是视觉像素，直接写进
			// minHeight 会被 zoom 再缩一次（高度不足、页脚上浮），要换算回 zoom 内部的长度。
			var z = 1;
			try { z = parseFloat(window.getComputedStyle(node).zoom) || 1; } catch (e) { /* 老浏览器没有 zoom */ }
			node.style.minHeight = Math.round(h / z) + 'px';
			var sc = document.querySelector('.main');
			var over = sc ? (sc.scrollHeight - sc.clientHeight) : 0;
			if (over > 0) node.style.minHeight = Math.round((h - over) / z) + 'px';
			placeBadge();
		};
		node.style.display = 'flex';
		node.style.flexDirection = 'column';
		apply();
		if (this._mhFillRaf && window.cancelAnimationFrame) window.cancelAnimationFrame(this._mhFillRaf);
		this._mhFillRaf = window.requestAnimationFrame ? window.requestAnimationFrame(apply) : 0;
		if (this._mhFillTimer) clearTimeout(this._mhFillTimer);
		this._mhFillTimer = setTimeout(apply, 300);
		// 同一个页面重渲染时会再进一次 fill —— 老的监听先摘掉，别越攒越多
		// 用 window 级单例：LuCI 进页是新实例，挂在 this 上的监听摘不掉，切三次页就攒三个
		if (window.__mhFillApply) window.removeEventListener('resize', window.__mhFillApply);
		window.__mhFillApply = apply;
		window.addEventListener('resize', apply);
	},

	// 面板地址 / 端口 / secret / 外部前缀：交给套件脚本的 `panelinfo` 返回 JSON。
	// 以前直接读 /etc/mihomo/config.yaml —— 那会把节点密码、订阅地址一整套暴露给 ACL，
	// 现在只取这四个字段（用户 2026-11-17 采纳审查建议）。
	readPanel: function () {
		var fallback = { host: '127.0.0.1', port: '9090', secret: '', ui: '' };
		return fs.exec(SCRIPT, ['panelinfo']).then(function (res) {
			var out = String((res && res.stdout) || '').trim();
			if (!out) return fallback;
			try {
				var o = JSON.parse(out);
				return {
					host: o.host || fallback.host,
					port: o.port || fallback.port,
					secret: o.secret || '',
					ui: o.ui || ''
				};
			} catch (e) { return fallback; }
		}).catch(function () { return fallback; });
	},

	// 面板静态站在哪个 URL 前缀下 —— 就是 config.yaml 里的 external-ui（默认 ui）。
	// 注意：套件不碰人家已有的配置，那台可能写的是别的名字（dashboard…），页面里别写死 /ui/。
	uiPath: function (panel) {
		var u = String((panel && panel.ui) || 'ui').replace(/^\/+|\/+$/g, '');
		return u ? '/' + u + '/' : '/ui/';
	},

	// 内核的口子从**当前页面的 origin** 能不能打到：不信 `expose status` 的瞬时返回值（会偶发 false、
	// 误报「绑回环」），`/version` 匿名 401 / 认证 200 就足以证明同源反代已经通。
	exposeOn: function () {
		if (!window.fetch || !window.location || !window.location.origin)
			return Promise.resolve(false);
		return window.fetch(window.location.origin + '/version', {
			cache: 'no-store',
			credentials: 'same-origin'
		}).then(function (res) {
			// 只认 200 / 401：401 是内核要求认证（说明反代通了），403 可能是中间层拦的，不能算通
			return res.status === 200 || res.status === 401;
		}).catch(function () { return false; });
	},

	// 「自己好」：没挂到 uhttpd 上（pkg 模式装的 / 手动 apk add / 上一版漏的）或挂着但地址已不通
	// （「载入配置文件」换过监听）⇒ 打开这页就后台补一次；注意 `expose off` 过的 ensure 认标记，别硬来。
	selfHeal: function () {
		// 防打转：刚补过（20 秒内）就别再来，免得"补完还是打不开"时整页死循环；
		// 但不能做成"这个会话只补一次" —— 来回「载入配置文件」会反复撞上，那样得关标签页重开。
		try {
			var t = parseInt(sessionStorage.getItem('mhs-expose-healed') || '0', 10);
			if (t && (Date.now() - t) < 20000) return;
		} catch (e) {}
		// 同一页里探活失败和「没挂上」两条路都会调 selfHeal（间隔 2.5 秒），不挡一下会并发跑两遍
		// ensure（= 两次 uhttpd 重启）。
		if (healing) return;
		healing = true;
		var self = this;
		// 每一轮一个序号：新的接管后，旧的 setaTimeout/step 循环看到序号变了就自己退出，
		// 不会出现"30 秒兜底解锁了、旧循环还在跑"导致两遍 ensure。
		var seq = this._mhHealSeq = (this._mhHealSeq || 0) + 1;
		setTimeout(function () { if (seq === self._mhHealSeq) healing = false; }, 30000);
		var tries = 0;
		// 现在就记一笔（不是成功后）：要么 20 秒内不再触发，要么彻底不触发；唯独不能"失败了也每帧重来"。
		try { sessionStorage.setItem('mhs-expose-healed', String(Date.now())); } catch (e) {}
		var done = function () {
			// 挂好之后这一页本该走同源那条 —— **整页重来一次**最干净。
			// 注意：不能就地换 iframe 的 src，这一趟"探活失败"可能已经把它从文档里摘掉了。
			window.location.reload();
		};
		// 判"修好没有"看的是 **ensure 的结论**（它自己会真去探内核），不是 `expose status` ——
		// status 只看 uhttpd 里挂着没有，内核死了也照样回 on ⇒ 会无限重载页面。
		var step = function () {
			if (seq !== self._mhHealSeq) return;   // 已被新一轮接管
			if (tries >= 5) { healing = false; return; }
			tries += 1;
			fs.exec(SCRIPT, ['expose', 'ensure']).then(function (res) {
				if (((res && res.stdout) || '').trim() === 'on') { done(); return; }
				setTimeout(step, 2000);
			}, function () {
				// uhttpd 重启会把回包切断 —— 隔一会儿再问一次
				setTimeout(step, 2000);
			});
		};
		step();
	},

	// 监听地址是不是"只有本机能访问"（127.0.0.1 / ::1 / localhost）
	loopbackOnly: function (host) {
		return /^(127\.|::1$|\[::1\]$|localhost$)/i.test(String(host || ''));
	},

	// ── 嵌进来的 iframe 缩放（默认不缩，三个调用点都传 0）────────────────────
	// 留着这套是为了还能用 ?scale=0.9 临时缩：视口撑到 1/sc 再 transform:scale(sc)，视觉尺寸不变。

	// 从 ?scale= 取覆盖值；无效就 0（=不缩）
	scaleOf: function (def) {
		var m = window.location.search.match(/[?&]scale=([0-9.]+)/);
		var sc = m ? parseFloat(m[1]) : def;
		return (sc > 0.35 && sc < 1) ? sc : 0;
	},

	// frame = 要缩的 iframe，box = 包着它的定位容器
	scaleFrame: function (frame, box, baseSc) {
		var apply = function () {
			var sc = (window.innerWidth < 1000) ? 0 : baseSc;
			if (sc) {
				frame.style.position = 'absolute';
				frame.style.top = '0';
				frame.style.left = '0';
				frame.style.minHeight = '0';
				frame.style.width = 'calc(100% / ' + sc + ')';
				frame.style.height = 'calc(100% / ' + sc + ')';
				frame.style.transform = 'scale(' + sc + ')';
				frame.style.transformOrigin = '0 0';
				box.style.position = 'relative';
				box.style.overflow = 'hidden';
			} else {
				frame.style.position = '';
				frame.style.top = '';
				frame.style.left = '';
				frame.style.minHeight = '320px';
				frame.style.width = '100%';
				frame.style.height = '';
				frame.style.transform = '';
				frame.style.transformOrigin = '';
				box.style.position = '';
				box.style.overflow = '';
			}
		};
		apply();
		// 同一页重渲染会再进一次 —— 先摘掉上一轮的监听，否则每次进页都多一个（还抓着旧的 iframe）
		if (window.__mhScaleApply) window.removeEventListener('resize', window.__mhScaleApply);
		window.__mhScaleApply = apply;
		window.addEventListener('resize', apply);
	},

	// ── 主题：三页只跟路由器 ────────────────────────────────────────────────
	// Argon 把当前明暗写在 <html data-argon-mode>；没装 Argon 才退回系统的 prefers-color-scheme。
	themeNow: function () {
		var a = document.documentElement.getAttribute('data-argon-mode');
		if (a === 'light' || a === 'dark') return a;
		return (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
	},

	themeApply: function () {
		var self = this;
		if (!document.getElementById('mh-luci-theme')) {
			var st = document.createElement('style');
			st.id = 'mh-luci-theme';
			st.textContent =
				':root{--mh-bg:#14181f;--mh-card:#1b2029;--mh-border:#2b323d;--mh-text:#dde3ec;' +
				'--mh-muted:#8b96a7;--mh-accent:#4d94f0;--mh-pre-bg:#0f1217;--mh-pre-fg:#cfd6e0;' +
				'--mh-iframe-bg:#0d1014;}' +
				':root[data-mh-theme="light"]{--mh-bg:#f4f6f9;--mh-card:#ffffff;--mh-border:#e5eaf0;' +
				'--mh-text:#1f2937;--mh-muted:#6b7280;--mh-accent:#16a34a;--mh-pre-bg:#f7f8fa;' +
				'--mh-pre-fg:#24292f;--mh-iframe-bg:#ffffff;}';
			(document.head || document.documentElement).appendChild(st);
		}
		this._mhFrames = this._mhFrames || [];
		var repaint = function () {
			document.documentElement.setAttribute('data-mh-theme', self.themeNow());
			for (var i = 0; i < self._mhFrames.length; i++) self._mhFrames[i]();
		};
		repaint();
		if (this._mhThemeHooked) return;
		this._mhThemeHooked = true;
		// Argon 切明暗 = 改 <html data-argon-mode> ⇒ 盯着它，跟着变（不用刷新）
		var mo = new MutationObserver(repaint);
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-argon-mode'] });
		if (window.matchMedia) {
			var q = window.matchMedia('(prefers-color-scheme: dark)');
			var onq = function () { repaint(); };
			if (q.addEventListener) q.addEventListener('change', onq);
			else if (q.addListener) q.addListener(onq);
		}
	},

	// 子 iframe（配置工具里的生成器）跟着换 data-theme —— 生成器的浅色/深色就是这套
	frameTheme: function (frame) {
		if (!frame) return;
		var self = this;
		var put = function () {
			try {
				var d = frame.contentDocument;
				if (!d || !d.documentElement) return;
				var now = self.themeNow();
				d.documentElement.setAttribute('data-theme', now);
				// 注意：生成器底部那条「就绪」在它的 style.css 里用 --header（浅色下也是深蓝）；新 kit 已改成
				// 跟随主题，但老 kit 还在各台机器上跑（工具升级还会从 CF 拉回来）⇒ 这里补一刀，跟 kit 版本无关。
				var st = d.getElementById('mh-frame-theme');
				if (!st) {
					st = d.createElement('style');
					st.id = 'mh-frame-theme';
					(d.head || d.documentElement).appendChild(st);
				}
				st.textContent = now === 'light'
					? '[data-theme="light"] .statusbar{background:#eef2f7!important;color:#475569!important}' +
					  '[data-theme="light"] .status-right{color:#64748b!important}'
					: '';
			} catch (e) { /* 跨源就当没这回事 */ }
		};
		put();
		frame.addEventListener('load', put);
		// 一页只有一个 iframe —— 直接替换，别 push（重渲染时旧框已经扔了，
		// 留着只会在每次切主题时对它做无用功）
		this._mhFrames = [put];
	}
});
