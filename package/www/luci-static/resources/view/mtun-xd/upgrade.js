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

var ROW = 'display:flex; align-items:flex-end; padding:15px 18px; background:' + P.card + '; ' +
	'border-bottom:1px solid ' + P.border + ';';
// 三行合成一张圆角卡（跟生成器那边一摞卡片的观感一致），别做成一整条通栏
var CARDBOX = 'border:1px solid ' + P.border + '; border-radius:10px; overflow:hidden;';
// 按钮：高 30px、跟行底对齐
var BTN = 'display:inline-flex; align-items:center; justify-content:center; ' +
	'height:30px; background:' + P.accent + '; color:#fff; border:0; padding:0 12px; border-radius:5px; ' +
	'font-size:12px; font-family:inherit; line-height:1; cursor:pointer;';

var CARDS = [
	{
		kind: 'core', title: '核心升级', btn: '更新核心',
		desc: 'Mihomo'
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
function logLine(out, msg) {
	if (!out) return;
	var d = new Date();
	var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
	var ts = p2(d.getHours()) + ':' + p2(d.getMinutes()) + ':' + p2(d.getSeconds());
	var t = out.textContent || '';
	if (t.indexOf('点右边') >= 0) t = '';
	out.textContent = t + (t ? '\n' : '') + '[' + ts + '] ' + msg;
	out.scrollTop = out.scrollHeight;
}

return view.extend({
	render: function () {
		var self = this;
		// 主题：跟面板同一份选择（默认跟随系统），换主题只改变量、不重建页面
		C.themeApply();

		var statusEls = {};
		var btns = [];

		var out = E('pre', {
			id: 'up-out',
			style: 'margin:0; padding:14px 18px; background:' + P.preBg + '; color:' + P.preFg + '; ' +
				'border:1px solid ' + P.border + '; border-radius:10px; ' +
				'font-family:ui-monospace, Consolas, Menlo, monospace; ' +
				'font-size:15px; line-height:1.8; white-space:pre-wrap; word-break:break-all; ' +
				'flex:1 1 auto; min-height:120px; overflow:auto;'
		}, '');

		var rows = CARDS.map(function (card, i) {
			statusEls[card.kind] = E('div', {
				style: 'margin-top:6px; font-size:12.5px; color:' + P.muted + ';'
			}, '读当前版本…');

			var btn = E('button', {
				style: BTN,
				click: function () { self.start(card, btns, out, statusEls); }
			}, card.btn);
			btns.push(btn);

			// 最后一行不要下边框（那由外面那张卡的边框来收）
			return E('div', { style: ROW + (i === CARDS.length - 1 ? 'border-bottom:0;' : '') }, [
				E('div', { style: 'flex:1 1 auto; min-width:0; color:' + P.text + ';' }, [
					E('div', { style: 'font-size:15.5px; font-weight:700; margin-bottom:3px;' }, card.title),
					E('div', { style: 'line-height:1.65; font-size:12.5px;' }, card.desc),
					statusEls[card.kind]
				]),
				E('div', { style: 'flex:0 0 auto; margin-left:14px;' }, btn)
			]);
		});

		this.refreshStatus(statusEls);

		// 默认不缩放（三页统一 100%）。这页不是 iframe，真要缩只能用 zoom
		// （transform 会让高度/滚动对不上）；baseSc=0 时下面 applyScale 走不缩那条分支。
		var baseSc = C.scaleOf(0);      // 0 = 不缩

		var inner = E('div', {
			style: 'flex:1 1 auto; min-height:0; display:flex; flex-direction:column; ' +
				'background:' + P.bg + ';'
		}, [
			// 内层这一列居中限宽 —— 别让内容铺到屏幕两边（跟配置工具那页一个观感）
			E('div', { style: INNER }, [
				E('div', { style: 'padding-top:16px;' }, [
					E('div', { style: CARDBOX }, rows)
				]),
				E('div', { style: 'padding:14px 2px 8px; color:' + P.muted + '; font-size:12.5px; font-weight:600;' }, '运行日志'),
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
				coreLog('状态：' + (st === 'running' ? '运行中' : '已停止'));
			}).catch(function () { btnStart.disabled = false; btnStop.disabled = false; });
		};
		var coreAct = function (cmd) {
			btnStart.disabled = true;
			btnStop.disabled = true;
			coreLog(cmd === 'core-start' ? '启动服务 …' : '停止服务 …');
			var waitRun = function (n) {
				fs.exec(C.SCRIPT, ['core-state']).then(function (r) {
					var st = ((r && r.stdout) || '').trim();
					if (st === 'running') { coreSet(st); coreLog('OK 服务已启动'); self.refreshStatus(statusEls); return; }
					// 注意：开机 5 分钟内启动会先等 40 秒（init 脚本里的开机延迟）→ 等满 90 秒再判超时
					if (n > 90) { coreSet(st); coreLog('FAIL 启动超时（90 秒）'); return; }
					setTimeout(function () { waitRun(n + 1); }, 1000);
				}).catch(function () { coreLog('FAIL 查询状态失败'); coreRefresh(); });
			};
			fs.exec(C.SCRIPT, [cmd]).then(function (r) {
				var st = ((r && r.stdout) || '').trim();
				if (cmd === 'core-start') { waitRun(0); return; }
				coreSet(st);
				coreLog(st === 'stopped' ? 'OK 服务已停止' : ('OK 当前状态：' + st));
				self.refreshStatus(statusEls);
			}).catch(function () { coreLog('FAIL 执行失败（看套件日志）'); coreRefresh(); });
		};
		var coreBtn = function (label, cls, cmd) {
			return E('button', {
				type: 'button',
				class: 'cbi-button ' + cls,
				style: 'height:32px; padding:0 18px; border-radius:8px; font-size:13.5px; font-weight:500; letter-spacing:.3px;',
				click: function () { coreAct(cmd); }
			}, label);
		};
		var btnStart = coreBtn('启动服务', 'cbi-button-apply', 'core-start');
		var btnStop = coreBtn('停止服务', 'cbi-button-reset', 'core-stop');

		// ── 80 端口转发（对应 uci mtun-xd.main.expose）──
		// 状态一律现问脚本（expose status），不在页面里另存一份，免得和 uci / 标记文件不一致。
		var exposeStatus = E('span', {
			style: 'font-size:12.5px; color:' + P.muted + ';'
		}, '读状态…');
		// 文案不当状态机：on/off 单独记，按钮只负责显示
		var exposeOn = false;
		var exposeSet = function (st) {
			exposeOn = (st === 'on');
			btnExpose.textContent = exposeOn ? '关闭 80 转发' : '开启 80 转发';
			btnExpose.disabled = false;
			exposeStatus.textContent = exposeOn ? '80 端口：已挂载' : '80 端口：未挂载';
		};
		var exposeRefresh = function () {
			fs.exec(C.SCRIPT, ['expose', 'status']).then(function (r) {
				var st = (((r || {}).stdout) || '').trim();
				if (st === 'on' || st === 'off') { exposeSet(st); return; }
				// 读不出明确状态时别猜：锁住按钮，避免下一次操作方向反掉
				btnExpose.disabled = true;
				exposeStatus.textContent = '80 端口：状态未知';
			}).catch(function () {
				btnExpose.disabled = true;
				exposeStatus.textContent = '80 端口：读不到状态';
			});
		};
		var btnExpose = E('button', {
			type: 'button',
			class: 'cbi-button',
			style: 'height:32px; padding:0 18px; border-radius:8px; font-size:13.5px;',
			disabled: true,
			click: function () {
				var want = exposeOn ? 'off' : 'on';
				btnExpose.disabled = true;
				exposeStatus.textContent = want === 'on' ? '正在挂载 80 端口 …' : '正在卸载 80 端口 …';
				// 中性措辞：on/off 会重启 uhttpd，RPC 回包可能被切断 —— 成败交给随后的状态刷新说话
				coreLog('已下发 80 端口' + (want === 'on' ? '挂载' : '卸载') + '，正在核对状态 …');
				fs.exec(C.SCRIPT, ['expose', want]).then(function () {
					exposeRefresh();
				}).catch(function () {
					coreLog('⚠️ 80 端口命令回包异常（可能只是 uhttpd 重启），正在核对状态 …');
					exposeRefresh();
				});
			}
		}, '读取…');
		exposeRefresh();

		var corebar = E('div', {
			style: 'flex:0 0 auto; display:flex; justify-content:center; align-items:center; flex-wrap:wrap; gap:22px; padding:12px 0 4px;'
		}, [btnStart, btnStop, btnExpose, exposeStatus]);
		coreRefresh();

		var root = E('div', {}, [corebar, inner]);

		// 注意：缩放要跟着窗口宽度实时变（只在 render 里算一次，转屏后就一直是小字）；满幅的
		// 负 margin 是视觉像素，zoom 会再缩它一次，要按 1/sc 放大，否则四周留一条 2px 的缝。
		var applyScale = function () {
			var sc = (window.innerWidth < 1000) ? 0 : baseSc;
			root.style.zoom = sc ? String(sc) : '';
			var m = sc ? (-16 / sc) : -16;
			inner.style.margin = '0 ' + m + 'px ' + m + 'px ' + m + 'px';
		};
		applyScale();
		// LuCI 每次进页都是新实例，this._mhUpApply 摘不掉上一个实例的监听 —— 用 window 级单例
		if (window.__mhUpApply) window.removeEventListener('resize', window.__mhUpApply);
		window.__mhUpApply = applyScale;
		window.addEventListener('resize', applyScale);

		// Argon 容器：#tabmenu / footer —— 一条 CSS 搞定，不用逐个 set style
		(function () {
			var st = document.getElementById('mh-layout-css');
			if (!st) {
				st = document.createElement('style');
				st.id = 'mh-layout-css';
				document.head.appendChild(st);
			}
			st.textContent = 'body[data-page^="admin-services-mtun-xd"] #tabmenu{margin-top:-7px} ' +
				'body[data-page^="admin-services-mtun-xd"] footer{margin-top:-17px} ' +
				'body[data-page^="admin-services-mtun-xd"] #maincontent .container{padding:0}';
				// 内容区的 16px padding 由我们接管，视图里就不用再写 -16px 负边距
				// 选择器用 body[data-page] 限定：切到别的页面时这段样式自动失效（Argon 每页都会写 data-page）
		})();


		root.style.marginTop = '-3px';
		C.fill(root);
		return root;
	},

	// `mtun-xd status` 现在还会多一行「配置工具：」；这里只认内核 / 面板 / 控制台三行，
	// 其余行（配置工具、监听…）一律忽略，别把它们误当成某张卡片的状态。
	refreshStatus: function (els) {
		return fs.exec(C.SCRIPT, ['status']).then(function (res) {
			var txt = ((res && res.stdout) || '').replace(/\s+$/, '');
			var map = { '内核': 'core', '面板': 'ui', '控制台': 'console' };
			txt.split('\n').forEach(function (line) {
				var m = /^(内核|面板|控制台)：\s*(.*)$/.exec(line);
				if (!m) return;
				var el = els[map[m[1]]];
				if (!el) return;
				// 状态文案全部由脚本给（内核带运行态，面板/控制台不再补后缀）
				el.textContent = '当前：' + (m[2]);
			});
		}).catch(function (e) {
			Object.keys(els).forEach(function (k) {
				els[k].textContent = '读不出版本：' + ((e && e.message) ? e.message : e);
			});
		});
	},

	start: function (card, btns, out, statusEls) {
		var self = this;
		if (card.kind === 'core') {
			logLine(out, '更新核心：过程中代理会断几秒，失败自动回滚');
		}

		setBusy(btns, true);
		// 输出框里**只放脚本自己那几行**（→ / ✔ / ✘），页面别再往里塞「【面板更新】启动中…」
		// 这种自己的话（两套文体混在一起最难看）；"跑起来了"由下面那行状态文字表示。
		out.textContent = '';
		statusEls[card.kind].textContent = '升级中…';

		fs.exec(C.SCRIPT, [card.kind, '--bg']).then(function () {
			return self.poll(btns, out, statusEls, 0, card.kind);
		}).catch(function (e) {
			// 注意：rpcd 有可能先超时（它要等管道 EOF 才算命令结束），但后台任务其实已经在跑了
			return new Promise(function (r) { setTimeout(r, 1500); }).then(function () {
				return fs.read(C.LOG).then(function (txt) {
					if (txt && txt.length) {
						out.textContent = txt;
						return self.poll(btns, out, statusEls, 0, card.kind);
					}
					out.textContent = '✘ 启动失败：' + ((e && e.message) ? e.message : e) + '\n';
					statusEls[card.kind].textContent = '✘ 没起来（看输出）';
					setBusy(btns, false);
				}, function () {
					out.textContent = '✘ 启动失败：' + ((e && e.message) ? e.message : e) + '\n';
					statusEls[card.kind].textContent = '✘ 没起来（看输出）';
					setBusy(btns, false);
				});
			});
		});
	},

	poll: function (btns, out, statusEls, n, kind) {
		var self = this;

		fs.read(C.LOG).then(function (txt) {
			if (txt && txt !== out.textContent) {
				out.textContent = txt;
				out.scrollTop = out.scrollHeight;
			}
		}).catch(function () { /* 还没写出来，正常 */ });

		return fs.read(C.DONE).then(function (code) {
			var ok = String(code).trim() === '0';
			// 注意：这里**不加「✔ 完成。」**—— 脚本最后一行已经是结果行（✔ 面板：1.274.0 …），
			// 再来一句就是把同一件事说两遍；跑完的信号放进状态行，失败才说话。
			out.scrollTop = out.scrollHeight;
			setBusy(btns, false);
			return self.refreshStatus(statusEls).then(function () {
				if (!ok && statusEls[kind]) {
					statusEls[kind].textContent = '✘ 升级失败（原因见上面的输出）';
				}
			});
		}).catch(function () {
			if (n > 600) {
				out.textContent += '\n（等太久了，不看了。完整日志在路由器 ' + C.LOG + '）\n';
				setBusy(btns, false);
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
