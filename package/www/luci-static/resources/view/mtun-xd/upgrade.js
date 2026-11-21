'use strict';
'require view';
'require fs';
'require mtun-xd.common as C';

/*
 * MTUN-XD → 维护中心：面板 / 核心 / 插件三个升级放一页，各一个按钮、共用一个输出框，
 * 跑起来三个按钮一起禁用；布局跟另外两页一套，颜色全走 common.js 里的 --mh-*。
 * 注意：「套件更新」= 套件包本体 + 配置工具捆绑升，活全在 /usr/sbin/mtun-xd；
 * 故意不同步等 —— 升级要好几十秒、rpcd 的 file exec 有超时，所以脚本自己后台写日志、
 * 页面每 1.5 秒来拉一次。
 */

// 颜色全走变量、只跟路由器主题（Argon 的 data-argon-mode）：换明暗只给 <html> 换个
// data-mh-theme、不重建页面（输出框里的日志不会丢）；变量表在 common.js 的 themeApply() 里。
var P = {
	bg: 'var(--mh-bg)', card: 'var(--mh-card)', border: 'var(--mh-border)',
	text: 'var(--mh-text)', muted: 'var(--mh-muted)', accent: 'var(--mh-accent)',
	preBg: 'var(--mh-pre-bg)', preFg: 'var(--mh-pre-fg)'
};

// 字体栈跟配置工具页里那个生成器同一套（LuCI/Argon 落到"雅黑"、生成器走 Segoe UI，
// 不统一就同一页两个字形）；字号也照生成器那套级差来：标题 15.5/700、说明 12.5、小提示 12、按钮 13。
var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", sans-serif';

// 内层那一列 —— 尺寸跟配置工具页里的生成器 `.app` 一模一样
var INNER = 'width:100%; max-width:1120px; margin:0 auto; padding:0 16px; ' +
	'font-family:' + FONT + '; ' +
	'display:flex; flex-direction:column; flex:1 1 auto; min-height:0;';

var ROW = 'padding:15px 18px; background:' + P.card + '; ' +
	'border-bottom:1px solid ' + P.border + ';';
// 三行合成一张圆角卡（跟生成器那边一摞卡片的观感一致），别做成一整条通栏
var CARDBOX = 'border:1px solid ' + P.border + '; border-radius:10px; overflow:hidden;';
// 按钮：高 30px、跟行底对齐
// 按钮只允许这一套尺寸（升级 / 启停共用）：30 高、radius 6、13/600、白字、语义色底
var BTN = 'display:inline-flex; align-items:center; justify-content:center; ' +
	'height:30px; min-width:92px; background:' + P.accent + '; color:#fff; border:0; padding:0 12px; ' +
	'border-radius:6px; font-size:13px; font-weight:600; font-family:inherit; line-height:1; cursor:pointer;';

var CARDS = [
	{
		kind: 'core', title: '核心升级', btn: '更新核心',
		desc: 'Mihomo',
	},
	{
		kind: 'ui', title: '面板升级', btn: '更新面板',
		desc: 'MetaCubeXD'
	},
	{
		kind: 'console', title: '套件升级', btn: '更新套件',
		desc: 'MTUN-XD 套件'
	}
];

