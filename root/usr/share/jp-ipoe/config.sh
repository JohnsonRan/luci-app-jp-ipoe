#!/bin/sh

. /lib/functions.sh

jp_ipoe_config_load() {
	config_load jp_ipoe
	config_get WAN_DEVICE  config wan_device  "eth0"
	config_get WAN6_IFACE  config wan6_iface  "wan6"
	config_get MAPE_IFACE  config mape_iface  "wan6mape"
	config_get BR_ADDR     config br_addr     ""
	config_get IPADDR      config ipaddr      ""
	config_get IP4PREFIXLEN config ip4prefixlen "20"
	config_get IP6PREFIX   config ip6prefix   ""
	config_get IP6PREFIXLEN config ip6prefixlen "38"
	config_get EALEN       config ealen       "42"
	config_get PSIDLEN     config psidlen     "6"
	config_get OFFSET      config offset      "4"
	config_get LEGACYMAP   config legacymap   "1"
	config_get DHCPV6_RELAY config dhcpv6_relay "1"
}
