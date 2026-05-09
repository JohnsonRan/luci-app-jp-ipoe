include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-jp-ipoe
PKG_VERSION:=1.2.0
PKG_RELEASE:=1

LUCI_TITLE:=LuCI support for JP IPoE (OCN MAP-E)
LUCI_DEPENDS:=+map
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

define Package/$(PKG_NAME)/postinst
#!/bin/sh
[ -n "$$IPKG_INSTROOT" ] && exit 0
/usr/libexec/jp-ipoe-install-map >/dev/null 2>&1 || true
exit 0
endef

# call BuildPackage - OpenWrt build template
$(eval $(call BuildPackage,luci-app-jp-ipoe))
