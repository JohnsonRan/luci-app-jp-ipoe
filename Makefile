include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-jp-ipoe
PKG_VERSION:=1.0.5
PKG_RELEASE:=1

LUCI_TITLE:=LuCI support for JP IPoE (OCN MAP-E)
LUCI_DEPENDS:=+map
LUCI_PKGARCH:=all

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt build template
$(eval $(call BuildPackage,luci-app-jp-ipoe))