// 运行日志：统一格式 [HH:MM:SS] 消息（页面和升级流程共用）
//
// 颜色口径跟状态胶囊一致：运行中=绿、已停止=灰、启动中=蓝、异常=红、更新中=橙。
// 判定顺序：先看行首符号（✔ 成功 / ⚠ 提醒），再判红（失败关键字最具体），
// 然后灰 / 蓝 / 橙，最后才是泛绿的「运行中 / 完成」。顺序即优先级，改规则时一起改这段。
var LINE_COLORS = [
	// 行首符号优先：✔ 是「办成了」，哪怕内容是「已停止」也走绿
	{ re: /^✔/, c: 'var(--mh-ok)' },
	// ⚠️ 开头的提示行优先按「提醒」处理（橙），不因为句子里有「失败」就被染红
	{ re: /^⚠/, c: 'var(--mh-warn)' },
	{ re: /(FAIL|✘|失败|异常|超时|错误|没起来|不支持)/, c: 'var(--mh-err)' },
	{ re: /(已停止|停止服务)/, c: 'var(--mh-idle)' },
	{ re: /(启动中|停止中)/, c: 'var(--mh-busy)' },
	{ re: /(更新中|升级中|获取新版本|下载|正在|→|▶)/, c: 'var(--mh-warn)' },
	{ re: /(✔|运行中|完成|已就位|已是|已装)/, c: 'var(--mh-ok)' }
];
// 把 rpcd / ubus 的错误压成一行可读原因，用于「✘ …（原因）」；空则返回空串。
function errText(e) {
	var s = (e && (e.message || e.msg)) ? String(e.message || e.msg) : (e == null ? '' : String(e));
	s = s.replace(/\s+/g, ' ').trim();
	return s ? '（' + s.slice(0, 160) + '）' : '';
}
// 解析 `mtun-xd status` 的一行值：没装 / 装了但版本读不出 / 正常（带运行态）。
// 三种情况分开，内核不再只看「未运行」两个字（N-12 的根因就在这）。
function parseSt(raw) {
	raw = String(raw || '');
	var miss = /没装|未装/.test(raw);
	var nover = !miss && /读不出/.test(raw);
	var ver = raw.replace(/（运行中）|（未运行）|（配置工具没装）/g, '').trim();
	var alive = /（运行中）/.test(raw) ? true : (/（未运行）/.test(raw) ? false : null);
	return { miss: miss, nover: nover, ver: ver, alive: alive };
}
function lineColor(line) {
	for (var i = 0; i < LINE_COLORS.length; i++) {
		if (LINE_COLORS[i].re.test(line)) return LINE_COLORS[i].c;
	}
	return '';
}
// 一行拆成几段：时间戳前缀 / 字段名 / 值 —— **只给值上色**，前缀保持正文色。
//   [12:36:00] 状态：运行中   →   "[12:36:00] 状态：" 原色 + "运行中" 绿
//   ✔ 核心：已是1.19.34       →   整行绿（没有时间戳前缀）
function nearBottom(el) {
	return el.scrollHeight - el.scrollTop - el.clientHeight <= 24;
}
function hasSelectionIn(el) {
	var s = window.getSelection();
	if (!s || !s.rangeCount || s.isCollapsed) return false;
	var n = s.anchorNode;
	return !!(n && el.contains(n.nodeType === 1 ? n : n.parentNode));
}
function renderOut(out, text) {
	// ⚠️ 用户正在选中文字或已经上翻看历史时，不重建 DOM、不拽回底部；
	//    把最新内容暂存，等回到底部再渲染（否则流式日志每 1.5 秒清一次选区）。
	if (hasSelectionIn(out) || !nearBottom(out)) { out._pending = text; return; }
	out._pending = null;
	out.style.color = '';
	out.textContent = '';
	var lines = String(text || '').split('\n');
	while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
	var addText = function (t, color) {
		if (!t) return;
		if (!color) { out.appendChild(document.createTextNode(t)); return; }
		var sp = document.createElement('span');
		sp.style.color = color;
		sp.textContent = t;
		out.appendChild(sp);
	};
	for (var i = 0; i < lines.length; i++) {
		var ln = lines[i];
		var m = /^(\[\d{2}:\d{2}:\d{2}\]\s*)(.*)$/.exec(ln);
		var prefix = m ? m[1] : '';
		var rest = m ? m[2] : ln;
		addText(prefix, P.muted);
		var st = /^(状态：)(.*)$/.exec(rest);
		if (st) {
			addText(st[1], '');
			addText(st[2], lineColor(st[2]));
		} else {
			addText(rest, lineColor(rest));
		}
		if (i < lines.length - 1) out.appendChild(document.createTextNode('\n'));
	}
	if (nearBottom(out)) out.scrollTop = out.scrollHeight;
}
function logLine(out, msg) {
	if (!out) return;
	var d = new Date();
	var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
	var ts = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
	var t = (out._raw || '').replace(/\s+$/, '');
	var next = t + (t ? '\n' : '') + '[' + ts + '] ' + msg;
	out._raw = next;
	renderOut(out, next);
}

