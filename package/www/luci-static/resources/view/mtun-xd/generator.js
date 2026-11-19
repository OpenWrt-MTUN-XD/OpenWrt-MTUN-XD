'use strict';
'require view';
'require fs';
'require mtun-xd.common as C';

/*
 * MTUN-XD → 配置工具：生成器是另一个项目的东西，装在 /etc/mihomo/ui/config/ 里，这里原样嵌进来。
 * 注意：生成器的门认工具密码，跨源留不了 sessionStorage ⇒ 这页把 /etc/mihomo-toolpass 写进
 * iframe 的 `#tool=` 带过去；监听地址写死 127.0.0.1（内核口子已挂到 uhttpd 的同源路径）。
 */
return view.extend({
	render: function () {
		// 主题：只跟路由器（Argon 的明暗）
		C.themeApply();
		return Promise.all([C.readPanel(), C.exposeOn()]).then(function (r) {
			var panel = r[0], viaHttp = r[1];
			var port = panel.port;
			// 内核的口子挂到 uhttpd 上了（`mtun-xd expose on`）→ 走**同源**：没有跨域、没有
			// 混合内容问题（生成器跟这一页同源之后那些 localStorage 也不用再绕）；没挂 → 老那条 (:端口)。
			var baseHttp = window.location.origin + C.uiPath(panel) + 'config/';
			var baseDirect = window.location.protocol + '//' + window.location.hostname + ':' + port + C.uiPath(panel) + 'config/';
			var base = viaHttp ? baseHttp : baseDirect;

			// 两把钥匙：`?secret=` 面板密码（生成器据此才显示「载入配置文件」）、`#tool=` 工具密码（门据此放行）。
			// 注意：跨源时替它写不了 localStorage ⇒ 只能走地址栏（读完立刻抹掉）；拼地址只有这一处，pw 空也走它。
			var mk = function (b, pw) {
				var src = b;
				if (panel.secret) src += '?secret=' + encodeURIComponent(panel.secret);
				// noframe=1：告诉生成器"虽然嵌在 iframe 里，但宿主是 LuCI、不是面板" —— 否则它会
				// 切成面板那套 postMessage（这里没人接，点了没反应），而不是用它自己的「载入配置文件」。
				src += (src.indexOf('?') >= 0 ? '&' : '?') + 'noframe=1';
				// 第一帧就按宿主的明暗画（app/theme-hint.js 认这个参数），否则会先按系统明暗闪一下。
				src += '&theme=' + C.themeNow();
				// listen **写死 127.0.0.1**：内核口子已经挂到 uhttpd 那个端口（`expose on`），
				// 面板 / 配置工具 / API 全走同源，不必再绑内网地址；生成器只在用户没动过这项时采用。
				src += '&listen=127.0.0.1';
				// 一次性时间戳必须排在 `#tool=` 前面（那截是 fragment，挂后面就成了它的一部分）：
				// mihomo 只发 Last-Modified，浏览器会把生成器那份 index.html 也缓存住（同 panel.js）。
				src += '&_t=' + Date.now();
				if (pw) src += '#tool=' + encodeURIComponent(pw);
				return src;
			};

			return fs.exec(C.SCRIPT, ['toolpass']).then(function (res) {
				return mk(base, String((res && res.stdout) || '').trim());
			}).catch(function () {
				return mk(base, '');
			}).then(function (src) {
				var frame = E('iframe', {
					src: src,
					style: 'display:block; width:100%; flex:1 1 auto; min-height:320px; border:0; background:var(--mh-iframe-bg);',
				});

				// 生成器自己的浅色 / 深色跟着同一份选择走（同源，直接改它 <html> 上的 data-theme）；
				// 它那颗月亮/太阳按钮还在，但只影响生成器内部，下次进这一页又按我们的来。
				C.frameTheme(frame);

				// 默认不缩放（跟控制面板同一套口径，实现在 common.js，三页一律 100%）
				var baseSc = C.scaleOf(0);

				// 跟控制面板一个道理，三种"打不开"分开说：没开面板 / 绑回环 / 真没装
				var readErr = !!panel.failed;          // panelinfo 没跑成（超时 / 权限 / 正忙）
				var noUi = !readErr && !panel.ui;      // 真没写 external-ui 才算「没启用」
				var isLoop = C.loopbackOnly(panel.host);
				var hint = E('div', { style: 'display:none; padding:28px 32px; line-height:1.9;' }, readErr ? [
					E('h3', { style: 'margin:0 0 6px;' }, '读不到套件信息'),
					E('div', {}, ['执行 ', E('code', {}, '/usr/sbin/mtun-xd panelinfo'), ' 失败（超时 / 权限 / 内核正忙）—— 稍后刷新本页。']),
					E('div', { style: 'color:var(--mh-muted);' }, '连不上就 ', E('code', {}, '/usr/sbin/mtun-xd status'), ' 看状态。')
				] : noUi ? [
					E('h3', { style: 'margin:0 0 6px;' }, '配置工具未启用'),
					E('div', {}, ['config.yaml 里加一行 ', E('code', {}, 'external-ui: ui'), '，再重启内核。'])
				] : viaHttp ? [
					E('h3', { style: 'margin:0 0 6px;' }, '配置工具没应答'),
					E('div', {}, ['内核没跑，或工具目录缺失 —— 先跑 ', E('code', {}, '/usr/sbin/mtun-xd status'), ' 看一眼。']),
					E('div', { style: 'color:var(--mh-muted);' }, '目录没了就 ', E('code', {}, '/usr/sbin/mtun-xd tool'), ' 补装。')
				] : isLoop ? [
								E('h3', { style: 'margin:0; font-weight:400;' }, '配置工具只监听本机回环：跑 /usr/sbin/mtun-xd expose on 把它挂到 80 上')
				] : [
					E('h3', { style: 'margin:0 0 6px;' }, '连不上配置工具'),
					E('div', {}, ['浏览器够不着 ', E('code', {}, 'http://' + String(window.location.hostname) + ':' + String(port) + '/ui/config/'), '（端口没放行，或不在内网）。'])
				]);

				// 注意：跨域 iframe 连不上也会触发 load → 只能主动探活（探活用不带 hash 的地址）；
				// 同源那条读得到状态码，内核没起来时 uhttpd 回 502/504，no-cors 会当成"通"。
				var probe = function () {
					if (viaHttp) {
						// 同源也要有超时：内核半死（uhttpd 等后端）时这一页会一直挂着，连提示都不出
						return Promise.race([
							fetch(base, { cache: 'no-store' }).then(function (r) { return r.ok; },
								function () { return false; }),
							new Promise(function (r) { setTimeout(function () { r(false); }, 2500); }),
						]);
					}
					return Promise.race([
						fetch(base + 'index.html', { mode: 'no-cors', cache: 'no-store' })
							.then(function () { return true; }, function () { return false; }),
						new Promise(function (r) { setTimeout(function () { r(false); }, 2500); }),
					]);
				};
				// 注意：`external-ui` 没写 = 内核压根不发这个静态站，一定打不开 —— 连框都不建
				// （没插进文档的 iframe 不会加载 src，等于没请求）。
				if (readErr || noUi) {
					hint.style.display = '';
				} else {
					probe().then(function (ok) {
						// 用 display:none 而不是 remove()：探活回来时这一页多半还没插进文档，
						// 那时候 remove() 是空操作 ⇒ 框还在、照样把 404/502 那页显示出来。
						if (ok) return;
						frame.style.display = 'none';
						hint.style.display = '';
						body.style.overflow = 'auto';   // 框没了，提示可能比窗口高
						// 挂着的地址不通了（「载入配置文件」换过监听）⇒ 后台重挑一个挂上，整页重来
						C.selfHeal();
					});
				}

				// 没挂上 ⇒ 后台自己补一次（补成了整页重载）。
				// ⚠️ noUi / readErr 时不补：前者是 config.yaml 没写 external-ui（expose ensure 治不了），
				//    后者是 CLI 没跑成（再调一次同样会失败），白跑还会重启 uhttpd。
				if (!viaHttp && !noUi && !readErr) C.selfHeal();

				var body = E('div', {
					style: 'flex:1 1 auto; min-height:0; display:flex; flex-direction:column; margin:-15px 0 0 0;'
				}, (readErr || noUi) ? [hint] : [frame, hint]);

				C.scaleFrame(frame, body, baseSc);

				var root = E('div', {}, [body]);
				// Argon 的容器是 #tabmenu / footer：版式微调直接写一条 CSS，
			// 比逐个元素 set style 好维护，也不必在 hashchange 里还原。
			(function () {
				var st = document.getElementById('mh-layout-css');
				if (!st) {
					st = document.createElement('style');
					st.id = 'mh-layout-css';
					document.head.appendChild(st);
				}
				st.textContent = 'body[data-page^="admin-services-mtun-xd"] #tabmenu{margin-top:-5px} ' +
				'body[data-page^="admin-services-mtun-xd"] footer{margin-top:-17px} ' +
				'body[data-page^="admin-services-mtun-xd"] #maincontent .container{padding:0}';
				// 内容区的 16px padding 由我们接管，视图里就不用再写 -16px 负边距
				// 选择器用 body[data-page] 限定：切到别的页面时这段样式自动失效（Argon 每页都会写 data-page）
			})();


			C.fill(root);
				return root;
			});
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
