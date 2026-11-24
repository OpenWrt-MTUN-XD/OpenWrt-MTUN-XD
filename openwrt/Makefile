# LuCI 应用：MTUN-XD（墨枢云境）—— 固件编译用包定义
#
# 用途：把本仓库的 `package/` 直接编进 OpenWrt / iStoreOS 固件，和 APK/OPKG 安装并存，
#       互不冲突。运行期的核心 / 面板 / 配置工具仍由套件自己按需拉取（不塞进镜像）。
#
# 用法见 openwrt/README.md。
#
# ⚠️ PKG_VERSION 必须跟 generator/app/state.js 的 APP_VERSION 一致（去掉前导 v），
#    tests/test_package.py 会检查；发版时两处一起改。

include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-mtun-xd
PKG_VERSION:=2026.11.29
PKG_RELEASE:=1

PKG_LICENSE:=MIT
PKG_LICENSE_FILES:=LICENSE
PKG_MAINTAINER:=MTUN-XD <https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD>

# 两种取源码方式：
#   ① 默认：按 tag 从 GitHub 拉（make 时联网）
#   ② 本地：make package/.../compile MTUN_XD_LOCAL=/path/to/MTUN-XD
#      ⚠️ 本地源码只当"来源"用：拷进 PKG_BUILD_DIR 再编，绝不把它当构建目录 ——
#         构建过程会清空 PKG_BUILD_DIR，直接指向仓库会把仓库删了（CI 上就是这么炸的）。
ifneq ($(MTUN_XD_LOCAL),)
PKG_SOURCE_PROTO:=none
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
else
PKG_SOURCE_PROTO:=git
PKG_SOURCE_URL:=https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD.git
PKG_SOURCE_VERSION:=v$(PKG_VERSION)
PKG_MIRROR_HASH:=skip
PKG_SOURCE_SUBDIR:=$(PKG_NAME)-$(PKG_VERSION)
PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
endif

include $(INCLUDE_DIR)/package.mk

define Package/$(PKG_NAME)
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=MTUN-XD (墨枢云境) — Mihomo management suite
  URL:=https://github.com/OpenWrt-MTUN-XD/OpenWrt-MTUN-XD
  DEPENDS:=+luci-base +curl +ca-bundle +kmod-tun
  PKGARCH:=all
endef

define Package/$(PKG_NAME)/description
  MTUN-XD puts Mihomo core, MetaCubeXD panel, a browser-side config generator and
  maintenance tools behind one LuCI menu entry.

  The package itself only carries the suite (a few tens of KB). Mihomo core and the
  panel are fetched from their official releases on first setup, with SHA-256 checks.
endef

define Package/$(PKG_NAME)/conffiles
/etc/config/mtun-xd
endef

ifneq ($(MTUN_XD_LOCAL),)
define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) $(MTUN_XD_LOCAL)/package $(PKG_BUILD_DIR)/
	$(CP) $(MTUN_XD_LOCAL)/openwrt $(PKG_BUILD_DIR)/
endef
endif

define Build/Compile
endef

define Package/$(PKG_NAME)/install
	# 套件本体：直接铺仓库里的 package/
	$(CP) $(PKG_BUILD_DIR)/package/. $(1)/
	chmod 0755 $(1)/usr/sbin/mtun-xd
	chmod 0755 $(1)/etc/init.d/mihomo $(1)/etc/init.d/mtun-xd-selfcheck

	# 固件专用：首次开机把核心 / 面板 / 配置工具拉齐（单机安装走 install.sh，用不到它）
	$(INSTALL_DIR) $(1)/etc/init.d $(1)/etc/config
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/openwrt/files/mtun-xd-firstboot $(1)/etc/init.d/mtun-xd-firstboot
	$(INSTALL_CONF) $(PKG_BUILD_DIR)/openwrt/files/mtun-xd.config $(1)/etc/config/mtun-xd
endef

define Package/$(PKG_NAME)/postinst
#!/bin/sh
# 固件编译阶段（image builder）跑 postinst 时没有网络、也没有运行环境：
# 这一步什么都不做，等设备首次开机由 mtun-xd-firstboot 拉齐。
[ -n "$${IPKG_INSTROOT}" ] && exit 0

/etc/init.d/mtun-xd-selfcheck enable >/dev/null 2>&1 || true
/etc/init.d/mtun-xd-firstboot enable >/dev/null 2>&1 || true
# 面板配置先按本地现状铺一遍（只读本地文件，不联网）
/usr/sbin/mtun-xd seed-panel >/dev/null 2>&1 || true
exit 0
endef

define Package/$(PKG_NAME)/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$${1:-}" = "upgrade" ] && exit 0
# 卸载前先把 MTUN-XD 自己接管的 80 还回去；失败就中止卸载，保留快照。
if [ -f /usr/share/mtun-xd/mihomo-haproxy.sh ]; then
    if ! sh /usr/share/mtun-xd/mihomo-haproxy.sh off; then
        echo "✘ MTUN-XD 80 端口还原失败，已中止卸载。请先恢复 uhttpd/80，再重试；快照保留在 /etc/mtun-xd.haproxy-uhttpd.bak" >&2
        exit 1
    fi
fi
rm -f /etc/init.d/mtun-xd-haproxy /etc/rc.d/S99mtun-xd-haproxy
/etc/init.d/mtun-xd-firstboot disable >/dev/null 2>&1 || true
/etc/init.d/mtun-xd-selfcheck disable >/dev/null 2>&1 || true
/etc/init.d/mihomo stop >/dev/null 2>&1 || true
# 不动 /etc/mihomo/config.yaml 与 /etc/mihomo-toolpass
exit 0
endef

$(eval $(call BuildPackage,$(PKG_NAME)))
