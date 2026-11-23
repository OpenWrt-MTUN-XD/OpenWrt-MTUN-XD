/*!
 * iStoreOS-Mihomo-config 生成器 — 界面逻辑
 *
 * 把 state.js 里的数据渲染成 DOM，把用户操作写回 state，并在任何变化后重新生成配置。生成逻辑
 * 逐段对应 Python 版 GUI 的 `_gen_split` / `_gen_oneip`（含「多节点自动选默认出口」「选项之间
 * 的互斥与联动」），产物形态以 README「生成约定」为准。
 */
(function (root) {
  'use strict';

  var MH = (root.MH = root.MH || {});
  var doc = root.document;
  if (!doc) return;

  var state = MH.defaultState();
  var generated = '';
  var statusBase = '就绪';   // 状态栏那行「就绪 / 已生成 · 摘要」，提示条过期后恢复成它
  var MAX_SUB_BYTES = 10 * 1024 * 1024;

  // 自定义规则那一格的「出口」草稿：['DIRECT'] 或一串节点名；一个节点 = 直接走它，≥2 个 = 生成
  // 一个负载均衡组（见 makeRuleGroups）。只在本次页面里有效，不落盘。
  var ruleActions = ['DIRECT'];
  /** 自定义规则里那个负载均衡组的名字（第一个组；第二、第三个是 负载均衡2、3…）。 */
  var RULE_GROUP = '负载均衡';
  /**
   * 「常用」里的 AI 分流：国内环境（默认）用海外 AI `category-ai-!cn`，回国模式用国内 AI
   * `category-ai-cn`；模式切换时按当前状态现算，规则里不用改。
   */
  var AI_CATEGORY = 'category-ai-!cn';
  var AI_CATEGORY_CN = 'category-ai-cn';
  // 「常用 → TK」固定用 tiktok 分类，不按回国模式切换。
  var TK_CATEGORY = 'tiktok';
  // 「常用 → TC」固定用 tencent 分类（含微信 / QQ / 腾讯全家桶）。
  var TENCENT_CATEGORY = 'tencent';
  // 「常用 → NF」：域名走 NETFLIX 分类，IP 走 GEOIP netflix 标签。
  var NF_CATEGORY = 'netflix';

  function returnModeOn() {
    return !!(state.mode === 'oneip' ? state.oneipReturnMode : state.returnMode);
  }

  function aiCategory() {
    return returnModeOn() ? AI_CATEGORY_CN : AI_CATEGORY;
  }

  /** 这条是不是「常用 → AI」那条（含手写的 geosite:category-ai-cn / !cn）。 */
  function isAiRule(r) {
    if (!r) return false;
    if (r.preset === 'ai') return true;
    return r.type === 'geosite' && (r.target === AI_CATEGORY || r.target === AI_CATEGORY_CN);
  }

  /** 这条是不是「常用 → TK」那条（含手写的 geosite:tiktok）。 */
  function isTkRule(r) {
    if (!r) return false;
    if (r.preset === 'tk') return true;
    return r.type === 'geosite' && r.target === TK_CATEGORY;
  }

  /** 这条是不是「常用 → TC」那条（含手写的 geosite:tencent）。 */
  function isTencentRule(r) {
    if (!r) return false;
    if (r.preset === 'tencent') return true;
    return r.type === 'geosite' && r.target === TENCENT_CATEGORY;
  }

  /** 这条是不是「常用 → NF」那条（geosite / geoip 两种都算）。 */
  function isNfRule(r) {
    if (!r) return false;
    if (r.preset === 'nf') return true;
    return (r.type === 'geosite' || r.type === 'geoip') && r.target === NF_CATEGORY;
  }

  /**
   * 常用规则的固定顺序：TK → TC → NF → AI；勾选先后不参与排序。
   * 手写的 geosite:tiktok / tencent / category-ai-* / netflix 同样算。
   */
  function presetRank(r) {
    if (isTkRule(r)) return 0;
    if (isTencentRule(r)) return 1;
    if (isNfRule(r)) return 2;
    if (isAiRule(r)) return 3;
    return -1;
  }

  /**
   * 把三条常用规则按 TK → TC → AI 排好，仍放在它们第一次出现的位置上；只动这三条。
   */
  function orderPresetRules() {
    var first = -1;
    var presets = [];
    state.customRules.forEach(function (r, i) {
      if (presetRank(r) < 0) return;
      if (first < 0) first = i;
      presets.push(r);
    });
    if (first < 0 || presets.length < 2) return;
    var sorted = presets.slice().sort(function (a, b) {
      return presetRank(a) - presetRank(b);
    });
    var same = true;
    for (var i = 0; i < presets.length; i++) {
      if (presets[i] !== sorted[i]) { same = false; break; }
    }
    if (same) return;
    var rest = state.customRules.filter(function (r) { return presetRank(r) < 0; });
    rest.splice.apply(rest, [first, 0].concat(sorted));
    state.customRules = rest;
  }

  /** `geosite:<分类>` 形式的目标 —— 生成 `GEOSITE,<分类>,<出口>`。 */
  function geositeCategory(target) {
    var m = /^geosite:([A-Za-z0-9!._-]+)$/i.exec(String(target == null ? '' : target).trim());
    return m ? m[1] : '';
  }

  /** 展示用的目标名（规则 chip / 提示里）。 */
  function ruleTargetLabel(r) {
    if (!r) return '';
    if (isAiRule(r)) return 'AI';
    if (isTkRule(r)) return 'TK';
    if (isTencentRule(r)) return 'TC';
    if (isNfRule(r)) return r.type === 'geoip' ? 'NF-IP' : 'NF';
    if (r.type !== 'geosite') return r.target;
    return 'geosite:' + r.target;
  }

  /** 一条自定义规则的出口列表（兼容老的 `{target, action}` 形态）。 */
  function ruleActionsOf(item) {
    if (item && Array.isArray(item.actions) && item.actions.length) return item.actions.slice();
    if (item && item.action) return [item.action];
    return ['DIRECT'];
  }

  /**
   * 「自定义规则」的出口选项（上面不选的肯定给下面）：
   *   · 一机一IP → 全部节点（每个节点分自己的内网 IP，没有「占用」）；
   *   · 精准分流 + 智能选择 → 只有被反选的节点；
   *   · 精准分流（不带智能选择）→ 除默认出口外的节点。
   */
  function ruleOptions(names) {
    if (state.mode !== 'split') return names.slice();
    if (state.autoSelect && names.length >= 2) {
      return names.filter(function (n) {
        return state.autoSelectExclude.indexOf(n) !== -1;
      });
    }
    var def = names.indexOf(state.defaultNode) !== -1 ? state.defaultNode : names[0];
    return names.filter(function (n) { return n !== def; });
  }

  function $(id) { return doc.getElementById(id); }
  function on(el, ev, fn) { if (el) el.addEventListener(ev, fn); }

  // ── 通用小工具 ──────────────────────────────────────────────
  function setStatus(text) { $('status-text').textContent = text; }

  var smartWasOn = false;   // 上一帧「智能选择」是否生效（用于关闭时还原默认出口）
  var toastTimer = null;
  function toast(msg, kind) {
    // 提示直接写进底部状态栏：它是 sticky 的，三步里位置完全一样，
    // 不用再靠 position:fixed 在不同高度的页面上对位置。
    var st = $('status-text');
    if (st) {
      st.textContent = msg;
      st.className = 'status-msg' + (kind ? ' ' + kind : '');
      if (toastTimer) root.clearTimeout(toastTimer);
      toastTimer = root.setTimeout(function () {
        st.textContent = statusBase;
        st.className = '';
      }, kind === 'err' ? 6000 : 2600);
      return;
    }
    var el = $('toast');
    el.textContent = msg;
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.hidden = false;
    if (toastTimer) root.clearTimeout(toastTimer);
    toastTimer = root.setTimeout(function () { el.hidden = true; }, kind === 'err' ? 6000 : 2600);
  }

  /**
   * 多行框跟着内容长高，最多 `maxRows` 行，再多就在框里滚。
   * 「粘贴链接」那个 textarea 出厂 rows=1，贴 20 条链接进去只能在一个小格子里上下翻，让它自己
   * 长到 8 行才像「贴进来的东西」。
   */
  function autoGrow(el, maxRows) {
    if (!el || !root.getComputedStyle) return;
    var cs = root.getComputedStyle(el);
    var lh = parseFloat(cs.lineHeight);
    if (!lh || isNaN(lh)) lh = 20;
    var pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
      + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    var max = Math.round(lh * maxRows + pad);
    el.style.height = 'auto';
    // 空的时候交还给 CSS（rows=1 的自然高度），别让人看见框"用一次矮 4px"
    if (!el.value) {
      el.style.height = '';
      el.style.overflowY = '';
      return;
    }
    var want = el.scrollHeight;
    el.style.height = Math.min(want, max) + 'px';
    el.style.overflowY = want > max ? 'auto' : 'hidden';
  }

  /**
   * 预览区那两个动作（下载 / 复制）跟「有没有生成成功」绑定：置灰比点了弹错利落。
   */
  function setPreviewActions(on) {
    var ids = ['download-btn', 'copy-btn'];
    for (var i = 0; i < ids.length; i++) {
      var el = $(ids[i]);
      if (el) el.disabled = !on;
    }
  }

  /**
   * Python GUI 的 `_int`：必须能解析成整数且落在 1-65535；`allowZero` 给 keep-alive 用
   * （mihomo 里 0 表示「关闭」）。
   */
  function intInRange(value, field, allowZero) {
    var t = String(value == null ? '' : value).trim();
    if (!/^[+-]?[0-9]+$/.test(t)) throw new Error(field + ' 格式错误: ' + value);
    var v = parseInt(t, 10);
    if (!((v > 0 && v < 65536) || (allowZero && v === 0))) {
      throw new Error(field + ' 超出范围: ' + v);
    }
    return v;
  }

  /**
   * 自定义规则按去向分三拨：`nodeRules` 是动作选了某个节点的，输出到规则段最前面的
   * `# 自定义规则` 块；`ips` / `domains` 是动作 DIRECT 的，交给直连块。
   *
   * `validActions` 是当前还有效的动作（'DIRECT' + 所有节点名）。引用了已被删掉的节点的条目直接
   * 丢掉、不回落成 DIRECT —— 用户本意是让这些流量走代理，悄悄改成直连等于把它们放出去。
   */
  function splitCustomRules(items, validActions) {
    var ips = [], domains = [], nodeRules = [];
    for (var i = 0; i < items.length; i++) {
      var r = items[i];
      if (!r) continue;
      var target = String(r.target == null ? '' : r.target).trim();
      if (!target) continue;
      var acts = [];
      ruleActionsOf(r).forEach(function (a) {
        a = String(a == null ? '' : a).trim();
        if (!a || validActions.indexOf(a) === -1) return;
        if (acts.indexOf(a) === -1) acts.push(a);
      });
      if (!acts.length) continue;
      if (r.type === 'geoip') {
        nodeRules.push({ target: target, type: 'geoip', preset: r.preset, actions: acts });
        continue;
      }
      var cat;
      if (r.preset === 'ai') {
        // 「常用 → AI」：国内环境用海外 AI 分类，回国模式换成国内 AI 分类
        cat = aiCategory();
      } else if (r.preset === 'tk') {
        // 「常用 → TK」：固定 tiktok，不跟回国模式走
        cat = TK_CATEGORY;
      } else if (r.preset === 'tencent') {
        // 「常用 → TC」：固定 tencent（微信 / QQ / 腾讯全家桶）
        cat = TENCENT_CATEGORY;
      } else if (r.type === 'geosite') {
        cat = /^[A-Za-z0-9!._-]+$/.test(target) ? target : '';
      } else {
        cat = geositeCategory(target);
      }
      if (cat) {
        // GeoSite 目标：直连也留在自定义规则块里（`GEOSITE,<分类>,DIRECT`），
        // 不能落到下面的直连 IP/域名块。
        if (acts.indexOf('DIRECT') !== -1) acts = ['DIRECT'];
        nodeRules.push({ target: cat, type: 'geosite', preset: r.preset, actions: acts });
        continue;
      }
      if (acts.indexOf('DIRECT') !== -1) {
        // 内网目标 = 「这台设备直连」，按来源匹配；留在自定义块里走 SRC-IP-CIDR。
        // 公网目标才是「访问这些 IP 直连」，进直连块按目标匹配。
        if (MH.classify(target) === 'ip' && MH.isPrivateTarget(target)) {
          nodeRules.push({ target: target, actions: acts.slice() });
        } else if (MH.classify(target) === 'ip') {
          ips.push(target);
        } else {
          domains.push(target);
        }
      } else {
        nodeRules.push({ target: target, actions: acts });
      }
    }
    return { ips: ips, domains: domains, nodeRules: nodeRules };
  }

  /**
   * 智能选择的反选集合变了之后，把自定义规则里「已经回到智能组」的节点摘掉：多选组只保留还在
   * 反选里的节点，一个都不剩就删掉这条规则。单选不动 —— 直接指向某个节点本身是合法规则。
   * 不这么做的话，规则 chip 会显示 T1·T2，生成的却是单选 T2，界面和产物对不上。
   */
  /**
   * 智能选择的反选集合变了之后，把多节点规则的出口收窄到「还留在反选里」的节点。
   * ⚠️ 收窄到空不删规则：降级成单选（保留第一个出口），目标域名 / IP 都还在。
   * 纯函数，单测直接测（tests/unit/rules.test.mjs）。
   */
  function narrowRuleActions(acts, excluded) {
    if (acts.indexOf('DIRECT') !== -1) return ['DIRECT'];
    if (acts.length <= 1) return acts.slice();
    var keep = acts.filter(function (a) { return excluded.indexOf(a) !== -1; });
    return keep.length ? keep : [acts[0]];
  }

  /**
   * 待添加的出口：只剔除已经不在节点表里的名字（节点被删 / 清空）。
   * ⚠️ 不能按「菜单里能不能选」过滤：选好的出口可能刚被改成默认出口或被智能选择收走 —— 那只是
   * 「不在菜单里」，不是「选择失效」，按可见项过滤会把待添加的动作悄悄改写成 ['DIRECT']。
   * 纯函数，单测直接测。
   */
  function validRuleActions(selected, names) {
    var acts = (selected || []).filter(function (a) {
      return a === 'DIRECT' || (names || []).indexOf(a) !== -1;
    });
    if (!acts.length || acts.indexOf('DIRECT') !== -1) return ['DIRECT'];
    return acts;
  }

  function syncCustomRulesWithExclude() {
    if (!(state.mode === 'split' && state.autoSelect && state.nodes.length >= 2)) return;
    var names = state.nodes.map(function (p) { return p.name; });
    var excluded = names.filter(function (n) {
      return state.autoSelectExclude.indexOf(n) !== -1;
    });
    state.customRules = state.customRules.filter(function (r) {
      var acts = ruleActionsOf(r).filter(function (a) {
        return a === 'DIRECT' || names.indexOf(a) !== -1;
      });
      // 节点全被删光了 → 这条规则确实没有意义
      if (!acts.length) return false;
      if (acts.indexOf('DIRECT') !== -1 || acts.length <= 1) return true;
      r.actions = narrowRuleActions(acts, excluded);
      delete r.action;   // 兼容老的 {target, action} 形态
      return true;
    });
  }

  /**
   * 自定义规则的多节点出口 → 负载均衡组。
   *
   * 规则形态 `{target, actions:[节点名...]}`：1 个节点 → `r.action = 节点名`（不建组）；
   * ≥2 个 → 建一个 load-balance 组，`r.action = 组名`，成员完全相同的多条规则共用一个组。
   * ⚠️ 智能选择开着时，只有在「智能选择成员」里被反选的节点才能进这个组；过滤后只剩 1 个就按
   * 单选写那个节点，一个不剩这条规则直接丢掉。
   */
  function makeRuleGroups(nodeRules, names) {
    var groups = [], seen = Object.create(null), seq = 0;
    // 只有精准分流才有「智能组占用节点」这回事；一机一IP 里所有节点随便选
    var smartOn = state.mode === 'split' && state.autoSelect && names.length >= 2;
    // 智能选择下，能参与自定义规则的只有反选的节点
    var mixed = smartOn ? names.filter(function (n) {
      return state.autoSelectExclude.indexOf(n) !== -1;
    }) : [];
    nodeRules.forEach(function (r) {
      // DIRECT 只可能出现在 GeoSite 规则里（普通规则的 DIRECT 已经进直连块）
      var original = (r.actions || []).filter(function (a) {
        return a === 'DIRECT' || names.indexOf(a) !== -1;
      });
      var acts = original.slice();
      if (acts.indexOf('DIRECT') !== -1) acts = ['DIRECT'];
      if (smartOn && acts.length > 1) {
        // 多选组只收反选节点（避免和智能组重叠）；
        // 单选不动 —— 直接指向某个节点（哪怕它在智能组里）本身是合法规则。
        acts = acts.filter(function (a) { return mixed.indexOf(a) !== -1; });
      }
      if (acts.length > 1) {
        var key = acts.slice().sort().join('\u0000');
        if (!seen[key]) {
          var gname;
          do {
            seq += 1;
            // 第一个组就叫「负载均衡」；成员不同的第二、第三个组依次 负载均衡2、3…
            gname = seq === 1 ? RULE_GROUP : RULE_GROUP + seq;
          } while (names.indexOf(gname) !== -1 || gname === MH.SplitEngine.AUTO_GROUP);
          seen[key] = gname;
          groups.push({ name: gname, proxies: acts.slice() });
        }
        r.action = seen[key];
      } else {
        r.action = acts[0] || '';
      }
    });
    return groups;
  }

  /** 多行文本 → 列表：切行、trim、丢空行、按顺序去重。 */
  function listFromText(text) {
    var seen = Object.create(null);
    var out = [];
    String(text == null ? '' : text).split(/\r?\n/).forEach(function (line) {
      var v = line.trim();
      if (!v || seen[v]) return;
      seen[v] = true;
      out.push(v);
    });
    return out;
  }

  /**
   * DNS 列表（一行一个）。带空白就报错 —— 最常见的手滑是把两台 DNS 写在一行
   * （`1.1.1.1 8.8.8.8`），生成出来是 `- 1.1.1.1 8.8.8.8`，内核会以 invalid character 拒载整份配置。
   */
  function dnsItems(value, field) {
    var items = cleanList(value);
    for (var i = 0; i < items.length; i++) {
      if (/\s/.test(items[i])) {
        throw new Error(field + ' 里有空格（一行一个）：' + items[i]);
      }
    }
    return items;
  }

  /**
   * 端口列表：每项是 `端口` 或 `起始-结束`，1-65535，起点不能大于终点 —— 内核只认这个形状，
   * `abc` / `8080-8880-9999` 都会让整份配置拒载。
   */
  function portItems(value, field) {
    var items = cleanList(value);
    for (var i = 0; i < items.length; i++) {
      var s = items[i];
      var m = /^([0-9]{1,5})(?:-([0-9]{1,5}))?$/.exec(s);
      if (!m) throw new Error(field + ' 只能填端口或端口段（如 80、8080-8880）：' + s);
      var a = parseInt(m[1], 10);
      var b = m[2] ? parseInt(m[2], 10) : a;
      if (a < 1 || a > 65535 || b < 1 || b > 65535) {
        throw new Error(field + ' 超出 1-65535：' + s);
      }
      if (b < a) throw new Error(field + ' 的端口段起点比终点大：' + s);
    }
    return items;
  }

  /** 把 state 里存的列表再清洗一遍（老存档可能塞进字符串或空白项）。 */
  function cleanList(value) {
    return listFromText(Array.isArray(value) ? value.join('\n') : value);
  }

  /** 白名单取值：不在名单里就回落默认（下拉被塞了别的值也不至于生成废配置）。 */
  function pickEnum(value, allowed, fallback) {
    return allowed.indexOf(value) !== -1 ? value : fallback;
  }

  var LOG_LEVELS = ['debug', 'info', 'warning', 'error', 'silent'];
  var FIND_PROCESS_MODES = ['always', 'strict', 'off'];

  /** dns.listen 的 host:port 校验：空着回落默认，填了不合法就报错让人看见。 */
  function dnsListenOf(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s) return MH.DNS_DEFAULTS.listen;
    var m = /^(.*):([0-9]+)$/.exec(s);
    // host 不能是空串：`:1053` 这种写法 mihomo 不接受
    if (!m || !String(m[1]).trim()) {
      throw new Error('DNS 监听地址格式错误（应形如 127.0.0.1:1053）: ' + s);
    }
    intInRange(m[2], 'DNS 监听端口');
    return s;
  }

  /**
   * 跑一段赋值，出错时把「是哪个输入框」记在 error.target 上。
   * refresh 的 catch 用它在界面上展开**包含这个框的那张卡片** —— 比按文案关键字猜准得多
   * （keep-alive 在主面板、MTU 在进阶卡片、DNS 在独立卡片）。
   */
  function withField(id, fn) {
    try {
      fn();
    } catch (e) {
      if (e && typeof e === 'object' && !e.target) e.target = id;
      throw e;
    }
  }

  /**
   * 把「进阶参数」搬到引擎实例上。分流与一机一IP 共用同一份 `_skeleton`，两个分支都调这一个
   * 函数 —— 分成两份写迟早有一边漏字段，表现是「分流能调、一机一IP 调了没反应」且不报错。
   * 列表为空时不要在这里补默认值：引擎侧 `listOr` 会回落成出厂值，补在这儿反而多一份要同步的。
   */
  function applyAdvanced(eng) {
    // 基础参数
    eng.log_level = pickEnum(state.logLevel, LOG_LEVELS, 'info');
    eng.unified_delay = !!state.unifiedDelay;
    eng.tcp_concurrent = !!state.tcpConcurrent;
    eng.auto_group_round_robin = !!state.autoRoundRobin;
    eng.lb_round_robin = !!state.lbRoundRobin;
    withField('keep-alive-idle', function () {
      eng.keep_alive_idle = intInRange(String(state.keepAliveIdle || '').trim() || '60', 'keep-alive-idle', true);
    });
    withField('keep-alive-interval', function () {
      eng.keep_alive_interval = intInRange(String(state.keepAliveInterval || '').trim() || '30', 'keep-alive-interval', true);
    });
    eng.find_process_mode = pickEnum(state.findProcessMode, FIND_PROCESS_MODES, 'off');

    // TUN
    eng.auto_route = !!state.autoRoute;
    eng.auto_redirect = !!state.autoRedirect;
    eng.auto_detect_interface = !!state.autoDetectInterface;
    eng.strict_route = !!state.strictRoute;
    withField('mtu', function () {
      eng.mtu = intInRange(String(state.mtu || '').trim() || '1400', 'MTU');
    });
    eng.dns_hijack = cleanList(state.dnsHijack);

    // DNS
    withField('dns-listen', function () { eng.dns_listen = dnsListenOf(state.dnsListen); });
    withField('dns-default-ns', function () { eng.dns_default_ns = dnsItems(state.dnsDefaultNs, '引导 DNS'); });
    withField('dns-nameserver', function () { eng.dns_nameserver = dnsItems(state.dnsNameserver, '默认 DNS'); });
    withField('dns-proxy-server-ns', function () { eng.dns_proxy_server_ns = dnsItems(state.dnsProxyServerNs, '节点 DNS'); });
    withField('dns-direct-ns', function () { eng.dns_direct_ns = dnsItems(state.dnsDirectNs, '直连 DNS'); });
    withField('dns-policy-cn', function () { eng.dns_policy_cn = dnsItems(state.dnsPolicyCn, '中国 DNS'); });
    withField('dns-policy-geo', function () { eng.dns_policy_geo = dnsItems(state.dnsPolicyGeo, '国外 DNS'); });

    // sniffer
    eng.sniffer_enable = !!state.snifferEnable;
    withField('sniffer-http-ports', function () { eng.sniffer_http_ports = portItems(state.snifferHttpPorts, 'HTTP 端口'); });
    withField('sniffer-tls-ports', function () { eng.sniffer_tls_ports = portItems(state.snifferTlsPorts, 'TLS 端口'); });
    withField('sniffer-quic-ports', function () { eng.sniffer_quic_ports = portItems(state.snifferQuicPorts, 'QUIC 端口'); });
    eng.sniffer_skip_domains = cleanList(state.snifferSkipDomains);
  }

  // ── 模式与选项可见性 ────────────────────────────────────────
  function isMulti() { return state.nodes.length >= 2; }

  /**
   * 规则方案。入口是 rules 卡片顶部的 #mode-select 下拉，一次做三件事：回写下拉、写状态栏、
   * 按方案开关卡内的 .mode-panel 分块（`data-modes` 里有没有当前方案决定藏不藏）。
   */
  function renderMode() {
    $('mode-select').value = state.mode;
    // 内网控制不提示 IP-CIDR6（避免误解成要 IPv6）；精准分流保留完整两类
    var v6Hint = $('ipv6-rule-hint');
    if (v6Hint) v6Hint.hidden = state.mode === 'oneip';

    var panels = doc.querySelectorAll('.mode-panel');
    for (var j = 0; j < panels.length; j++) {
      var modes = (panels[j].dataset.modes || '').split(' ');
      panels[j].hidden = modes.indexOf(state.mode) === -1;
    }

    // 规则方案下方的提示跟方案走：一机一IP 按 IPv4 源 IP 分流、IPv6 恒关，改成提醒这一条
    var hint = $('rule-mode-hint');
    if (hint) {
      hint.textContent = state.mode === 'oneip'
        ? '提示：内网控制必须关闭IPV6'
        : '提示：默认使用 Fake-IP下级路由代理及链式代理场景请使用 Redir-Host模式';
    }
  }

  /** 选项之间的联动（照搬 GUI 的 `_update_mode_visibility` / `_update_app_visibility`）。 */
  function renderOptionVisibility() {
    // 智能选择：节点不足 2 个时整格不显示（用户 2026-11-16：不可勾选的直接藏掉更简洁）。
    // 不动 state.autoSelect：节点回到 2 个时恢复用户原来的选择。
    var multi = isMulti();
    $('auto-select-field').hidden = !multi;
    $('auto-select').disabled = !multi;
    $('auto-select').checked = multi ? state.autoSelect : false;
    // 成员池只剩一个时不建组（buildConfig 会把默认出口直接指向那个节点）
    var smartPool = state.mode === 'split' && state.autoSelect && multi
      ? MH.SplitEngine.smartPool(state.nodes, state.autoSelectExclude) : [];
    var smartGroup = smartPool.length >= 2;
    $('auto-select-hint').textContent = '勾选：已知节点自动创建自动选优组';
    // 成员框跟着一起刷新（藏/显、节点增减、黑名单清理都在里面）
    renderAutoPool();

    // IPv6：一机一IP 按 IPv4 源 IP 分流，引擎里恒关 —— 那一格直接不显示。
    // state.ipv6 不动，切回精准分流就照原样恢复。
    var ipv6Off = state.mode === 'oneip';
    $('ipv6-field').hidden = ipv6Off;
    $('ipv6').disabled = ipv6Off;
    $('ipv6').checked = ipv6Off ? false : state.ipv6;

    // 区域性开关回写（精准分流面板有回国 / 全局代理；一机一IP 面板有回国 / 国内两个）
    $('return-mode').checked = state.returnMode;
    $('global-proxy').checked = state.globalProxy;
    $('oneip-return-mode').checked = state.oneipReturnMode;
    $('oneip-mainland').checked = state.oneipMainland;

    // 默认出口：只要有节点就显示（只有一个节点时它就是唯一出口，列表里也只有它）。
    var roleGrid = $('node-role-grid');
    var showRoles = state.nodes.length >= 1;
    roleGrid.hidden = !showRoles;

    if (showRoles) {
      // ⚠️ 这一列只有 194px 宽（跟上排五列对齐）—— 文案必须短到能一行放下，
      //    长了会折成两行、把整排撑高。
      $('default-node-hint').innerHTML = !multi
        ? '只有一个节点，所有流量走它'
        : (state.autoSelect
          ? (smartGroup
            ? '自动：跟随自动优选组<br>各网站独立节点故障自切'
            : (smartPool.length
              ? '成员只剩一个，直接用它'
              : '成员全取消，默认直连'))
          : '未选中的流量走这个节点');
    }

    // Telegram / AnyDesk 只在回国模式下显示，且关掉回国模式时一并清空
    var appWrap = $('app-direct-wrap');
    if (state.oneipReturnMode) {
      appWrap.hidden = false;
    } else {
      appWrap.hidden = true;
      if (state.anydesk || state.tg) {
        state.anydesk = false;
        state.tg = false;
      }
    }
    $('anydesk').checked = state.anydesk;
    $('tg').checked = state.tg;

    // DNS 卡片：回国 / 国内模式下走内置预设，这里的编辑不生效 ——
    // 必须写在脸上，不然用户改了半天没反应，只会以为坏了。
    var regionalDns = state.mode === 'oneip'
      ? (state.oneipReturnMode || state.oneipMainland)
      : (state.mode === 'split' && state.returnMode);
    $('dns-region-note').hidden = !regionalDns;

    // sniffer：一机一IP 勾了「国内使用国内节点」时引擎那一支恒为 enable: false，整张卡点了都不会
    // 变 —— 整卡收起来；留一个点了没反应的开关，只会让人以为坏了。
    var snifferDead = state.mode === 'oneip' && state.oneipMainland;
    $('sniffer-card').hidden = snifferDead;
    // 只是没勾「启用 sniffer」时**不能**藏整张卡 —— 还得留着它给人重新打开，
    // 那种情况只收起端口 / skip 那几栏。
    $('sniffer-detail-grid').hidden = snifferDead || !state.snifferEnable;
    // 常用规则整块永远显示（TK / TC / AI 任何模式都不隐藏、也不自动清掉）。
    // 本地出口只在精准分流正常模式有意义（回国 / 全局 / 一机一IP 都收起）。
    var localOff = state.mode !== 'split' || returnModeOn() || !!state.globalProxy;
    var local = $('rules-local');
    if (local) {
      local.hidden = localOff;
      local.style.display = localOff ? 'none' : '';
    }
    var split = $('rules-split');
    if (split) split.classList.toggle('no-local', localOff);
    renderLocalExit();
    syncAiCheckbox();
    syncTkCheckbox();
    syncTencentCheckbox();
    syncNfCheckbox();
    syncRuleVisibility();
  }

  // ── 节点列表 ────────────────────────────────────────────────
  // 只读的名字清单：不放类型徽标、服务器地址，也不放 ↑↓✕ 这类行内操作；选节点在默认出口 /
  // 自定义规则的下拉里选。想清空重来就刷新页面 —— 什么都不写 localStorage。
  function renderNodeList() {
    var box = $('node-list');
    box.textContent = '';
    $('node-count').textContent = String(state.nodes.length);
    // 「清空」只在有节点时出现
    var clearBtn = $('clear-nodes');
    if (clearBtn) clearBtn.hidden = !state.nodes.length;

    // 没节点时展开基础设置；导入第一个节点后基础/进阶都收起。
    // 之后不再干预，用户自己展开/收起都保留。
    var basic = $('basic-panel'), adv = $('adv-panel');
    if (basic) {
      var hadNodes = basic.dataset.hadNodes === '1';
      if (!state.nodes.length) {
        basic.open = root.matchMedia('(min-width: 1024px)').matches;
        if (adv) adv.open = false;
      } else if (!hadNodes) {
        basic.open = false;
        if (adv) adv.open = false;
      }
      basic.dataset.hadNodes = state.nodes.length ? '1' : '0';
    }

    var badge = $('step-badge-0');
    badge.textContent = String(state.nodes.length);
    badge.classList.toggle('show', state.nodes.length > 0);

    if (!state.nodes.length) {
      var empty = doc.createElement('div');
      empty.className = 'node-empty';
      empty.textContent = '还没有节点。粘贴链接或上传文件都可以。';
      box.appendChild(empty);
      return;
    }

    // 一串连排、中间用「·」隔开，最多三排；名字太长就整项换行，不截断（读的是全名）。
    state.nodes.forEach(function (node, k) {
      if (k) {
        var sep = doc.createElement('span');
        sep.className = 'node-sep';
        // ⚠️ 两边的空格写成转义：直接敲的空格在某些输入法/编辑器里是 U+00A0（不换行空格），
        //    整串就再也不换行、超出部分被裁掉。
        sep.textContent = ' · ';
        box.appendChild(sep);
      }
      var name = doc.createElement('span');
      name.className = 'node-item';
      name.textContent = node.name;
      name.title = node.name;
      box.appendChild(name);
    });
  }

  /** 本地出口：勾选后国内流量走这个节点；不勾 = 直连（默认）。 */
  function renderLocalExit() {
    var names = state.nodes.map(function (p) { return p.name; });
    var sel = $('local-exit-node');
    var en = $('local-exit-enable');
    var detail = $('local-exit-detail');
    if (!sel || !en) return;
    en.checked = !!state.localExit;
    // 不勾选时底下什么都不显示，勾了才露出节点下拉
    if (detail) {
      detail.hidden = !state.localExit;
      detail.style.display = state.localExit ? '' : 'none';
    }
    if (!names.length) {
      state.localExitNode = '';
      fillSelect(sel, []);
      sel.disabled = true;
      return;
    }
    if (names.indexOf(state.localExitNode) === -1) state.localExitNode = names[0];
    fillSelect(sel, names, state.localExitNode);
    sel.disabled = !state.localExit;
  }

  function renderNodeRoles() {
    var names = state.nodes.map(function (p) { return p.name; });
    if (!names.length) {
      state.defaultNode = '';
      fillSelect($('default-node'), []);
      renderRuleAction([]);
      return;
    }
    var smartOn = state.mode === 'split' && state.autoSelect && names.length >= 2;
    // 关掉智能选择的那一帧强制还原手选出口。必须在这里（界面渲染路径）做，不能放进
    // makeRuleGroups：那是生成路径，改了状态会让「下拉显示 B、配置用 A」错位。
    if (smartWasOn && !smartOn && state.defaultNodeMemory &&
        names.indexOf(state.defaultNodeMemory) !== -1) {
      state.defaultNode = state.defaultNodeMemory;
    }
    smartWasOn = smartOn;
    var smartPool = smartOn ? MH.SplitEngine.smartPool(state.nodes, state.autoSelectExclude) : [];
    // 进智能选择之前先记住用户手选的出口：关掉开关时还原，别让出口自己跳回第一个节点
    if (smartOn && state.defaultNode !== MH.SplitEngine.AUTO_GROUP &&
        state.defaultNode !== 'DIRECT' && names.indexOf(state.defaultNode) !== -1) {
      state.defaultNodeMemory = state.defaultNode;
    }
    if (smartPool.length >= 2) {
      state.defaultNode = MH.SplitEngine.AUTO_GROUP;
      fillSelect($('default-node'), [MH.SplitEngine.AUTO_GROUP], state.defaultNode);
    } else if (smartOn) {
      if (smartPool.length) {
        // 成员只剩一个：默认出口就是它（跟生成的规则一致），下拉只列它
        state.defaultNode = smartPool[0].name;
        fillSelect($('default-node'), [state.defaultNode], state.defaultNode);
      } else {
        // 成员全部取消 → 默认直连
        state.defaultNode = 'DIRECT';
        fillSelect($('default-node'), ['DIRECT'], 'DIRECT');
      }
    } else {
      if (names.indexOf(state.defaultNode) === -1) {
        // 优先还原「开智能选择前那次手选」，它还在就沿用它，否则才回落第一个节点
        var memo = state.defaultNodeMemory;
        state.defaultNode = (memo && names.indexOf(memo) !== -1) ? memo : names[0];
      }
      fillSelect($('default-node'), names, state.defaultNode);
    }
    renderRuleAction(names);
  }

  /**
   * 「智能选择」那张成员框：把所有节点列出来，勾掉的就不进那个 fallback 测速组。
   *   · 只在「智能选择模式」勾着、节点 ≥ 2 时出现；
   *   · 黑名单只记名字，节点被删掉/改名后顺手清掉失效的名字（留着会让「进组数」算错）；
   *   · 全勾掉时不建组、默认出口直连（框里照实显示 0 / N）。
   */
  function renderAutoPool() {
    // 这块排在「默认出口」右边（同一个 grid 里），不占上面那排的高度
    var box = $('strategy-field');
    var poolBox = $('auto-pool-field');
    var list = $('auto-pool-list');
    var names = state.nodes.map(function (p) { return p.name; });
    state.autoSelectExclude = state.autoSelectExclude.filter(function (n) {
      return names.indexOf(n) !== -1;
    });

    // 策略格：智能选择打开，或自定义规则里勾了 2 个以上节点（生成了负载均衡组）时出现；
    // 成员池只对智能选择有意义。
    // 智能选择要真有 ≥2 个成员才算数：3 个节点只留 1 个进组时，组不存在，
    // 「智能选择 / 同组同IP出口」这一格就不该出现（用户 2026-11-16 要求）。
    var smartPoolNow = state.autoSelect
      ? MH.SplitEngine.smartPool(state.nodes, state.autoSelectExclude) : [];
    // 成员框只要开着智能选择就留着 —— 组里只剩 1 个成员时还得能把它加回去
    var smartOn = state.autoSelect && isMulti() && smartPoolNow.length >= 2;
    var groupOn = ruleActions.length >= 2;
    // 只有勾了「智能选择」才把两行固定下来；其余情况仍按负载均衡组按需出现。
    // 当前用不上的那行只禁用勾选，行本身保留，避免整块忽高忽低。
    var oneipMode = state.mode === 'oneip';
    var fixedStrategy = !oneipMode && state.autoSelect && isMulti();
    box.hidden = !(fixedStrategy || groupOn);
    poolBox.hidden = !(state.autoSelect && isMulti());
    poolBox.style.width = '';
    list.textContent = '';
    // 注意：这些元素有 class 上的 display，单靠 hidden 属性会被 CSS 盖掉，必须改 style.display
    var rrRowEl = $('rr-row');
    var lbRowEl = $('lb-row');
    if (rrRowEl && lbRowEl) {
      if (fixedStrategy) {
        rrRowEl.style.display = '';
        lbRowEl.style.display = '';
        var rrDisabled = !smartOn;
        var lbDisabled = !groupOn;
        $('auto-round-robin').disabled = rrDisabled;
        $('lb-round-robin').disabled = lbDisabled;
        rrRowEl.classList.toggle('disabled', rrDisabled);
        lbRowEl.classList.toggle('disabled', lbDisabled);
      } else {
        // 只有负载均衡组时只显示这一行，不把智能选择占位带回来
        rrRowEl.style.display = 'none';
        lbRowEl.style.display = groupOn ? '' : 'none';
        $('auto-round-robin').disabled = true;
        $('lb-round-robin').disabled = !groupOn;
        rrRowEl.classList.add('disabled');
        lbRowEl.classList.toggle('disabled', !groupOn);
      }
    }
    var hintEl = $('strategy-hint');
    if (hintEl) hintEl.style.display = (fixedStrategy || groupOn) ? '' : 'none';
    // 一机一IP 没有「默认出口」，网格只留给策略格；两格都藏时整块也收起来
    var showDefault = state.mode !== 'oneip';
    var roleGrid = $('node-role-grid');
    if (roleGrid) {
      roleGrid.hidden = !state.nodes.length || (!showDefault && box.hidden && poolBox.hidden);
      // 没有「默认出口」那格时，策略格从第 1 列开始铺，不然会孤零零卡在第 2 列
      roleGrid.classList.toggle('no-default', !showDefault);
    }
    var defField = $('default-node-field');
    if (defField) defField.hidden = !showDefault;
    // 一机一IP 把策略格挂到「常用规则」后面（同一行的下一列），省掉单独一行
    var strategyBox = $('strategy-field');
    var rulesGrid = $('rules-split');
    var host = showDefault ? roleGrid : rulesGrid;
    if (strategyBox && host && strategyBox.parentNode !== host) {
      // 回到精准分流时插在「成员」前面，保持 默认出口 → 策略 → 成员 的原顺序；
      // 内网控制时插到「常用规则」后面（同一行再一列）
      var poolField = $('auto-pool-field');
      var localBox = $('rules-local');
      if (host === roleGrid && poolField && poolField.parentNode === roleGrid) {
        roleGrid.insertBefore(strategyBox, poolField);
      } else if (host === rulesGrid && localBox && localBox.parentNode === rulesGrid) {
        rulesGrid.insertBefore(strategyBox, localBox);
      } else {
        host.appendChild(strategyBox);
      }
    }
    if (rulesGrid) rulesGrid.classList.toggle('has-strategy', !showDefault && !!(strategyBox && !strategyBox.hidden));
    // 排到「常用规则」后面时改成「小节标题 + 一个带备注的勾选框」，跟旁边那一列同构
    if (box.hidden) return;
    // 成员框必须填：即使组里只剩 1 个（smartOn 为假）也要把节点列出来，否则框里是空的
    if (!(state.autoSelect && isMulti())) return;

    var excluded = state.autoSelectExclude;

    // 跟「节点列表」同一套显示：一串、中间用「·」隔开。每一项可以点：点一下切换进/不进测速组，
    // 被点掉的变灰 + 删除线。
    state.nodes.forEach(function (node, k) {
      if (k) {
        var sep = doc.createElement('span');
        sep.className = 'node-sep';
        sep.textContent = ' · ';
        list.appendChild(sep);
      }
      var item = doc.createElement('span');
      item.className = 'pool-item' + (excluded.indexOf(node.name) === -1 ? '' : ' off');
      item.textContent = node.name;
      item.title = node.name + (excluded.indexOf(node.name) === -1 ? '（进组）' : '（不进组）');
      item.setAttribute('data-name', node.name);
      list.appendChild(item);
    });
    alignPoolWidth();
    // 这一帧里列表刚铺好，某些浏览器量出来的行宽还是旧的 —— 下一帧再贴一次
    root.requestAnimationFrame(alignPoolWidth);
  }

  /**
   * 节点框的右边对齐到「官网：AdBlock Filters」这段字的右端。字的实际宽度会随字体 / 缩放变，
   * 所以按渲染结果算，不写死像素。
   */
  function alignPoolWidth() {
    var field = $('auto-pool-field');
    var hint = $('adblock-hint');
    if (!field) return;
    // 只有五列并排（≥960px）时才有「贴 Loyalsoldier 右端」这回事；窄屏是堆叠，清掉内联宽度
    var wide = root.matchMedia ? root.matchMedia('(min-width: 960px)').matches : false;
    if (!wide) { field.style.width = ''; return; }
    if (field.hidden || !hint) return;
    var range = doc.createRange();
    range.selectNodeContents(hint);
    var right = range.getBoundingClientRect().right;
    var left = field.getBoundingClientRect().left;
    if (right > left) field.style.width = Math.round(right - left) + 'px';
  }

  function closeRuleMenu() {
    var menu = $('rule-action-menu');
    var btn = $('rule-action-btn');
    if (menu) menu.hidden = true;
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  /**
   * 点一行出口：直连 → 单选 DIRECT 并收起菜单；节点 → 点一下进/出当前选择，只剩一个就是单选，
   * 多个就是负载均衡组。
   */
  function chooseRuleAction(value, names) {
    if (value === 'DIRECT') {
      ruleActions = ['DIRECT'];
      renderRuleAction(names);
      closeRuleMenu();
      return;
    }
    var cur = ruleActions.filter(function (a) { return a !== 'DIRECT'; });
    var i = cur.indexOf(value);
    if (i === -1) cur.push(value); else cur.splice(i, 1);
    ruleActions = cur.length ? cur : ['DIRECT'];
    renderRuleAction(names);
  }

  /** 菜单里的一行（直连 / 某个节点）。 */
  function ruleActionRow(text, value, on, names) {
    var row = doc.createElement('div');
    row.className = 'ms-item' + (on ? ' on' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', on ? 'true' : 'false');
    // 键盘可达：Tab 能停到每一项，Enter / 空格选中，Esc 收起
    row.tabIndex = 0;

    var box = doc.createElement('span');
    box.className = 'ms-box';
    box.textContent = on ? '✓' : '';
    row.appendChild(box);

    var label = doc.createElement('span');
    label.className = 'ms-label';
    label.textContent = text;
    row.appendChild(label);

    row.addEventListener('click', function (e) {
      e.stopPropagation();
      chooseRuleAction(value, names);
    });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        chooseRuleAction(value, names);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        closeRuleMenu();
        var btn = $('rule-action-btn');
        if (btn) btn.focus();
      }
    });
    return row;
  }

  /**
   * 「自定义规则」的出口选择器：一个节点（或直连）→ 规则直接指向它；多个节点 → 生成一个
   * 负载均衡组（同名同成员的规则共用一个组）。选项见 ruleOptions。
   */
  function renderRuleAction(names) {
    var visible = ruleOptions(names);
    // ⚠️ 校验只按「节点还在不在」（names），不按「菜单里能不能选」（visible）——
    //    见 validRuleActions 的注释（否则会把选好的出口悄悄重置成 DIRECT）。
    ruleActions = validRuleActions(ruleActions, names);
    var acts = ruleActions;
    // 出口没选节点时，「常用规则」的 AI / TK / TC / NF 都不能勾
    syncAiCheckbox();
    syncTkCheckbox();
    syncTencentCheckbox();
    syncNfCheckbox();
    // 出口一改，策略与常用规则立刻跟着出现 / 收起
    syncRuleVisibility();

    var label = $('rule-action-label');
    if (label) {
      label.textContent = acts[0] === 'DIRECT' ? '直连'
        : (acts.length === 1 ? acts[0] : acts.length + ' 个节点 · 负载均衡');
    }
    var btn = $('rule-action-btn');
    if (btn) {
      btn.title = acts[0] === 'DIRECT' ? '直连'
        : (acts.length === 1 ? acts[0] : '负载均衡：' + acts.join('、'));
    }

    var menu = $('rule-action-menu');
    if (!menu) return;
    menu.textContent = '';

    menu.appendChild(ruleActionRow('直连', 'DIRECT', acts[0] === 'DIRECT', names));
    visible.forEach(function (name) {
      menu.appendChild(ruleActionRow(name, name, acts.indexOf(name) !== -1, names));
    });
    // 已选的出口如果被 ruleOptions 剔除了（比如它就是当前默认出口），菜单里补一行灰底，
    // 否则标签写着「出口：B」、菜单里却看不到它，用户没法取消。
    acts.forEach(function (name) {
      if (name === 'DIRECT' || visible.indexOf(name) !== -1) return;
      // 说清它为什么不在常规候选里：是默认出口，还是被自动优选排除了
      var why = state.defaultNode === name ? '（当前默认出口）'
        : (state.autoSelect ? '（已并入自动优选）' : '（不在当前候选中）');
      var row = ruleActionRow(name + why, name, true, names);
      row.className += ' muted';
      menu.appendChild(row);
    });
  }

  function fillSelect(sel, names, value) {
    sel.textContent = '';
    if (!names.length) {
      var o = doc.createElement('option');
      o.value = '';
      o.textContent = '（暂无节点）';
      sel.appendChild(o);
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    names.forEach(function (n) {
      var o = doc.createElement('option');
      o.value = n;
      o.textContent = n === 'DIRECT' ? '直连' : n;
      sel.appendChild(o);
    });
    sel.value = names.indexOf(value) !== -1 ? value : names[0];
  }

  /**
   * 「常用规则 → AI」的可用状态：已经有 AI 规则时始终可点（要能取消）；还没有时必须在出口里先
   * 选好至少一个节点，否则置灰。
   */
  /** 「常用规则」与「策略」两块的显隐：跟当前出口 / 预设规则实时联动。 */
  function syncRuleVisibility() {
    var presetOn = state.customRules.some(function (r) {
      return isTkRule(r) || isTencentRule(r) || isAiRule(r);
    });
    var hasExit = ruleActions.some(function (a) { return a !== 'DIRECT'; });
    var commonBox = $('rules-common');
    // 勾不动就不显示：单节点、没选出口、内网控制都一样
    commonBox.hidden = !presetOn && !hasExit;
    var splitEl = $('rules-split');
    if (splitEl) splitEl.classList.toggle('no-common', commonBox.hidden);
    renderAutoPool();
  }

  function syncAiCheckbox() {
    var box = $('common-ai');
    if (!box) return;
    var hasRule = state.customRules.some(isAiRule);
    var hasExit = ruleActions.some(function (a) { return a !== 'DIRECT'; });
    box.checked = hasRule;
    box.disabled = !hasRule && !hasExit;
    box.title = box.disabled ? '先选好节点' : '';
  }

  /** 「常用规则 → TK」：任何模式都显示，没选节点前置灰。 */
  function syncTkCheckbox() {
    var box = $('common-tk');
    if (!box) return;
    var hasRule = state.customRules.some(isTkRule);
    var hasExit = ruleActions.some(function (a) { return a !== 'DIRECT'; });
    box.checked = hasRule;
    box.disabled = !hasRule && !hasExit;
    box.title = box.disabled ? '先选好节点' : '';
  }

  /** 「常用规则 → TC」：任何模式都保留；没选节点就置灰。 */
  function syncTencentCheckbox() {
    var box = $('common-tc');
    if (!box) return;
    var hasRule = state.customRules.some(isTencentRule);
    var hasExit = ruleActions.some(function (a) { return a !== 'DIRECT'; });
    box.checked = hasRule;
    box.disabled = !hasRule && !hasExit;
    box.title = box.disabled ? '先选好节点' : '';
  }

  /** 「常用规则 → NF」：域名 + IP 两条，勾选状态以任一存在为准。 */
  function syncNfCheckbox() {
    var box = $('common-nf');
    if (!box) return;
    var hasRule = state.customRules.some(isNfRule);
    var hasExit = ruleActions.some(function (a) { return a !== 'DIRECT'; });
    box.checked = hasRule;
    box.disabled = !hasRule && !hasExit;
    box.title = box.disabled ? '先选好节点' : '';
  }

  // ── 自定义规则列表 ──────────────────────────────────────────
  /**
   * 一条规则一个 chip：「目标 → 动作」。动作指向的节点要是已被删了，chip 加警示样式 —— 生成时
   * 这条会被丢掉（见 splitCustomRules 的 validActions），得让人看得见。
   */
  function renderRuleList() {
    orderPresetRules();
    var box = $('rule-list');
    box.textContent = '';
    syncAiCheckbox();
    syncTkCheckbox();
    syncTencentCheckbox();
    var names = state.nodes.map(function (p) { return p.name; });
    // 一条都没有时就留空 —— 输入框和「添加」按钮已经说明这里干什么了，再挂个「（空）」纯属噪音。
    if (!state.customRules.length) return;
    state.customRules.forEach(function (item, index) {
      var acts = ruleActionsOf(item);
      var direct = acts.indexOf('DIRECT') !== -1;
      var nodes = acts.filter(function (a) { return a !== 'DIRECT'; });
      var gone = nodes.filter(function (a) { return names.indexOf(a) === -1; });
      var chip = doc.createElement('span');
      chip.className = 'chip' + (gone.length ? ' chip-warn' : '');
      if (gone.length) {
        chip.title = '这些节点已经不在了：' + gone.join('、');
      } else if (nodes.length > 1) {
        chip.title = '负载均衡组：' + nodes.join('、');
      }
      var text = doc.createElement('span');
      var label = direct ? '直连' : (nodes.length === 1 ? nodes[0] : nodes.join(' · '));
      var targetLabel = ruleTargetLabel(item);
      text.textContent = targetLabel + ' → ' + label + (nodes.length > 1 ? '（负载均衡）' : '');
      chip.appendChild(text);
      var x = doc.createElement('button');
      x.type = 'button';
      x.textContent = '×';
      x.title = '移除';
      x.setAttribute('aria-label', '移除 ' + targetLabel);
      x.addEventListener('click', function () {
        state.customRules.splice(index, 1);
        renderRuleList();
        refresh();
      });
      chip.appendChild(x);
      box.appendChild(chip);
    });
  }

  // ── IP 分配预览（一机一IP）────────────────────────────
  /** 网段输入是否已经到可校验的完整形态（照搬 GUI 的 `_net_ready`）。 */
  function netReady(spec) {
    var s = String(spec || '').trim();
    if (!s) return true;
    if (s.charAt(s.length - 1) === '.' || s.charAt(s.length - 1) === '/') return false;
    if (s.indexOf('/') !== -1 && !/^[0-9]+$/.test(s.split('/')[1])) return false;
    return (s.match(/\./g) || []).length >= 2;
  }

  /** 起始 IP 是否已到可校验形态（照搬 GUI 的 `_start_ready`）。 */
  function startReady(spec) {
    var s = String(spec || '').trim();
    if (!s) return true;
    if (/^[0-9]+$/.test(s)) return true;
    if (s.charAt(s.length - 1) === '.') return false;
    return (s.match(/\./g) || []).length === 3;
  }

  function renderIpPreview() {
    var wrap = $('ip-preview');
    var text = $('ip-preview-text');
    wrap.classList.remove('error');
    if (state.mode !== 'oneip') return;
    if (!state.nodes.length) {
      text.textContent = '等待导入节点';
      return;
    }
    var per = String(state.ipsPerNode || '').trim();
    if (!netReady(state.network) || !startReady(state.startIp) || (per && !/^[0-9]+$/.test(per))) {
      text.textContent = '输入中…';
      return;
    }
    var eng = new MH.OneIPEngine();
    eng.network = String(state.network || '').trim() || '192.168.100';
    eng.start_ip = String(state.startIp || '').trim() || '2';
    eng.ips_per_node = MH.sInt(per || '1', 1);
    try {
      text.textContent = eng.ipPreview(state.nodes);
    } catch (e) {
      wrap.classList.add('error');
      text.textContent = e.message;
    }
  }

  // ── 生成配置 ────────────────────────────────────────────────
  function buildConfig() {
    if (!state.nodes.length) throw new Error('请先导入节点');
    var secret = MH.cleanSecret(state.secret) || MH.DEFAULT_SECRET;
    var port = intInRange(state.port, 'UI端口');
    // 监听地址清完是空的（用户删光了）就回落到出厂值 —— 绝不能让
    // `external-controller: :9090` 这种写法落到配置里，mihomo 会起不来。
    var listen = MH.cleanListen(state.controllerListen) || MH.DEFAULT_LISTEN;
    var names = state.nodes.map(function (p) { return p.name; });
    // 动作必须当前有效：指向已被删掉的节点的条目会被丢掉（不回落成直连）
    var rules = splitCustomRules(state.customRules, ['DIRECT'].concat(names));
    // 多节点出口 → 负载均衡组（成员相同的规则共用一个组）
    var groups = makeRuleGroups(rules.nodeRules, names);

    if (state.mode === 'oneip') {
      var one = new MH.OneIPEngine();
      one.proxies = state.nodes;
      one.network = String(state.network || '').trim() || '192.168.100';
      one.start_ip = String(state.startIp || '').trim() || '2';
      one.ips_per_node = intInRange(String(state.ipsPerNode || '1').trim() || '1', '每节点IP');
      one.secret = secret;
      one.port = port;
      one.return_mode = state.oneipReturnMode;
      one.mainland = state.oneipMainland;
      one.redir_host = state.redirHost;
      one.anydesk = state.anydesk;
      one.tg = state.tg;
      one.controller_listen = listen;
      one.stack = MH.SplitEngine.STACKS.indexOf(state.stack) !== -1 ? state.stack : 'mixed';
      one.direct_ips = rules.ips;
      one.direct_domains = rules.domains;
      one.custom_rules = rules.nodeRules;
      one.custom_groups = groups;
      one.ad_block = state.adBlock;
      try {
        applyAdvanced(one);
      } catch (e) {
        if (e && typeof e === 'object') e.adv = true;
        throw e;
      }
      return one.generate();
    }

    var eng = new MH.SplitEngine();
    eng.proxies = state.nodes;
    eng.secret = secret;
    eng.port = port;
    // 智能选择：成员池只剩一个时不建组，默认出口直接指向那个节点（一个节点的负载均衡组没意义）。
    var smartOn = state.autoSelect && state.nodes.length >= 2;
    var smartPool = smartOn ? MH.SplitEngine.smartPool(state.nodes, state.autoSelectExclude) : [];
    var smartGroup = smartPool.length >= 2;
    eng.auto_select = smartGroup;
    // 勾掉的节点不进测速组；全勾掉时不建组，默认出口改直连（上面已经算好）
    eng.auto_select_exclude = state.autoSelectExclude.slice();
    eng.controller_listen = listen;
    eng.ipv6_enabled = state.ipv6;
    eng.stack = MH.SplitEngine.STACKS.indexOf(state.stack) !== -1 ? state.stack : 'mixed';
    eng.direct_ips = rules.ips;
    eng.direct_domains = rules.domains;
    eng.custom_rules = rules.nodeRules;
    eng.custom_groups = groups;
    // 本地出口：只有精准分流正常模式生效（回国 / 全局都有自己的中国规则）
    eng.local_exit = (state.localExit && !state.returnMode && !state.globalProxy)
      ? (names.indexOf(state.localExitNode) !== -1 ? state.localExitNode : names[0])
      : '';
    eng.webrtc_protect = state.webrtc;
    eng.ad_block = state.adBlock;
    eng.global_mode = state.globalProxy;
    // 全局代理与回国模式互斥（GUI 勾选时会互相取消，这里再兜一道底）：两个都开的话，回国模式
    // 那套反转规则会被全局代理的 MATCH 整段盖掉，只会白生成一堆用不上的分流规则。
    eng.return_mode = state.returnMode && !state.globalProxy;
    // 分流面板不提供「国内使用国内节点」（只有一机一IP 有），一律关。
    // 别改成读 state —— 那个值只派生自界面上的勾选框，不该从别处串进来。
    eng.mainland = false;
    eng.redir_host = state.redirHost;
    // 进阶参数在收起的卡片里：出错时打个标记，界面据此自动展开，别再靠「DNS/端口」猜文案
    try {
      applyAdvanced(eng);
    } catch (e) {
      if (e && typeof e === 'object') e.adv = true;
      throw e;
    }

    // 默认出口必须是列表里真实存在的名字 —— 出现「智能选择」这种派生值、或节点被删后留下的旧
    // 名字，写进配置就是引用了一个不存在的 proxy-group / 节点，mihomo 会直接拒绝加载；这里兜一道底。
    var pickNode = function (value) {
      return names.indexOf(value) !== -1 ? value : names[0];
    };
    if (smartGroup) {
      eng.default_node = MH.SplitEngine.AUTO_GROUP;
      return eng.generate();
    }
    if (smartOn) {
      // 成员只剩一个 → 规则直接指向它；全被取消 → 默认直连（都不生成组）
      eng.default_node = smartPool.length ? smartPool[0].name : 'DIRECT';
      return eng.generate();
    }
    if (names.length >= 2) {
      eng.default_node = pickNode(state.defaultNode || names[0]);
      return eng.generate();
    }
    eng.default_node = pickNode(state.defaultNode);
    return eng.generate();
  }

  /**
   * 这份文本里实际写进去几个节点。
   *
   * 导入的节点不等于写进配置的节点：没被默认出口 / 智能选择成员 / 自定义规则 / 负载均衡组引用
   * 的，`SplitEngine._activeProxies()` 会剔掉。界面只念「已导入 5 个」，用户得去 YAML 里数
   * 一遍才知道只带走了 1 个。
   * 只数骨架里那个顶格的 `proxies:` 段（节点项固定两格缩进），不解析整份 YAML —— 只要一个准数，
   * 跑一遍 js-yaml 太重。
   */
  function writtenProxies(text) {
    // 实现放在 core/util.js：单测会用引擎真实产物钉住「块写法」这个前提
    return MH.countProxies(text);
  }

  /** UTF-8 字节数 —— 界面上说「多少 KB」「超过 10 MiB」都得按字节算。 */
  function utf8Bytes(s) {
    s = String(s == null ? '' : s);
    return root.TextEncoder ? new root.TextEncoder().encode(s).length : s.length;
  }

  /**
   * 「进阶参数」（TUN / DNS / 嗅探）里跟出厂默认不一样的有几项。
   * 那一整块默认收起，藏起来的改动不能没人知道，所以标题右边要标「N 项已改」。
   */
  var ADV_KEYS = [
    'stack', 'mtu', 'dnsHijack',
    'autoRoute', 'autoRedirect', 'autoDetectInterface', 'strictRoute',
    'dnsListen', 'dnsDefaultNs', 'dnsNameserver', 'dnsProxyServerNs',
    'dnsDirectNs', 'dnsPolicyCn', 'dnsPolicyGeo',
    'snifferEnable', 'snifferHttpPorts', 'snifferTlsPorts',
    'snifferQuicPorts', 'snifferSkipDomains'
  ];

  function advChangedCount() {
    var def = MH.defaultState();
    var n = 0;
    for (var i = 0; i < ADV_KEYS.length; i++) {
      var k = ADV_KEYS[i];
      var a = state[k], b = def[k];
      var same = (Array.isArray(a) || Array.isArray(b))
        ? JSON.stringify(a || []) === JSON.stringify(b || [])
        : String(a) === String(b);
      if (!same) n += 1;
    }
    return n;
  }

  function renderAdvBadge() {
    var badge = $('adv-badge');
    if (!badge) return;
    var n = advChangedCount();
    badge.hidden = !n;
    badge.textContent = n ? n + ' 项已改' : '';
  }

  /**
   * 重新生成并刷新预览。返回是否生成成功 —— 调用方靠它决定要不要报成功，否则会出现「红色错误刚
   * 弹完又被绿色成功盖掉」。输入过程中的报错只落在预览区、不弹 toast（每敲一个字符弹一次比不给
   * 提示还烦人）。
   */
  function refresh(options) {
    var silent = !options || options.silent !== false;
    var errBox = $('error-box');
    renderAdvBadge();
    if (!state.nodes.length) {
      generated = '';
      renderPreviewEmpty('导入节点后，将自动生成并显示 YAML 配置。');
      statusBase = '等待配置';
      setStatus(statusBase);
      $('preview-size').textContent = '';
      errBox.hidden = true;
      setPreviewActions(false);
      return false;
    }
    var text;
    try {
      text = buildConfig();
    } catch (e) {
      generated = '';
      errBox.hidden = false;
      errBox.textContent = e.message;
      // 失败时必须把预览也清掉。只写错误框的话，屏幕上会留着上一次成功生成
      // 的 YAML 和"N 行 / X KB"，用户会对着那份跟当前设置已经无关的配置干活。
      renderPreviewEmpty('配置生成失败，请修正下方错误后重试。');
      statusBase = '生成失败'; setStatus(statusBase);
      $('preview-size').textContent = '';
      setPreviewActions(false);
      setStatus('生成失败：' + e.message);
      // 报错的是被收起来的「进阶参数」里的字段（DNS / 端口）→ 自动展开，别让人对着一段
      // 红字找不到是哪个框。
      var adv = $('adv-panel');
      var target = e.target ? $(e.target) : null;
      if (target) {
        // 知道是哪个框：它包在 <details> 里就展开那张卡；本来就在主面板上（比如 keep-alive）
        // 就什么都不用做 —— 别去展开一张无关的进阶卡。
        var card = target.closest ? target.closest('details') : null;
        if (card && !card.open) card.open = true;
      } else if (adv && !adv.open && e.adv) {
        adv.open = true;
      }
      if (!silent) toast(e.message, 'err');
      return false;
    }
    errBox.hidden = true;
    generated = text;
    setPreviewActions(true);
    renderPreview(text);
    var lines = text.split('\n').length;
    // 导入的节点不一定全进配置（没被引用的会剔除），所以这里说「已导入」，而且剔掉了几个必须
    // 说出来 —— 否则导 5 个、配置里只有 1 个，用户得去 YAML 里数一遍才发现。
    var written = writtenProxies(text);
    var summary = '节点 ' + state.nodes.length + ' 个 · ' +
      MH.MODES[state.mode].label +
      ' · 配置项 ' + written + ' 条';
    statusBase = '配置已生成 · ' + summary;
    $('preview-size').textContent = lines + ' 行 / ' + formatBytes(utf8Bytes(text));
    // 状态栏只说「生成好了」—— 模式在「规则方案」下拉和预览页顶部都写着，别重复三遍
    setStatus(statusBase);
    return true;
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function renderPreviewEmpty(msg) {
    var pre = $('preview');
    pre.textContent = '';
    var span = doc.createElement('span');
    span.className = 'preview-empty';
    span.textContent = msg;
    pre.appendChild(span);
  }

  /**
   * 预览高亮：逐行判断，只给注释 / 键名 / 引号字符串上色。全部走 textContent 拼节点、不拼 HTML
   * —— 生成的配置里含订阅来的任意文本，用 innerHTML 等于给自己开一个 XSS 口子。
   */
  /**
   * 把一行 YAML 切成 [样式, 文本] 片段。
   * 约束：所有片段按顺序拼接必须与原文**逐字相同** —— 高亮只影响显示，
   * 绝不改动内容（用户 2026-11-17 明确要求）。切不动就抛错，外面回退纯文本。
   *
   * 样式：k 键 / p 标点 / d 列表标记 / s 字符串 / n 数字 / b 布尔 / z 空值 / c 注释
   */
  function yamlTokens(line) {
    var out = [];
    function push(cls, s) { if (s) out.push([cls, s]); }
    var m = /^\s*/.exec(line);
    push(null, m[0]);
    var i = m[0].length;

    // 连续的列表标记：- item、- - nested
    for (;;) {
      var mm = /^-(?:[ \t]+|$)/.exec(line.slice(i));
      if (!mm) break;
      push('d', mm[0]);
      i += mm[0].length;
    }

    var rest = line.slice(i);
    if (rest.charAt(0) === '#') { push('c', rest); return out; }   // 整行注释
    if (!rest) return out;

    // 找值分隔冒号：不在引号内，且后面是空白或行尾
    var keyEnd = -1, q = 0, esc = false;
    for (var j = 0; j < rest.length; j++) {
      var ch = rest.charAt(j);
      if (q) {
        if (q === 34 && ch === '\\' && !esc) { esc = true; continue; }
        if (ch === String.fromCharCode(q) && !esc) q = 0;
        esc = false;
        continue;
      }
      if (ch === '"' || ch === "'") { q = ch.charCodeAt(0); continue; }
      if (ch === ':' && (j + 1 >= rest.length || /\s/.test(rest.charAt(j + 1)))) { keyEnd = j; break; }
    }

    var value;
    if (keyEnd > 0) { push('k', rest.slice(0, keyEnd)); push('p', ':'); value = rest.slice(keyEnd + 1); }
    else if (keyEnd === 0) { push('p', ':'); value = rest.slice(1); }
    else { value = rest; }

    // 行内注释：引号外的 #（前面是空白或行首）才算注释
    var valPart = value, comment = '';
    q = 0; esc = false;
    for (var k = 0; k < value.length; k++) {
      var c2 = value.charAt(k);
      if (q) {
        if (q === 34 && c2 === '\\' && !esc) { esc = true; continue; }
        if (c2 === String.fromCharCode(q) && !esc) q = 0;
        esc = false;
        continue;
      }
      if (c2 === '"' || c2 === "'") { q = c2.charCodeAt(0); continue; }
      if (c2 === '#' && (k === 0 || /\s/.test(value.charAt(k - 1)))) {
        valPart = value.slice(0, k); comment = value.slice(k); break;
      }
    }

    // 单个标量：按类型上色
    function pushScalar(s) {
      // 前后空白原样保留，只对中间那段判类型（行内数组的元素自带空格）
      var lead = /^\s*/.exec(s)[0];
      var rest = s.slice(lead.length);
      var trail = /\s*$/.exec(rest)[0];
      var core2 = rest.slice(0, rest.length - trail.length);
      push(null, lead);
      if (!core2) { push(null, trail); return; }
      if (/^"(?:[^"\\]|\\.)*"$/.test(core2) || /^'(?:[^']|'')*'$/.test(core2)) push('s', core2);
      else if (/^(null|Null|NULL|~)$/.test(core2)) push('z', core2);
      // YAML 1.2 / Mihomo：布尔只有 true/false，yes/no 是普通字符串（用户 2026-11-17 指出）
      else if (/^(true|false|True|False|TRUE|FALSE)$/.test(core2)) push('b', core2);
      else if (/^-?(\d+)(\.\d+)?([eE][+-]?\d+)?$/.test(core2)) push('n', core2);
      else push(null, core2);
      push(null, trail);
    }

    // 行内数组 / 行内对象：括号和逗号算标点，元素仍按标量判类型
    function pushInline(s) {
      var open = s.charAt(0), close = open === '{' ? '}' : ']';
      if (s.charAt(s.length - 1) !== close) return false;
      push('p', open);
      var inner = s.slice(1, -1);
      var parts = inner.split(',');
      for (var x = 0; x < parts.length; x++) {
        var part = parts[x];
        if (open === '{') {
          // 行内对象里的 name: test —— 键也上色，冒号算标点
          var cut = part.indexOf(':');
          if (cut > 0) {
            push('k', part.slice(0, cut));
            push('p', ':');
            pushScalar(part.slice(cut + 1));
          } else {
            pushScalar(part);
          }
        } else {
          pushScalar(part);
        }
        if (x < parts.length - 1) push('p', ',');
      }
      push('p', close);
      return true;
    }

    var vm = /^(\s*)([\s\S]*?)(\s*)$/.exec(valPart);
    push(null, vm[1]);
    var core = vm[2];
    if (core) {
      var ch0 = core.charAt(0);
      var isInline = ch0 === '[' || ch0 === '{';
      if (!(isInline && pushInline(core))) pushScalar(core);
    }
    push(null, vm[3]);
    if (comment) push('c', comment);
    return out;
  }

  /**
   * 预览渲染：逐行切词后拼 DOM。任何一行切失败都整行回退成纯文本，
   * 绝不因为高亮出错而丢内容或改变内容。
   */
  function renderPreview(text) {
    var pre = $('preview');
    pre.textContent = '';
    var frag = doc.createDocumentFragment();
    var lines = text.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // 行号列只做视觉定位：user-select:none，复制时不会带进 YAML
      var row = doc.createElement('div');
      row.className = 'ln';
      var no = doc.createElement('span');
      no.className = 'ln-no';
      no.textContent = String(i + 1);
      var body = doc.createElement('span');
      body.className = 'ln-body';

      var toks = null;
      try { toks = yamlTokens(line); } catch (e) { toks = null; }
      if (!toks) {
        body.textContent = line;   // 切词失败整行回退成纯文本
      } else {
        for (var t = 0; t < toks.length; t++) {
          if (toks[t][0]) {
            var sp = doc.createElement('span');
            sp.className = toks[t][0];
            sp.textContent = toks[t][1];
            body.appendChild(sp);
          } else {
            body.appendChild(doc.createTextNode(toks[t][1]));
          }
        }
      }
      row.appendChild(no);
      row.appendChild(body);
      frag.appendChild(row);
    }
    pre.appendChild(frag);
  }

  // ── 导入 ────────────────────────────────────────────────────
  function importText(text, source) {
    if (utf8Bytes(text) > MAX_SUB_BYTES) {
      toast('内容超过 10 MiB 限制，已终止导入。', 'err');
      return false;
    }
    var nodes;
    try {
      nodes = MH.parseAnyInput(text);
    } catch (e) {
      toast('解析失败：' + e.message, 'err');
      return false;
    }
    if (!nodes.length) {
      // 输入看着像 Clash YAML 但没解析出来：把真正的原因带出来，别只说"没节点"
      var yamlErr = MH.yamlError();
      if (yamlErr) {
        toast('输入的 Clash YAML 格式有误：' + yamlErr, 'err');
        return false;
      }
      // 全被过滤掉了：计数器涵盖「类型不支持 / 主机或端口不合法 / 缺凭据」三类，
      // 文案别再只说「类型」，否则用户拿着端口写错的 YAML 会被引到错误方向。
      var droppedNodes = MH.yamlDropped ? MH.yamlDropped() : 0;
      if (droppedNodes) {
        toast(droppedNodes + ' 个节点被跳过（类型不受支持 / 主机或端口不合法 / 缺少必填凭据）。', 'err');
        return false;
      }
      // 全是 SS-2022 但密钥不对：内核会直接拒载整份配置，所以这类节点只能丢；
      // 但必须说清楚原因，否则用户只看到「未检测到有效节点」
      var badKeys = MH.badKeys ? MH.badKeys() : 0;
      if (badKeys) {
        var info = (MH.badKeyInfo && MH.badKeyInfo().length) ? '（' + MH.badKeyInfo().join('；') + '）' : '';
        toast(badKeys + ' 个 SS-2022 节点的密钥格式或长度不对（需 16/32 字节的 base64），已全部跳过。' + info, 'err');
        return false;
      }
      toast('未检测到有效节点，请检查分享链接或订阅内容。', 'err');
      return false;
    }
    var added = MH.addNodes(state, nodes);
    // 新节点进来后按**当前节点表**核一遍规则（详见 pruneRules）。
    var dropped = pruneRules();
    var droppedNote = dropped ? '（已清掉 ' + dropped + ' 条指向已删节点的规则）' : '';
    renderNodeList();
    renderNodeRoles();
    if (dropped) renderRuleList();
    afterNodeChange();
    // 密码里带了没转义的 `#` 的链接，解析器会自动补上转义（见 parsers.js 的
    // fixUnescapedHash）。这等于替用户改了输入，得说一声 —— 免得他以为密码被读错了。
    var repaired = MH.hashRepairs();
    var droppedNodes = MH.yamlDropped ? MH.yamlDropped() : 0;
    var badKeys = MH.badKeys ? MH.badKeys() : 0;
    var note = droppedNote
      + (droppedNodes ? '（跳过 ' + droppedNodes + ' 个节点：类型 / 主机端口 / 凭据不合法）' : '')
      + (badKeys ? '（跳过 ' + badKeys + ' 个 SS-2022 节点：密钥格式或长度不对，需 16/32 字节 base64）' : '')
      + (repaired ? '（已自动修正 ' + repaired + ' 条链接里未转义的 #）' : '');
    if (added === 0) {
      // 防御性分支：正常流程在 !nodes.length 时已带原因早退，这里理论上恒 ≥1；
      // 留着是为了将来若有人改掉早退，也不会说出「0 个节点均已存在」这种话。
      toast(nodes.length
        ? ('未新增节点，解析出的 ' + nodes.length + ' 个节点均已存在。' + note)
        : ('没有解析出可用节点。' + note));
    } else if (added < nodes.length) {
      toast('已成功导入 ' + added + ' 个节点，跳过 ' + (nodes.length - added) + ' 个重复节点。' + note, 'ok');
    } else {
      toast('已成功导入 ' + added + ' 个节点。' + note, 'ok');
    }
    return true;
  }

  /**
   * 按当前节点表核一遍自定义规则：动作指向的节点不在了，那条规则这辈子都不会生效（生成时会被
   * splitCustomRules 丢掉，界面上是红色警示 chip）。导入新节点、清空节点之后都要跑它；动作是
   * DIRECT 的不动 —— 它跟节点无关，跨会话仍然有意义。
   *
   * ⚠️ 节点不留浏览器、规则留：只在生成时丢、界面留着的话，关掉浏览器再打开、导入另一套节点
   * 之后，上次那批规则全变红赖在列表里。返回被清掉的条数（导入 / 清空时要告诉用户）。
   */
  function pruneRules() {
    var alive = state.nodes.map(function (n) { return n.name; });
    var before = state.customRules.length;
    state.customRules = state.customRules.map(function (r) {
      var acts = ruleActionsOf(r).filter(function (a) {
        return a === 'DIRECT' || alive.indexOf(a) !== -1;
      });
      if (!acts.length) return null;
      if (acts.indexOf('DIRECT') !== -1) acts = ['DIRECT'];
      return { target: r.target, type: r.type, preset: r.preset, actions: acts };
    }).filter(Boolean);
    return before - state.customRules.length;
  }

  /**
   * 清空节点列表（卡头那颗「清空」）。节点是从链接 / 文件导入的，本来没有「删一个」的地方，
   * 贴错一条只能整页刷新重来、把另外三十条也一起丢了，所以只做全清、不做单条删除。
   * ⚠️ 规则里指向节点的动作一并清掉（跟导入新节点同一套规矩），DIRECT 规则留着。
   */
  function clearNodes() {
    if (!state.nodes.length) return;
    // 直接清，不弹确认框（用户要求）
    state.nodes = [];
    state.autoSelectExclude = [];
    state.defaultNode = '';
    state.localExitNode = '';
    state.localExit = false;      // 没有节点了，"国内出口"没有意义
    pruneRules();
    renderRuleList();
    afterNodeChange();
    toast('节点列表已清空。', 'ok');
  }

  /**
   * 节点增删之后的统一收尾，调用时 state.nodes 必须已经改完。三个渲染函数各管一摊：
   *   - `renderOptionVisibility()` 决定「路由模式 / 应用直连」这两块控件的显隐；
   *   - `renderNodeRoles()` 按当前节点集合重建「默认出口」和「自定义规则·动作」两个下拉；
   *   - `renderNodeList()` 刷新可见节点列表和计数徽标，漏了列表里就会留着已删的节点。
   * 后两个谁先谁后无所谓：一个写下拉、一个写列表，互不相干。
   */
  function afterNodeChange() {
    renderOptionVisibility();
    renderNodeRoles();
    renderNodeList();
    renderIpPreview();
    refresh();
  }

  function readFile(file) {
    if (!file) return;
    // ⚠️ 先看大小再读：readAsText 是整个读进内存，几 MB 的订阅会把标签页卡死 / OOM，
    //    等读完再判长度就晚了。
    if (file.size > MAX_SUB_BYTES) {
      toast('文件超过 10 MiB 限制，已终止导入。', 'err');
      return;
    }
    var reader = new root.FileReader();
    reader.onload = function () {
      var text = String(reader.result || '').replace(/^﻿/, '');   // 去掉 BOM
      $('file-note').textContent = '已读取 ' + file.name + '（' + formatBytes(utf8Bytes(text)) + '）';
      importText(text, '文件');
    };
    reader.onerror = function () { toast('文件读取失败，请检查文件后重试。', 'err'); };
    reader.readAsText(file, 'utf-8');
  }

  // ── 主题 ────────────────────────────────────────────────────
  function applyTheme() {
    var theme = state.theme;
    if (!theme) {
      // 宿主 ?theme= > 面板绿点的记号 > 系统（见 app/theme-hint.js）
      theme = (root.MHTheme && (root.MHTheme.hint() || root.MHTheme.system())) || 'light';
    }
    doc.documentElement.setAttribute('data-theme', theme);
    // 明暗由宿主（LuCI 的 ?theme=）/ 系统决定，页面上没有切换按钮；版本号在状态栏右下角，见 init()。
  }

  // ── 步骤切换 ────────────────────────────────────────────────
  function showStep(index) {
    var sections = doc.querySelectorAll('.step');
    for (var i = 0; i < sections.length; i++) {
      sections[i].classList.toggle('active', parseInt(sections[i].dataset.step, 10) === index);
    }
    var btns = doc.querySelectorAll('.step-btn');
    for (var j = 0; j < btns.length; j++) {
      btns[j].setAttribute('aria-current', parseInt(btns[j].dataset.step, 10) === index ? 'true' : 'false');
    }
    root.scrollTo({ top: 0, behavior: 'smooth' });
    // 设置页之前藏着的时候量不到宽度，切过来以后补一次
    root.requestAnimationFrame(function () {
      if (!$('auto-pool-field').hidden) alignPoolWidth();
    });
  }

  // ── 事件绑定 ────────────────────────────────────────────────
  function bindCheckbox(id, key, after) {
    var el = $(id);
    el.checked = !!state[key];
    on(el, 'change', function () {
      state[key] = el.checked;
      if (after) after();
      renderOptionVisibility();
      renderNodeRoles();
      renderIpPreview();
      refresh();
    });
  }

  function bindInput(id, key, after) {
    var el = $(id);
    el.value = state[key];
    on(el, 'input', function () {
      state[key] = el.value;
      if (after) after();
      renderIpPreview();
      refresh();
    });
  }

  /**
   * 紧急开关：连点右下角的版本号 3 次（或地址带 `?rotate=1`）→ 把工具密码换成一把新的
   * （就是分发给别人用的那把；面板密码不动）。
   *
   * ⚠️ 为什么要有它：登录门在两把钥匙都记着时是悄悄放行的（绿点那条），根本不弹框，门上那套
   * 「故意输错」平时按不到 —— 这里才是随手可用的入口。做成隐形手势是因为作废密码这件事不能让
   * 旁边人看出来。
   * ⚠️ 真正动手的是路由器上的 CGI（`MHApply.rotate` → `mihomo-apply?rotate=1`）：现生成一把新
   * 工具密码写进 `/etc/mihomo-toolpass`，哈希写进 `config/toolhash.txt`（门每次 no-store 现拉，
   * 所以立刻生效）。
   */
  function bindSecretRotate() {
    var spot = $('status-version');
    if (!spot) return;
    // ⚠️ 窗口原本 900ms 太紧，点慢一拍就悄悄归零、什么都不发生，所以放宽到 1500ms。
    // ⚠️ 加 `?rotdbg=1` 时每点一下都报「第几下」，好确认到底点上没有。
    var dbg = /[?&]rotdbg=1/.test(root.location.search || '');
    var hits = 0, timer = null;
    on(spot, 'click', function () {
      hits++;
      if (timer) root.clearTimeout(timer);
      if (hits >= 3) {
        hits = 0;
        rotateNow();
        return;
      }
      if (dbg) toast('换密码：已点 ' + hits + ' / 3 下（再快点连点）', 'ok');
      timer = root.setTimeout(function () { hits = 0; }, 1500);
    });
  }

  // ⚠️ `?rotate=1` 这个口子必须在门外面挂 —— 它当初写在 bindEvents() 里，而 bindEvents() 要等
  //     过完门、ui.init() 跑起来才执行。可用户是直接把带参数的地址粘到地址栏打开的，那正好是
  //     「没从绿点来」的情况：门会弹、init() 压根不跑 ⇒ 什么都不发生。
  //     DOMContentLoaded 时 apply.js 已经跑过了（它在 </body> 前），MHApply 拿得到。
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', rotateByUrl);
  else rotateByUrl();

  /**
   * 紧急开关的第二个触发口：地址后面带 `?rotate=1` —— 确认后把工具密码换掉。
   *
   * ⚠️ 为什么还要有它：连点版本号 3 下要手速（1.5 秒内点满），点慢了什么都不发生；带参数这个
   * 是确定能中的一次。
   * ⚠️ 换完立刻把参数从地址栏抹掉（replaceState），否则按一下 F5 就再换一次。
   * ⚠️ 必须在所有脚本都加载完之后才跑（要用 apply.js 的 MHApply），所以由 bindSecretRotate 调。
   */
  function rotateByUrl() {
    // ⚠️ 先挡一道：测试环境里没有 location（tests/helpers/load.mjs 只塞了个空 document），少了
    //    这个判断，底下那行会在加载时抛错，整个 ui.js 就挂在一个 unhandled error 上、一票测试全红。
    var loc = root.location;
    if (!loc || typeof loc.search !== 'string') return;
    var q = loc.search;
    if (!/[?&]rotate=1(&|$)/.test(q)) return;
    // ⚠️ 链接一点就换太狠了：机主登着面板时，别人塞过来一个带 ?rotate=1 的链接，
    //    点一下就把他发出去的工具密码作废了。先问一句（取消 = 什么都不做，参数照样抹掉）。
    var go = true;
    try {
      if (root.confirm) go = root.confirm('要通过链接更换工具密码？' + String.fromCharCode(10, 10) + '换完，发出去的旧密码立刻作废。');
    } catch (e) { go = true; }
    try {
      var clean = q.replace(/[?&]rotate=1(&|$)/g, '&').replace(/^&/, '?').replace(/[?&]$/, '');
      if (root.history && root.history.replaceState) {
        root.history.replaceState(null, '', loc.pathname + clean + loc.hash);
      }
    } catch (e) { /* 改不了就算了，只是别刷新 */ }
    if (go) rotateNow();
  }

  function rotateNow() {
    // ⚠️ 整条链一声不响 —— 旁边有人看着的时候，弹个「已换掉面板密码」就等于把这事喊出来了。
    //    成败看「设置 → 面板密码」那格：换成了就是新的一串，没变就是没成。
    // ⚠️ 静默的代价是卡住了也看不出来，所以留了两条诊断通道（都不影响隐蔽性）：控制台里
    //    `[rotate] …` 一直有；加 `?rotdbg=1` 时每一步也弹出来（排查用，平时别开）。
    var dbg = /[?&]rotdbg=1/.test(root.location.search || '');
    function say(msg, kind) {
      if (root.console && root.console.log) root.console.log('[rotate] ' + msg);
      // ⚠️ 失败一定弹出来，成功才静默：静默是给「旁边有人看着」用的，而失败不吭声就成了
      //    「点了半天没反应」的黑盒。
      if (dbg || kind === 'err') toast('换密码：' + msg, kind || 'err');
    }

    var old = MHSecret.read();
    if (!old) { say('手里没有当前密码（这台没登录过面板、也没过过门）', 'err'); return; }
    if (!root.MHApply || typeof root.MHApply.rotate !== 'function') {
      say('MHApply 没就绪（apply.js 没加载？）', 'err');
      return;
    }

    say('开始：拿手里的旧密码去认证写盘口…', 'ok');
    root.MHApply.rotate(old).then(function (text) {
      var m = /^rotated[ \t]+(\S+)/m.exec(text || '');
      if (!m) { say('写盘口回了看不懂的东西：' + String(text).slice(0, 60), 'err'); return; }
      var fresh = m[1];
      // ⚠️ 换回来的是工具密码（不是面板密码），所以只更新本机记着的那把工具密码（好让这台继续
      //    过门），面板密码和生成器那格一律不动；别人手里那把旧的当场作废，要发新的去 `sh -s p` 看。
      try { root.localStorage.setItem('mihomo-gen-tool', fresh); } catch (e) { /* 存不下就算了 */ }
      say('成了 —— 工具密码已换成新的一把（旧的那把作废了，面板不受影响）', 'ok');
    }, function (e) {
      say('没成：' + ((e && e.message) || e), 'err');
    });
  }

  /**
   * 「面板密码」旁边那个「随机」按钮 —— 填一串强随机进去。
   * ⚠️ 填完派一个 input 事件，让 bindInput 那套照常跑；密码就在上面那格里，提示里只需说清
   * 「要去面板重新登录」。
   */
  function bindSecretGen() {
    var btn = $('secret-gen');
    if (!btn) return;
    on(btn, 'click', function () {
      var el = $('secret');
      el.value = MH.randomSecret(16);
      el.dispatchEvent(new root.Event('input', { bubbles: true }));
      // ⚠️ 不弹提示、静默：新密码就在上面那格里，
      //    看得见、复制得走。要它生效还得点「载入配置文件」。
    });
  }

  /**
   * 多行文本 ↔ 列表（DNS 各组、dns-hijack、sniffer 端口 / skip-domain 都用它）。
   * 和 bindInput 的区别：只在绑定的那一刻把列表写成文本，之后不再回写 —— 每敲一个字就回写 value
   * 会把光标顶到末尾。解析成空数组交给引擎，引擎侧 `listOr` 会回落成出厂值。
   */
  function bindTextareaList(id, key) {
    var el = $(id);
    el.value = (state[key] || []).join('\n');
    on(el, 'input', function () {
      state[key] = listFromText(el.value);
      refresh();
    });
  }

  function bindEvents() {
    // 规则方案（rules 卡片顶部的下拉）
    on($('mode-select'), 'change', function () {
      var next = this.value;
      if (next !== state.mode) {
        // 两套方案完全隔离：切走时把「正要离开的那套」的设置全部还原成出厂值，
        // 切回来是干净的（用户 2026-11-16 要求：随时切换、清前者所有设置）。
        var d = MH.defaultState ? MH.defaultState() : {};
        var SPLIT_ONLY = ['globalProxy', 'localExit', 'autoSelect', 'autoSelectExclude',
          'returnMode', 'webrtc', 'autoRoundRobin', 'lbRoundRobin'];
        var ONEIP_ONLY = ['oneipReturnMode', 'oneipMainland', 'tg', 'anydesk'];
        var leaving = state.mode === 'split' ? SPLIT_ONLY : ONEIP_ONLY;
        for (var i = 0; i < leaving.length; i++) {
          if (Object.prototype.hasOwnProperty.call(d, leaving[i])) state[leaving[i]] = d[leaving[i]];
        }
        // 换方案就把另一套的开关清掉：否则「精准分流」里勾的全局代理 / 本地出口 / 智能选择
        // 会留到「内网控制」，反之回国 / 国内节点也会留回来（用户 2026-11-16 报）。
        if (next === 'oneip') {
          state.globalProxy = false;
          state.localExit = '';
          state.autoSelect = false;
          state.autoSelectExclude = [];
        } else {
          state.oneipReturnMode = false;
          state.oneipMainland = false;
        }
        // 自定义规则也清：两套方案的规则语义不同（精准分流按域名/ IP，内网控制按源 IP 分节点），
        // 留过来会生成看不懂的配置（用户 2026-11-16 要求来回切换时清掉）。
        state.customRules = [];
        ruleActions = ['DIRECT'];
        // 策略格（负载均衡 / 同组同IP出口）连同它的列一起收掉，别留在规则区
        var sf = $('strategy-field');
        if (sf) sf.hidden = true;
        var rg = $('rules-split');
        if (rg) rg.classList.remove('has-strategy');
        // 两个调度勾也复位：不然切过去再选多节点时，负载均衡 / 同组同IP出口 会自己勾上
        state.autoRoundRobin = false;
        state.lbRoundRobin = false;
        $('auto-round-robin').checked = false;
        $('lb-round-robin').checked = false;
      }
      state.mode = next;
      // 一机一IP 里所有节点都能进组；切回精准分流要按反选集合收一遍
      if (state.mode === 'split') syncCustomRulesWithExclude();
      // 切换方案后刷新 TK/TC/AI 勾选状态（三项都保留，不再自动清）
      renderRuleList();
      renderMode();
      renderOptionVisibility();
      renderNodeRoles();
      renderIpPreview();
      refresh();
    });

    // 步骤导航
    var stepBtns = doc.querySelectorAll('.step-btn');
    for (var j = 0; j < stepBtns.length; j++) {
      on(stepBtns[j], 'click', function () {
        showStep(parseInt(this.dataset.step, 10));
      });
    }

    // 主题：明暗由宿主（LuCI）/ 系统决定，页面上不再放切换按钮

    // 通用设置
    bindInput('secret', 'secret');
    // ⚠️ 必须排在 bindInput('secret') 后面：它是靠派 input 事件复用上面那套处理的
    bindSecretGen();
    bindSecretRotate();   // 连点标题 3 次的紧急开关（作废泄露的密码）
    bindInput('port', 'port');
    bindInput('controller-listen', 'controllerListen');
    bindCheckbox('redir-host', 'redirHost');

    // 分流设置
    bindInput('stack', 'stack');
    bindCheckbox('ipv6', 'ipv6');
    bindCheckbox('webrtc', 'webrtc');
    bindCheckbox('blklist', 'adBlock');
    bindCheckbox('auto-select', 'autoSelect', function () {
      var names = state.nodes.map(function (p) { return p.name; });
      if (state.autoSelect) {
        // 智能选择模式下默认出口固定是测速组
        if (state.nodes.length >= 2) state.defaultNode = MH.SplitEngine.AUTO_GROUP;

        // 打开智能选择 = 没反选的节点都进组 → 多选组里那些节点要摘掉
        syncCustomRulesWithExclude();
        renderRuleList();
      } else {
        if (names.indexOf(state.defaultNode) === -1) state.defaultNode = names[0] || '';

      }
    });
    // 智能选择：点节点名 = 这个节点进/不进测速组（事件委托，项是动态生成的）
    on($('auto-pool-list'), 'click', function (e) {
      var el = e.target;
      while (el && el !== e.currentTarget && String(el.className || '').indexOf('pool-item') === -1) {
        el = el.parentNode;
      }
      if (!el || el === e.currentTarget) return;
      var name = el.getAttribute('data-name');
      if (!name) return;
      var i = state.autoSelectExclude.indexOf(name);
      if (i === -1) state.autoSelectExclude.push(name);
      else state.autoSelectExclude.splice(i, 1);
      // 反选集合变了 → 自定义多选组里"回到智能组"的节点要摘掉（否则显示与产物对不上）
      syncCustomRulesWithExclude();
      renderRuleList();
      // 圆片状态（灰/删除线）、提示、出口菜单的选项一起刷新
      renderOptionVisibility();
      // 成员只剩一个时，默认出口下拉要改指那个节点（不再是「智能选择」）
      renderNodeRoles();
      refresh();            // 重新生成 + 刷预览
    });
    // 精准分流里的一对互斥开关，跟下面一机一IP 的回国 / 国内是同一个做法：
    // 勾上一个就把另一个取消掉，别让用户配出一份自相矛盾的规则。
    bindCheckbox('return-mode', 'returnMode', function () {
      if (state.returnMode) state.globalProxy = false;
      renderRuleList();
    });
    bindCheckbox('global-proxy', 'globalProxy', function () {
      if (state.globalProxy) state.returnMode = false;
      renderRuleList();
    });

    // 一机一IP
    bindInput('network', 'network');
    bindInput('start-ip', 'startIp');
    bindInput('ips-per-node', 'ipsPerNode');
    bindCheckbox('oneip-return-mode', 'oneipReturnMode', function () {
      if (state.oneipReturnMode) state.oneipMainland = false;
      renderRuleList();
    });
    bindCheckbox('oneip-mainland', 'oneipMainland', function () {
      if (state.oneipMainland) state.oneipReturnMode = false;
      renderRuleList();
    });
    bindCheckbox('anydesk', 'anydesk');
    bindCheckbox('tg', 'tg');

    // ── 进阶参数 ──
    // 基础
    bindInput('log-level', 'logLevel');
    bindInput('find-process-mode', 'findProcessMode');
    bindCheckbox('unified-delay', 'unifiedDelay');
    bindCheckbox('tcp-concurrent', 'tcpConcurrent');
    bindCheckbox('auto-round-robin', 'autoRoundRobin');
    bindCheckbox('lb-round-robin', 'lbRoundRobin');
    // 视口宽度变了，「Loyalsoldier」那行字的右端也跟着变 —— 重新贴一次节点框的右边
    on(root, 'resize', function () {
      if (!$('auto-pool-field').hidden) alignPoolWidth();
    });
    bindInput('keep-alive-idle', 'keepAliveIdle');
    bindInput('keep-alive-interval', 'keepAliveInterval');
    // TUN
    bindCheckbox('auto-route', 'autoRoute');
    bindCheckbox('auto-redirect', 'autoRedirect');
    bindCheckbox('auto-detect-interface', 'autoDetectInterface');
    bindCheckbox('strict-route', 'strictRoute');
    bindInput('mtu', 'mtu');
    bindTextareaList('dns-hijack', 'dnsHijack');
    // DNS
    bindInput('dns-listen', 'dnsListen');
    bindTextareaList('dns-default-ns', 'dnsDefaultNs');
    bindTextareaList('dns-nameserver', 'dnsNameserver');
    bindTextareaList('dns-proxy-server-ns', 'dnsProxyServerNs');
    bindTextareaList('dns-direct-ns', 'dnsDirectNs');
    bindTextareaList('dns-policy-cn', 'dnsPolicyCn');
    bindTextareaList('dns-policy-geo', 'dnsPolicyGeo');
    // sniffer
    bindCheckbox('sniffer-enable', 'snifferEnable');
    bindTextareaList('sniffer-http-ports', 'snifferHttpPorts');
    bindTextareaList('sniffer-tls-ports', 'snifferTlsPorts');
    bindTextareaList('sniffer-quic-ports', 'snifferQuicPorts');
    bindTextareaList('sniffer-skip-domains', 'snifferSkipDomains');

    // 默认出口
    on($('default-node'), 'change', function () {
      state.defaultNode = this.value;
      // 默认出口变了 → 自定义规则里能选的节点也跟着变（占用的那个要藏起来）
      renderNodeRoles();
      refresh();
    });

    // 本地出口：勾上才启用节点下拉；不勾 = 国内直连
    bindCheckbox('local-exit-enable', 'localExit');
    on($('local-exit-node'), 'change', function () {
      state.localExitNode = this.value;
      refresh();
    });

    // 导入：上传文件入口。用真正的 <button> 去点隐藏的 file input —— <label> 套 hidden input 的
    // 老做法里 input 被移出 Tab 序列、label 又不可聚焦，纯键盘用户根本触发不了。
    on($('file-btn'), 'click', function () { $('file-input').click(); });
    // 清空节点 / 两步「下一步」
    on($('clear-nodes'), 'click', clearNodes);
    on($('file-input'), 'change', function () {
      readFile(this.files && this.files[0]);
      this.value = '';
    });
    on($('links-add'), 'click', function () {
      var text = $('links-input').value.trim();
      if (!text) return toast('请先粘贴至少一条节点链接。', 'err');
      // 失败（超限 / 解析不出来 / 没节点）时**保留**用户粘的内容，别让他白粘一遍
      if (importText(text, '粘贴内容')) {
        $('links-input').value = '';
        autoGrow($('links-input'), 8);   // 清空后缩回一行
      }
    });
    // 贴进来的东西多长，框就多高（最多 8 行，再多在框里滚）
    on($('links-input'), 'input', function () { autoGrow(this, 8); });
    on($('links-input'), 'paste', function () {
      var el = this;
      // 粘贴是同步塞进去的，但 value 要到下一帧才稳（个别浏览器）—— 两个时机都量一次
      root.setTimeout(function () { autoGrow(el, 8); }, 0);
    });

    // 自定义规则：一条 = 目标（域名 / IP）+ 动作（某个节点 或 直连）。
    // ⚠️ 一次可以进来一串（换行 / 逗号 / 分号 / 空格都算分隔），切分在 state.js 里（能单测）。
    function addRules(text) {
      var targets = MH.splitRuleTargets(text);
      if (!targets.length) return 0;
      var acts = ruleActions.length ? ruleActions.slice() : ['DIRECT'];
      var key = acts.slice().sort().join('\u0000');
      var added = 0;
      targets.forEach(function (target) {
        // 手输 `geosite:<分类>` 也认，存成 {type:'geosite'} —— 生成 `GEOSITE,<分类>,<出口>`
        var cat = geositeCategory(target);
        var entry = cat
          ? { target: cat, type: 'geosite', actions: acts.slice() }
          : { target: target, actions: acts.slice() };
        // 「目标 + 出口组合」都一样才算重复。同一个目标配不同出口是有意义的，别按目标去重。
        var dup = state.customRules.some(function (r) {
          return r.target === entry.target && (r.type || '') === (entry.type || '') &&
            ruleActionsOf(r).slice().sort().join('\u0000') === key;
        });
        if (!dup) { state.customRules.push(entry); added++; }
      });
      if (added) { renderRuleList(); refresh(); }
      return added;
    }
    // ⚠️ 点了「添加」就把输入框清掉，不管加进去几条；全是重复时给个提示 —— 不然看起来像点了没反应。
    function addRule() {
      var targets = MH.splitRuleTargets($('rule-target').value);
      if (!targets.length) return;                 // 空的：什么都不做，也别清（本来就没内容）
      // IP 段起止反了（或八位组越界）：引擎会整条丢掉，用户看到的却是「加进去了没反应」
      var badRange = targets.filter(function (t) {
        return MH.classify(t) === 'ip' && t.indexOf('-') !== -1 && !MH.ipRangeToCidrs(t);
      });
      if (badRange.length) {
        // IPv6 段是「不支持」而不是「写反了」：ipRangeToCidrs 只做 v4，文案要分开
        var v6Range = badRange[0].indexOf(':') !== -1;
        toast(v6Range
          ? ('IPv6 段暂不支持（' + badRange[0] + '）：请改用 CIDR，例如 fd00::/64')
          : ('IP 段起止反了或地址不合法（' + badRange[0] + '），请写成 192.168.1.10-192.168.1.20'), 'err');
        return;
      }
      var withPort = targets.filter(function (t) { return MH.hasHostPort(t); });
      if (withPort.length) {
        toast('规则目标不接受端口（' + withPort[0] + '）：请去掉 :端口 再添加', 'err');
        return;
      }
      var badIp = targets.filter(function (t) { return MH.looksLikeBadIp(t); });
      if (badIp.length) {
        toast('IP / CIDR 写法不合法（' + badIp[0] + '）：请写成 192.168.0.0/16 或 192.168.1.10', 'err');
        return;
      }
      // 内网控制只按源 IPv4 分流（该模式强制关闭 IPv6），IPv6 目标写进来只会是一条死规则
      if (state.mode === 'oneip') {
        var v6s = targets.filter(function (t) { return MH.isV6Target(t); });
        if (v6s.length) {
          toast('内网控制只支持 IPv4（该模式已关闭 IPv6）：' + v6s[0]
            + ' —— 请改成 IPv4，或切到「精准分流」', 'err');
          return;
        }
      }
      var badDomain = targets.filter(function (t) {
        return MH.classify(t) === 'domain' && !MH.isValidDomain(t) && !geositeCategory(t);
      });
      if (badDomain.length) {
        toast('域名写法不合法（' + badDomain[0] + '）：不能带逗号 / 空格 / 斜杠 / 冒号 / 通配符，'
          + '也不能有空的标签或首尾的 -', 'err');
        return;
      }
      var added = addRules($('rule-target').value);
      $('rule-target').value = '';
      if (!added) toast('这 ' + targets.length + ' 条已经在列表里了');
    }
    on($('rule-add'), 'click', addRule);
    // 常用 → AI：勾上就加一条 GeoSite 规则，出口取当前选中的（1 个节点 / 负载均衡 / 直连）
    on($('common-ai'), 'change', function () {
      var on = this.checked;
      state.customRules = state.customRules.filter(function (r) { return !isAiRule(r); });
      if (on) {
        state.customRules.push({
          preset: 'ai',
          target: aiCategory(),     // 存一份当前分类；生成时会按回国模式现算
          type: 'geosite',
          actions: (ruleActions.length ? ruleActions.slice() : ['DIRECT'])
        });
      }
      renderRuleList();
      refresh();
    });
    // 常用 → TK：固定 geosite:tiktok，出口取当前选中的（1 个节点 / 负载均衡 / 直连）
    on($('common-tk'), 'change', function () {
      var on = this.checked;
      state.customRules = state.customRules.filter(function (r) { return !isTkRule(r); });
      if (on) {
        state.customRules.push({
          preset: 'tk',
          target: TK_CATEGORY,
          type: 'geosite',
          actions: (ruleActions.length ? ruleActions.slice() : ['DIRECT'])
        });
      }
      renderRuleList();
      refresh();
    });
    on($('common-nf'), 'change', function () {
      var on = this.checked;
      state.customRules = state.customRules.filter(function (r) { return !isNfRule(r); });
      if (on) {
        var acts = (ruleActions.length ? ruleActions.slice() : ['DIRECT']);
        // IP 规则放前面：目标相同时顺序不影响结果，只是看起来更直观
        state.customRules.push({ preset: 'nf', target: NF_CATEGORY, type: 'geoip', actions: acts });
        state.customRules.push({ preset: 'nf', target: NF_CATEGORY, type: 'geosite', actions: acts });
      }
      renderRuleList();
      refresh();
    });
    on($('common-tc'), 'change', function () {
      var on = this.checked;
      state.customRules = state.customRules.filter(function (r) { return !isTencentRule(r); });
      if (on) {
        state.customRules.push({
          preset: 'tencent',
          target: TENCENT_CATEGORY,
          type: 'geosite',
          actions: (ruleActions.length ? ruleActions.slice() : ['DIRECT'])
        });
      }
      renderRuleList();
      refresh();
    });
    // 出口多选菜单：点按钮开合、点外面/Esc 收起
    on($('rule-action-btn'), 'click', function (e) {
      e.stopPropagation();
      var menu = $('rule-action-menu');
      var open = menu.hidden;
      menu.hidden = !open;
      this.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    on(doc, 'click', function (e) {
      var box = $('rule-action');
      if (box && !box.contains(e.target)) closeRuleMenu();
    });
    on(doc, 'keydown', function (e) {
      if (e.key === 'Escape') closeRuleMenu();
    });
    on($('rule-target'), 'keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); addRule(); }
    });
    // ⚠️ 粘贴只落进输入框、不直接加：动作（走哪个节点 / 直连）是加之前就要选的，替用户决定只会
    //    生成一堆走错出口的规则；切分只发生在点「添加」那一下。
    // 这里只管换行：那格是单行 <input>，浏览器默认粘贴会把换行去掉、4 行粘完可能连成一个词，所以
    // 把换行压成空格再插进去（addRules 认的分隔符里也有空格）。
    on($('rule-target'), 'paste', function (e) {
      var dt = e.clipboardData || window.clipboardData;
      var raw = dt ? String(dt.getData('text') || '') : '';
      if (raw.indexOf('\n') === -1 && raw.indexOf('\r') === -1) return;  // 没有换行 → 默认粘贴就够
      e.preventDefault();
      var flat = raw.replace(/[\r\n]+/g, ' ').replace(/ {2,}/g, ' ').replace(/^\s+|\s+$/g, '');
      var el = $('rule-target');
      var start = el.selectionStart == null ? el.value.length : el.selectionStart;
      var end = el.selectionEnd == null ? start : el.selectionEnd;
      el.value = el.value.slice(0, start) + flat + el.value.slice(end);
      el.selectionStart = el.selectionEnd = start + flat.length;
    });

    // 预览区操作
    on($('copy-btn'), 'click', function () {
      if (!generated) return toast('当前没有可复制的配置文本。', 'err');
      copyText(generated);
    });
    on($('download-btn'), 'click', function () {
      if (!generated) return toast('还没有可下载的配置文件', 'err');
      downloadText('config.yaml', generated);
    });
    // 「重新生成」按钮已去掉：任何改动都会自动重新生成，用不上（Ctrl+Enter 仍可手动刷新）

    // 快捷键：Ctrl/Cmd+S 下载，Ctrl/Cmd+Enter 重新生成
    on(doc, 'keydown', function (e) {
      var mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 's') {
        e.preventDefault();
        if (generated) downloadText('config.yaml', generated);
        else toast('还没有可下载的配置文件', 'err');
      } else if (mod && e.key === 'Enter') {
        e.preventDefault();
        refresh({ silent: false });
      }
    });
  }

  function copyText(text) {
    if (root.navigator.clipboard && root.navigator.clipboard.writeText) {
      root.navigator.clipboard.writeText(text)
        .then(function () { toast('已复制配置文本。', 'ok'); })
        .catch(function () { fallbackCopy(text); });
    } else {
      fallbackCopy(text);
    }
  }

  function fallbackCopy(text) {
    var ta = doc.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    doc.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = doc.execCommand('copy'); } catch (e) { ok = false; }
    doc.body.removeChild(ta);
    toast(ok ? '已复制配置文本' : '复制失败，请手动选中复制', ok ? 'ok' : 'err');
  }

  function downloadText(filename, text) {
    var blob = new root.Blob([text], { type: 'text/yaml;charset=utf-8' });
    var url = root.URL.createObjectURL(blob);
    var a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    doc.body.removeChild(a);
    root.setTimeout(function () { root.URL.revokeObjectURL(url); }, 1000);
    toast('配置文件已下载：' + filename, 'ok');
  }

  // ── 启动 ────────────────────────────────────────────────────
  function init() {
    MH.loadSettings(state);
    // 版本号只出现在状态栏右下角；连点它 3 下能换工具密码，见 bindSecretRotate
    $('status-version').textContent = MH.APP_VERSION;
    applyTheme();
    bindEvents();
    renderMode();
    renderNodeList();
    renderRuleList();
    renderOptionVisibility();
    renderNodeRoles();
    renderIpPreview();
    refresh();
    showStep(0);

    // 系统主题变化时跟随；嵌在 LuCI 里（body.headerless）时不跟 —— 那边由宿主写死 Argon 的明暗，
    // 跟着系统变会把宿主的明确选择覆盖掉。
    var hosted = doc.body && doc.body.classList.contains('headerless');
    if (root.matchMedia && !hosted) {
      var mq = root.matchMedia('(prefers-color-scheme: dark)');
      var onScheme = function () { if (!state.theme) applyTheme(); };
      // 老 Safari（<14）只有 addListener，没有 addEventListener —— 不支持就静默不跟随
      if (mq.addEventListener) mq.addEventListener('change', onScheme);
      else if (mq.addListener) mq.addListener(onScheme);
    }
  }

  MH.ui = {
    state: state,
    init: init,
    buildConfig: buildConfig,
    refresh: refresh,
    importText: importText,
    // 生成文本 → 实际写进 proxies 的节点数（refresh 用它写状态行；测试直接比对它）
    writtenProxies: writtenProxies,
    // UTF-8 字节数（体积显示 / 10 MiB 上限都按它算，测试也直接测）
    utf8Bytes: utf8Bytes,
    getGenerated: function () { return generated; },
    // 给 apply.js 用（它那边也有一套 toast，走这条能复用同一个计时器）
    toast: toast,
    // 两个纯函数给单测（自定义规则出口的校验 / 收窄）
    validRuleActions: validRuleActions,
    narrowRuleActions: narrowRuleActions
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
