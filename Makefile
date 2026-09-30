include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-jp-ipoe
PKG_VERSION:=1.6.2
PKG_RELEASE:=1

LUCI_TITLE:=LuCI support for JP IPoE MAP-E (OCN Virtual Connect / v6plus)
LUCI_DESCRIPTION:=Configure Japan NTT MAP-E connections for OCN Virtual Connect and v6plus, with automatic parameter detection, status monitoring, and locally checked port forwarding.
LUCI_DEPENDS:=+map +conntrack
LUCI_PKGARCH:=all

define Package/$(PKG_NAME)/postinst
#!/bin/sh
if [ -n "$$IPKG_INSTROOT" ]; then
	sh "$$IPKG_INSTROOT/usr/libexec/jp-ipoe-install-map" >/dev/null 2>&1 || true
else
	sh /usr/libexec/jp-ipoe-install-map >/dev/null 2>&1 || true
	# Preserve the standard LuCI post-install cache refresh.
	rm -f /tmp/luci-indexcache.*
	rm -rf /tmp/luci-modulecache/
	/etc/init.d/rpcd reload 2>/dev/null || true
fi
exit 0
endef

define Package/$(PKG_NAME)/prerm
#!/bin/sh
[ "$$PKG_UPGRADE" = "1" ] && exit 0
[ "$$1" = "upgrade" ] && exit 0
INSTALLER="$${IPKG_INSTROOT:-}/usr/libexec/jp-ipoe-install-map"
[ -f "$$INSTALLER" ] || exit 0
rc=0
if [ -z "$$IPKG_INSTROOT" ]; then
	# Call setup directly: rc.common can mask stop_service failures. The
	# locked uninstall action waits for netifd removal and checks SNAT cleanup
	# before restoring the handler. apk may already have called service stop.
	/usr/sbin/jp-ipoe-setup uninstall && exit 0
	echo "ERROR: JP IPoE uninstall cleanup failed; partial network/firewall state may remain." >&2
	rc=1
fi
# Also restore after lock/ownership/inspection failure, or in an image root.
# apk can purge helpers despite a failing hook; never leave an owned handler
# pointing at removed helpers.
sh "$$INSTALLER" restore || rc=1
exit "$$rc"
endef

# luci.mk registers the application and translations once, after our hooks.
include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
