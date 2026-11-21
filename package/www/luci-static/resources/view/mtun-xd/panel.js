'use strict';
'require view';
'require mtun-xd.common as C';

/*
 * MTUN-XD → 控制面板：内容区整个嵌面板页面、不往外跳，顶部标签用主题原生的（见 common.js）。
 * 注意：secret 不走面板的 config.js（/ui/ 是公开静态目录），由这页从 config.yaml 读出、
 * 用 iframe 的 `?secret=` 带进去，面板再把地址栏抹干净。
 */
return view.extend({
	render: function () {
		// 主题：只跟路由器（Argon 的明暗），本页自己不带开关
		C.themeApply();
		return Promise.all([C.readPanel(), C.exposeOn()]).then(function (r) {
			var panel = r[0], viaHttp = r[1];

			// 内核的口子挂到 uhttpd 上了（`mtun-xd expose on`）→ 走**同源**：没有跨域、没有
			// 混合内容问题，也不用管 9090 有没有露出去；没挂 → 还用老那条 (:端口)。
			var baseHttp = window.location.origin + C.uiPath(panel);
			var baseDirect = window.location.protocol + '//' + window.location.hostname + ':' + panel.port + C.uiPath(panel);
			var url = viaHttp ? baseHttp : baseDirect;     // 探活用（下面拼 url + 'index.html'）
			var qs = panel.secret ? '?secret=' + encodeURIComponent(panel.secret) : '';
			// 注意：这个一次性时间戳不是装饰 —— mihomo 只发 Last-Modified，浏览器会按启发式把
			// index.html（连带 `config.js?v=`）缓存住，面板侧的改动就看着没生效；别拿掉。
			var src = url + qs + (qs ? '&' : '?') + '_t=' + Date.now();
			// 提示里要显示的那个地址：0.0.0.0 / * / :: 是「全听」不是真地址 —— 显示它没意义，
			// 换成浏览器打的那个主机名。
			var showHost = (/^(0\.0\.0\.0|\*|\[::\]|::)$/.test(String(panel.host))
				? window.location.hostname : String(panel.host));
			// IPv6 字面量要加方括号：`::1:9090` 是错的，`[::1]:9090` 才对
			if (String(showHost).indexOf(':') !== -1 && String(showHost).charAt(0) !== '[') {
				showHost = '[' + showHost + ']';
			}
			var showAddr = showHost + ':' + String(panel.port);

			var frame = E('iframe', {
				src: src,
				style: 'display:block; width:100%; flex:1 1 auto; min-height:320px; border:0; background:var(--mh-iframe-bg);',
			});

			// 三种"打不开"要分开说清楚：config.yaml 里没写 external-ui（面板压根没被发出来，9090
			// 上只有 API）、内核绑在回环上（活着但浏览器够不着）、其它（才可能是内核没在跑）。
			var readErr = !!panel.failed;          // panelinfo 没跑成（超时 / 权限 / 正忙）
			var noUi = !readErr && !panel.ui;      // 真没写 external-ui 才算「未启用」
			var isLoop = C.loopbackOnly(panel.host);
			var hint = E('div', { style: 'display:none; padding:28px 32px; line-height:1.9;' }, readErr ? [
				E('h3', { style: 'margin:0 0 6px;' }, '读不到套件信息'),
				E('div', {}, ['执行 ', E('code', {}, '/usr/sbin/mtun-xd panelinfo'), ' 失败（超时 / 权限 / 内核正忙）—— 稍后刷新本页。']),
				E('div', { style: 'color:var(--mh-muted);' }, '连不上就 ', E('code', {}, '/usr/sbin/mtun-xd status'), ' 看状态。')
			] : noUi ? [
				E('h3', { style: 'margin:0 0 6px;' }, '面板未启用'),
				E('div', {}, ['config.yaml 里加一行 ', E('code', {}, 'external-ui: ui'), '，再重启内核。'])
			] : viaHttp ? [
				E('h3', { style: 'margin:0 0 6px;' }, '面板没应答'),
				E('div', {}, ['内核没跑，或面板目录缺失 —— 先跑 ', E('code', {}, '/usr/sbin/mtun-xd status'), ' 看一眼。']),
				E('div', { style: 'color:var(--mh-muted);' }, '目录没了就 ', E('code', {}, '/usr/sbin/mtun-xd ui'), ' 补装。')
			] : isLoop ? [
				E('h3', { style: 'margin:0 0 6px;' }, '内核只监听本机回环'),
			E('div', {}, ['面板挂在 ', E('code', {}, '127.0.0.1'), '，浏览器从路由器管理地址访问不到。']),
			E('div', { style: 'color:var(--mh-muted);' }, ['把口子挂到 80 上即可：', E('code', {}, '/usr/sbin/mtun-xd expose on'), '（或把监听改成 0.0.0.0 后重启内核）。'])
			] : [
				E('h3', { style: 'margin:0 0 6px;' }, '连不上面板'),
				E('div', {}, ['浏览器够不着 ', E('code', {}, showAddr), '（端口没放行，或不在内网）。'])
			]);

			// 注意：跨域 iframe 连不上也会触发 load → 只能主动探活。同源那条读得到状态码：
			// 内核没起来时 uhttpd 回 502/504（no-cors 那套会当成"通"）；直连探的是 /index.html。
			var probe = function () {
				if (viaHttp) {
					// 同源同样要有上限：内核半死时 uhttpd 会一直吊着，页面既不出框也不出提示
					return Promise.race([
						fetch('/version', { cache: 'no-store' }).then(function (r) {
							return r.status < 500;      // 200/401 = 内核活着；502/504 = 没起来
						}, function () { return false; }),
						new Promise(function (r) { setTimeout(function () { r(false); }, 2500); }),
					]);
				}
				return Promise.race([
					fetch(url + 'index.html', { mode: 'no-cors', cache: 'no-store' })
						.then(function () { return true; }, function () { return false; }),
					new Promise(function (r) { setTimeout(function () { r(false); }, 2500); }),
				]);
			};
			// 注意：`external-ui` 没写 = 内核压根不发这个静态站，一定打不开 —— 连框都不建
			// （没插进文档的 iframe 不会去加载 src，等于没请求）。
			if (readErr || noUi) {
				hint.style.display = '';
			} else {
				probe().then(function (ok) {
					// 用 display:none **不是** remove()：探活回来时这页多半还没插进文档（render 同步
					// 返回、LuCI 之后才挂上），那时 remove() 是空操作 ⇒ 404/502 那页照样显示出来。
					if (ok) return;
					frame.style.display = 'none';
					hint.style.display = '';
					// 框没了就别再 overflow:hidden —— 提示可能比窗口高，得能滚
					body.style.overflow = 'auto';
					// 「载入配置文件」换过监听地址之后这里挂的还是老地址（内核热载不换监听）
					// ⇒ 后台自己重新挑一个能答的挂上。
					C.selfHeal();
				});
			}

			// 没挂上（pkg 模式装的 / 手动 apk add / 上一版漏的）⇒ 后台自己补一次；
			// 补成了整页重载一次走同源那条。
			// ⚠️ noUi / readErr 不补：前者缺 external-ui（ensure 治不了），后者 CLI 都没跑成。
			if (!viaHttp && !noUi && !readErr) C.selfHeal();

			// 通栏（左右到边、底下接到页脚）
			var body = E('div', {
				style: 'flex:1 1 auto; min-height:0; display:flex; flex-direction:column; margin:-13px 0 0 0;'
			}, (readErr || noUi) ? [hint] : [frame, hint]);

			// 缩放**跟着窗口宽度实时变**（实现在 common.js：窄屏不缩、宽屏按 baseSc 缩）
			// Argon 的容器是 #tabmenu / footer：版式微调直接写一条 CSS，
			// 比逐个元素 set style 好维护，也不必在 hashchange 里还原。
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

			var root = E('div', {}, [body]);
			C.fill(root);
			return root;
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
