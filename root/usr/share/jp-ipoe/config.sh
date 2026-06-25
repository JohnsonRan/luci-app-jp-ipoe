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
	config_get_bool LEGACYMAP config legacymap "1"
	config_get_bool DHCPV6_RELAY config dhcpv6_relay "1"
}

# Read a value from `mapcalc` rule output, preferring the matched rule
# (RULE_BMR) and falling back to RULE_1. Shared by jp-ipoe-setup and
# jp-ipoe-info so the lookup logic stays in one place.
jp_ipoe_mapcalc_lookup() {
	local rule_data="$1"
	local suffix="$2"
	local rule_index
	local value

	eval "$rule_data"
	rule_index="${RULE_BMR:-1}"
	eval "value=\${RULE_${rule_index}_${suffix}}"
	if [ -z "$value" ] && [ "$rule_index" != "1" ]; then
		eval "value=\${RULE_1_${suffix}}"
	fi
	printf '%s' "$value"
}