return view.extend({
	render: function () {
		var self = this;
		// 主题：跟面板同一份选择（默认跟随系统），换主题只改变量、不重建页面
		C.themeApply();

		var statusEls = {};
		var btns = [];
		var pills = {};

		// 状态颜色统一口径（跟 common.js 的 --mh-* 变量一致）：
		// 运行中=绿、已停止=灰、启动中=蓝、异常=红、更新中=橙
		var PILL_DEF = {
			running:  { fg: 'var(--mh-ok)',   bg: 'var(--mh-ok-bg)',   dot: 'var(--mh-ok)',   text: '运行中' },
			stopped:  { fg: 'var(--mh-idle)', bg: 'var(--mh-idle-bg)', dot: 'var(--mh-idle)', text: '已停止' },
			starting: { fg: 'var(--mh-busy)', bg: 'var(--mh-busy-bg)', dot: 'var(--mh-busy)', text: '启动中…' },
			stopping: { fg: 'var(--mh-busy)', bg: 'var(--mh-busy-bg)', dot: 'var(--mh-busy)', text: '停止中…' },
			updating: { fg: 'var(--mh-warn)', bg: 'var(--mh-warn-bg)', dot: 'var(--mh-warn)', text: '更新中…' },
			unknown:  { fg: 'var(--mh-warn)', bg: 'var(--mh-warn-bg)', dot: 'var(--mh-warn)', text: '版本读不出' },
			error:    { fg: 'var(--mh-err)',  bg: 'var(--mh-err-bg)',  dot: 'var(--mh-err)',  text: '异常' }
		};
		var makePill = function () {
			var dot = E('span', { style: 'width:8px; height:8px; border-radius:50%; display:inline-block;' });
			var txt = E('span', {}, '…');
			return [E('span', {
				style: 'display:inline-flex; align-items:center; gap:8px; padding:6px 14px; ' +
					'border-radius:999px; font-size:13.5px; font-weight:600; white-space:nowrap;'
			}, [dot, txt]), dot, txt];
		};
		var setPill = function (kind, state, label) {
			var p = pills[kind]; if (!p) return;
			var d = PILL_DEF[state] || PILL_DEF.stopped;
			p.box.style.color = d.fg;
			p.box.style.background = d.bg;
			p.dot.style.background = d.dot;
			p.txt.textContent = label || d.text;
		};
		var pillOf = function (kind) {
			var box = makePill();
			pills[kind] = { box: box[0], dot: box[1], txt: box[2] };
			return box[0];
		};
		// ⚠️ refreshStatus 是 view 的方法、不在 render 闭包里 —— 状态胶囊必须挂 self
		self._setPill = setPill;

		var out = E('pre', {
			id: 'up-out',
			style: 'margin:0; padding:12px 10px; background:' + P.preBg + '; color:' + P.preFg + '; ' +
				'border:1px solid ' + P.border + '; border-radius:10px; ' +
				'font-family:ui-monospace, Consolas, Menlo, monospace; ' +
				'font-size:14px; line-height:1.65; white-space:pre-wrap; ' +
				'overflow-wrap:anywhere; word-break:normal; ' +
				'flex:1 1 auto; min-height:132px; overflow:auto;'
		}, '尚无操作记录');
		out.style.color = P.muted;
		out.addEventListener('scroll', function () {
			if (nearBottom(out) && out._pending) {
				var t = out._pending;
				out._pending = null;
				renderOut(out, t);
			}
		});

		var rows = CARDS.map(function (card, i) {
			statusEls[card.kind] = E('div', {
				style: 'margin-top:4px; font-size:12.5px; color:' + P.muted + ';'
			}, '读当前版本…');
			var pillBox = pillOf(card.kind);
			setPill(card.kind, 'stopped', '读取中…');

			var btn = E('button', {
				class: 'mh-btn',
				style: BTN,
				click: function () { self.start(card, btns, out, statusEls); }
			}, card.btn);
			btns.push(btn);

			// 最后一行不要下边框（那由外面那张卡的边框来收）
			// 三列：左信息 / 中间状态胶囊 / 右按钮 —— 胶囊在两列 1fr 的正中间
			return E('div', {
				class: 'mh-row',
				style: ROW + 'display:grid; grid-template-columns:1fr auto 1fr; align-items:center;' +
					(i === CARDS.length - 1 ? 'border-bottom:0;' : '')
			}, [
				E('div', { style: 'min-width:0; color:' + P.text + ';' }, [
					E('div', { style: 'font-size:16px; font-weight:700; margin-bottom:2px;' }, card.title),
					E('div', { style: 'line-height:1.6; font-size:13px;' }, card.desc),
					statusEls[card.kind]
				]),
				E('div', { style: 'justify-self:center; padding:0 22px;' }, [pillBox]),
				E('div', { style: 'justify-self:end;' }, btn)
			]);
		});

		self._upBtns = btns;   // ⚠️ 在这里记，不能等 start()：首次升级前 coreAct 拿不到 []
		this.refreshStatus(statusEls);

		var inner = E('div', {
			style: 'flex:1 1 auto; min-height:0; display:flex; flex-direction:column; margin:0 -16px -16px -16px; ' +
				'background:' + P.bg + ';'
		}, [
			// 内层这一列居中限宽 —— 别让内容铺到屏幕两边（跟配置工具那页一个观感）
			E('div', { style: INNER }, [
				E('div', { style: 'padding-top:16px;' }, [
					E('div', { style: CARDBOX }, rows)
				]),
				E('div', { class: 'mh-loghead', style: 'padding:14px 0 8px; color:' + P.muted + '; ' +
					'font-size:12.5px; font-weight:600;' }, [
					E('span', {}, '运行日志'),
					E('span', { class: 'mh-hint' }, '（升级核心会断网几秒，失败自动回滚）'),
					E('span', {})
				]),
				E('div', { style: 'flex:1 1 auto; min-height:0; display:flex; padding-bottom:16px;' }, [out])
			])
		]);
		// ── 内核启动/停止（顶部居中一行；结果写进下面「输出」框）────
		var coreLog = function (msg) { logLine(out, msg); };
		var coreSet = function (state) {
			var running = state === 'running';
			btnStart.disabled = running;
			btnStop.disabled = !running;
		};
		var coreRefresh = function () {
			fs.exec(C.SCRIPT, ['core-state']).then(function (r) {
				var st = ((r && r.stdout) || '').trim();
				coreSet(st);
			}).catch(function () {
				// ⚠️ N-16：升级结束 / 服务正在重启时 core-state 可能查不到。
				//    升级期间两个按钮是被禁用的，保持原状会把它们永久焊死（只能刷新页面）。
				//    这里放开两边让用户自己试，胶囊标异常。
				btnStart.disabled = false;
				btnStop.disabled = false;
				setPill('core', 'error', '异常');
			});
		};
		// ⚠️ poll() 是 view 的方法、不在 render 闭包里 —— 里面要用 coreRefresh 必须挂 self
		self._coreRefresh = coreRefresh;
		var coreAct = function (cmd) {
			// ⚠️ 启停是独立动作：先清掉上一轮升级的日志与 ⚠️ 前缀，
			//    否则上次的风险提示会挂到这次「停止服务」头上。
			out.textContent = '';
			out._raw = '';
			btnStart.disabled = true;
			btnStop.disabled = true;
			setBusy(self._upBtns || [], true);   // 启停期间也别让升级按钮能点（互斥）
			setPill('core', cmd === 'core-start' ? 'starting' : 'stopping',
				cmd === 'core-start' ? '启动中…' : '停止中…');
			coreLog(cmd === 'core-start' ? '启动服务 …' : '停止服务 …');
			var waitRun = function (n) {
				fs.exec(C.SCRIPT, ['core-state']).then(function (r) {
					var st = ((r && r.stdout) || '').trim();
					if (st === 'running') {
						coreSet(st);
						setPill('core', 'running', '运行中');
						coreLog('✔ 服务已启动');
						setBusy(self._upBtns || [], false);
						self.refreshStatus(statusEls); return;
					}
					// 注意：开机 5 分钟内启动会先等 40 秒（init 脚本里的开机延迟）→ 等满 90 秒再判超时
					if (n > 90) {
						coreSet(st); setPill('core', 'error', '异常');
						coreLog('✘ 启动超时（90 秒）');
						coreLog('  日志：tail -50 ' + C.LOG);
						setBusy(self._upBtns || [], false); return;
					}
					setTimeout(function () { waitRun(n + 1); }, 1000);
				}).catch(function () {
					setPill('core', 'error', '异常');
					coreLog('✘ 查询状态失败');
					setBusy(self._upBtns || [], false);
					if (self._coreRefresh) self._coreRefresh();
				});
			};
			fs.exec(C.SCRIPT, [cmd]).then(function (r) {
				var st = ((r && r.stdout) || '').trim();
				if (cmd === 'core-start') { waitRun(0); return; }
				coreSet(st);
				setPill('core', st === 'stopped' ? 'stopped' : 'running', st === 'stopped' ? '已停止' : '运行中');
				coreLog(st === 'stopped' ? '✔ 服务已停止' : ('✔ 当前状态：' + st));
				setBusy(self._upBtns || [], false);   // ⚠️ 停止这条分支也必须解锁
				self.refreshStatus(statusEls);
			}).catch(function (e) {
				// ⚠️ 把真实原因带出来：以前只写「看套件日志」，失败时根本不知道是超时、
				//    被锁、还是 rpcd 拒了 —— 排查全靠猜。
				setPill('core', 'error', '异常');
				coreLog('✘ 执行失败' + errText(e));
				coreLog('  日志：tail -50 ' + C.LOG);
				setBusy(self._upBtns || [], false);
				if (self._coreRefresh) self._coreRefresh();
			});
		};
		// 禁用态必须自己画：按钮的背景是内联样式，浏览器的 button[disabled] 默认灰会被盖住
		var MH_CSS = E('style', { id: 'mh-upgrade-css' }, '.mh-btn[disabled]{background:var(--mh-idle)!important;' +
			'opacity:.55;cursor:default;box-shadow:none!important;}' +
			'.mh-loghead{display:grid;grid-template-columns:1fr auto 1fr;align-items:baseline;}' +
			'.mh-loghead .mh-hint{font-size:11.5px;font-weight:400;opacity:.85;text-align:center;}' +
			'@media (max-width:520px){.mh-loghead,.mh-row{grid-template-columns:1fr!important;row-gap:10px;}' +
			'.mh-loghead>span:empty{display:none;}' +
			'.mh-loghead .mh-hint{text-align:left;margin-top:4px;}' +
			'.mh-row > div{justify-self:start!important;padding-left:0!important;padding-right:0!important;}}');
		var coreBtn = function (label, bg, cmd) {
			return E('button', {
				type: 'button',
				class: 'mh-btn',
				style: 'height:30px; min-width:92px; padding:0 12px; border-radius:6px; border:0; color:#fff; ' +
					'background:' + bg + '; font-size:13px; font-weight:600; letter-spacing:.2px; cursor:pointer; ' +
					'box-shadow:0 1px 3px rgba(0,0,0,.12);',
				click: function () { coreAct(cmd); }
			}, label);
		};
		var btnStart = coreBtn('▶  启动服务', 'var(--mh-busy)', 'core-start');
		var btnStop = coreBtn('■  停止服务', 'var(--mh-err)', 'core-stop');
		// ⚠️ start() 是 view 的方法、不在 render 的闭包里 —— 按钮必须挂到 self 上，
		//    否则在 start 里直接写 btnStart 会抛 ReferenceError（点了没反应，按钮还灰着）。
		self._btnStart = btnStart;
		self._btnStop = btnStop;

		var corebar = E('div', {
			style: 'flex:0 0 auto; display:flex; justify-content:center; align-items:center; flex-wrap:wrap; gap:22px; padding:32px 0 4px;'
		}, [btnStart, btnStop]);
		coreRefresh();

		var root = E('div', {}, [MH_CSS, corebar, inner]);



		C.layout(root);
		return root;
	},

	// `mtun-xd status` 现在还会多一行「配置工具：」；这里只认内核 / 面板 / 控制台三行，
	// 其余行（配置工具、监听…）一律忽略，别把它们误当成某张卡片的状态。
	refreshStatus: function (els) {
		var self = this;
		var setP = function (kind, state, label) {
			if (self._setPill) self._setPill(kind, state, label);
		};
		return fs.exec(C.SCRIPT, ['status']).then(function (res) {
			var txt = ((res && res.stdout) || '').replace(/\s+$/, '');
			var map = { '内核': 'core', '面板': 'ui', '控制台': 'console' };
			txt.split('\n').forEach(function (line) {
				var m = /^(内核|面板|控制台)：\s*(.*)$/.exec(line);
				if (!m) return;
				var el = els[map[m[1]]];
				if (!el) return;
				// 版本行只写版本；状态由胶囊表达。三种情况先分开，再决定文案与颜色：
				//   没装 → 灰「未安装」；装了但版本读不出 → 橙「版本读不出」；正常 → 版本 + 运行态/安装态
				var st = parseSt(m[2]);
				if (st.miss) {
					el.textContent = '当前：未安装';
					setP(map[m[1]], 'stopped', '未安装');
				} else if (st.nover) {
					el.textContent = '当前：已安装（版本读不出）';
					setP(map[m[1]], 'unknown', '版本读不出');
				} else {
					el.textContent = '当前：' + st.ver;
					if (m[1] === '内核') {
						// alive=false / null 都按已停止处理（null = 输出里没有运行态标记）
						var live = st.alive === true;
						setP('core', live ? 'running' : 'stopped', live ? '运行中' : '已停止');
					} else {
						setP(map[m[1]], 'running', '已安装');
					}
				}
			});
		}).catch(function () {
			Object.keys(els).forEach(function (k) {
				els[k].textContent = '读取失败（看日志：tail -50 ' + C.LOG + '）';
				setP(k, 'error', '异常');
			});
		});
	},

	start: function (card, btns, out, statusEls) {
		var self = this;
		setBusy(btns, true);
		// ⚠️ 升级和启停互斥：升级跑着的时候点「停止服务」会让健康检查判失败、触发回滚
		if (self._btnStart) self._btnStart.disabled = true;
		if (self._btnStop) self._btnStop.disabled = true;
		self._upBtns = btns;
		// 输出框里**只放脚本自己那几行**（→ / ✔ / ✘），页面别再往里塞「【面板更新】启动中…」
		// 这种自己的话（两套文体混在一起最难看）；"跑起来了"由下面那行状态文字表示。
		out.textContent = '';
		out._raw = '';
		self._setPill(card.kind, 'updating', '更新中…');

		fs.exec(C.SCRIPT, [card.kind, '--bg']).then(function () {
			return self.poll(btns, out, statusEls, 0, card.kind);
		}).catch(function (e) {
			// 注意：rpcd 有可能先超时（它要等管道 EOF 才算命令结束），但后台任务其实已经在跑了
			return new Promise(function (r) { setTimeout(r, 1500); }).then(function () {
				var why = function () {
					return '✘ 启动失败' + errText(e) + '（看日志：tail -50 ' + C.LOG + '）';
				};
				return fs.read(C.LOG).then(function (txt) {
					if (txt && txt.length) {
						out._raw = String(txt).replace(/\s+$/, '');
						renderOut(out, out._raw);
						return self.poll(btns, out, statusEls, 0, card.kind);
					}
					out._raw = why();
					renderOut(out, out._raw);
					self._setPill(card.kind, 'error', '异常');
					statusEls[card.kind].textContent = '读取失败（看日志）';
					setBusy(btns, false);
					if (self._coreRefresh) self._coreRefresh();
				}, function () {
					out._raw = why();
					renderOut(out, out._raw);
					self._setPill(card.kind, 'error', '异常');
					statusEls[card.kind].textContent = '读取失败（看日志）';
					setBusy(btns, false);
					if (self._coreRefresh) self._coreRefresh();
				});
			});
		});
	},

	poll: function (btns, out, statusEls, n, kind) {
		var self = this;

		fs.read(C.LOG).then(function (txt) {
			txt = String(txt || '').replace(/\s+$/, '');   // 去掉 CLI 收尾的连续换行
			if (txt && txt !== out._raw) {
				out._raw = txt;
				renderOut(out, txt);
			}
		}).catch(function () { /* 还没写出来，正常 */ });

		return fs.read(C.DONE).then(function (code) {
			var ok = String(code).trim() === '0';
			// 注意：这里**不加「✔ 完成。」**—— 脚本最后一行已经是结果行（✔ 面板：1.274.0 …），
			// 再来一句就是把同一件事说两遍；跑完的信号放进状态行，失败才说话。
			setBusy(btns, false);
			if (self._coreRefresh) self._coreRefresh();   // 升级期间锁掉的启停按钮，按真实状态恢复
			return self.refreshStatus(statusEls).then(function () {
				if (!ok) self._setPill(kind, 'error', '升级失败');
			});
		}).catch(function () {
			if (n > 600) {
				out._raw = (out._raw || '') + '\n（超时，日志：tail -50 ' + C.LOG + '）';
				renderOut(out, out._raw);
				setBusy(btns, false);
				self._setPill(kind, 'error', '超时');
				if (self._coreRefresh) self._coreRefresh();
				return;
			}
			return new Promise(function (r) {
				setTimeout(function () { r(self.poll(btns, out, statusEls, n + 1, kind)); }, 1500);
			});
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});

// 按钮是自己刷的样式，禁用态手工做
function setBusy(btns, busy) {
	btns.forEach(function (b) {
		b.disabled = busy;
		b.style.opacity = busy ? '.55' : '1';
		b.style.cursor = busy ? 'default' : 'pointer';
	});
}
