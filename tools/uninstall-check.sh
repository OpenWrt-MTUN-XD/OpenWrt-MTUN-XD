#!/bin/sh
# 卸载回归检查（在**路由器上**跑；默认只体检，加 --run 才真的卸载）。
#
# 用法：
#   sh /tmp/uninstall-check.sh            # 只检查当前安装的完整性
#   sh /tmp/uninstall-check.sh --run      # 执行卸载并核对「配置保留 + 文件清干净」
#
# ⚠️ --run 会停掉内核、卸载套件；结束后需要重新安装：
#      curl -fsSL https://raw.githubusercontent.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/main/install.sh -o /tmp/i.sh && sh /tmp/i.sh

set -u
BIN=/usr/sbin/mtun-xd
CFG=/etc/mihomo/config.yaml
TOOL=/etc/mihomo-toolpass
MENU=/usr/share/luci/menu.d/luci-app-mtun-xd.json
ACL=/usr/share/rpcd/acl.d/luci-app-mtun-xd.json
VIEW=/www/luci-static/resources/view/mtun-xd
RUN=0
[ "${1:-}" = "--run" ] && RUN=1

bad=0
say() { printf '%s\n' "$1"; }
ok()  { printf '[正常] %s\n' "$1"; }
err() { printf '[异常] %s\n' "$1"; bad=$((bad + 1)); }

sha() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

say "== 卸载前快照 =="
cfg_sha=$(sha "$CFG"); tool_sha=$(sha "$TOOL")
[ -n "$cfg_sha" ] && ok "config.yaml 存在" || err "config.yaml 不存在"
[ -n "$tool_sha" ] && ok "工具密码文件存在" || err "工具密码文件不存在"
[ -x "$BIN" ] && ok "套件脚本存在" || err "套件脚本不存在"

if [ "$RUN" != 1 ]; then
    say ""
    say "只体检完成（要真卸再加 --run）：$bad 项异常"
    [ "$bad" = 0 ]
    exit $?
fi

say ""
say "== 执行卸载（保留配置） =="
"$BIN" uninstall >/tmp/uninstall-check.out 2>&1
rc=$?
[ "$rc" = 0 ] && ok "卸载命令返回 0" || err "卸载命令返回 $rc（见 /tmp/uninstall-check.out）"

say ""
say "== 卸载后核对 =="
[ "$(sha "$CFG")" = "$cfg_sha" ] && ok "config.yaml 未被动过" || err "config.yaml 被改动了"
[ "$(sha "$TOOL")" = "$tool_sha" ] && ok "工具密码未被动过" || err "工具密码被改动了"
[ -x "$BIN" ] && err "套件脚本还在" || ok "套件脚本已移除"
[ -f "$MENU" ] && err "菜单文件还在" || ok "菜单文件已移除"
[ -f "$ACL" ] && err "ACL 文件还在" || ok "ACL 文件已移除"
[ -d "$VIEW" ] && [ -n "$(ls -A "$VIEW" 2>/dev/null)" ] && err "视图目录还有残留文件" || ok "视图目录已清理"
[ -x /etc/init.d/mihomo ] && err "init 脚本还在" || ok "init 脚本已移除"

say ""
say "== 重装提示 =="
say "  curl -fsSL https://raw.githubusercontent.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD/main/install.sh -o /tmp/i.sh && sh /tmp/i.sh"
say ""
say "检查完成：$bad 项异常"
[ "$bad" = 0 ]
exit $?
