include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-jp-ipoe
PKG_VERSION:=1.5.0
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

# luci.mk registers the application and translations once, after our hooks.
include $(TOPDIR)/feeds/luci/luci.mk
