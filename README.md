# luci-app-jp-ipoe
### This project is fully written by GPT 5.5, Tested by myself. Everything works like how it is.
### Thanks to fakemanhk/openwrt-jp-ipoe, What a great tutorial!
LuCI helper for Japan NTT IPoE MAP-E connections, focused on OCN Virtual Connect style setups.

## **The problem:**

ISPs with NTT mostly support both IPv4 & IPv6 implementations, while former one usually by using PPPoE which can introduce higher latency, during peak hours it can be also very slow in some busy districts. IPv6 is their newly promoted way to connect to internet which doesn't require PPPoE (note there is no PPPoE for 10G plan, IPoE is the only option),  they also claim this is a much faster option, with IPv4 over IPv6 together users should retain traditional IPv4 connectivity. Unfortunately if you subscribe the internet service without using Hikari Denwa (ひかり電話) residential phone service, you will end up getting /64 prefix address as well as without router advertisement (RA), if you don't use vendor provided router it would be extremely difficult to set up your IPv6 network with IPv4 over IPv6 connectivity.

## Do What:

- install and validate a patched `/lib/netifd/proto/map.sh`
- configure an existing DHCPv6 WAN interface
- set a NTT-compatible DHCPv6 DUID-LL client ID for WAN6
- create and manage the MAP-E interface
- add WAN6 and MAP-E to the WAN firewall zone
- configure DHCPv6/RA/NDP relay for no-PD `/64` lines
- generate nftables SNAT rules for all assigned MAP-E port ranges
- optionally reserve fixed IPv4 ports so SNAT will not use them
- lower PPPoE fallback priority by setting PPPoE metrics to `200`
- show status and attempt BR address detection from LuCI

## Requirements

- OpenWrt 22.03 or newer with fw4/nftables
- LuCI
- `map` package
- a working IPv6 WAN interface using DHCPv6, usually named `wan6`

The package depends on `map`. On install, it also copies the bundled patched MAP protocol script to `/lib/netifd/proto/map.sh`. If an unpatched stock script already exists, it is backed up to `/lib/netifd/proto/map.sh.orig`.

## Supported Scope

This plugin targets shared IPv4 MAP-E service over NTT IPoE, especially OCN Virtual Connect compatible lines.

It is not a general static IPv4 IPoE implementation. If your ISP sells a dedicated static IPv4 service, that may use provider-specific behavior that cannot be derived from normal MAP-E parameters.

## Quick Start

1. Install `luci-app-jp-ipoe`.
2. Make sure `Network > Interfaces` already has a DHCPv6 WAN interface, usually `wan6`.
3. Open `Network > JP IPoE > Configuration`.
4. Set `WAN Physical Device` to the real WAN device, for example `eth0` or `eth1`.
5. Keep `IPv6 WAN Interface Name` as `wan6` unless your interface uses another name.
6. Keep `Use Legacy MAP` enabled for OCN Virtual Connect.
7. Leave `BR Address` empty if you want the plugin to try `mapcalc` detection.
8. Enable `DHCPv6/NDP Relay` if your line only receives a `/64` without prefix delegation.
9. Click `Apply IPoE Configuration`.

After applying, check `Network > JP IPoE > Status`. A working setup should show:

- WAN6 has a global IPv6 address
- MAP-E tunnel state is `up`
- MAP-E has an IPv4 address
- assigned port ranges are visible

## Configuration Fields

`Enable at Boot`
: Runs the setup automatically during router startup.

`WAN Physical Device`
: The physical WAN device used by the DHCPv6 interface. The plugin uses this device to enable IPv6 and generate a DUID-LL client ID.

`IPv6 WAN Interface Name`
: Existing DHCPv6 interface to configure and use as the MAP-E tunnel link.

`MAP-E Interface Name`
: Managed MAP-E interface name. The default is `wan6mape`.

`Use Legacy MAP`
: Enables legacy MAP behavior. Keep this enabled for OCN Virtual Connect and typical NTT MAP-E setups.

`BR Address`
: Border Relay IPv6 address. If empty, the setup script tries to detect it with `mapcalc`.

`IPv4 Prefix`, `IPv4 Prefix Length`, `IPv6 Prefix`, `IPv6 Prefix Length`, `EA bits length`, `PSID bits length`, `PSID offset`
: Advanced manual MAP-E parameters. Leave empty unless auto-detection fails or your provider requires manually supplied values.

`Reserved IPv4 Ports`
: Space-separated ports that the SNAT helper must not use. This is useful when you intentionally reserve assigned MAP-E ports for inbound services.

`Enable DHCPv6/NDP Relay`
: Enable for no-PD `/64` lines. Disable it when your line receives prefix delegation and you want normal LAN IPv6 server mode.

## What Apply Does

Running `Apply IPoE Configuration` executes:

```sh
/usr/sbin/jp-ipoe-setup start
```

The setup script:

1. validates that the patched MAP protocol script is installed
2. enables IPv6 on the WAN device when an explicit device section exists
3. configures the WAN6 interface as DHCPv6
4. checks the WAN6 DHCPv6 DUID
5. waits for a global IPv6 address
6. derives and sets `wan6.ip6prefix` when relay/manual MAP settings need it
7. creates or updates the MAP-E interface
8. adds WAN6 and MAP-E to the WAN firewall zone
9. applies PPPoE fallback metrics if PPPoE interfaces exist
10. configures DHCPv6/RA/NDP relay or restores standard LAN server mode
11. brings up the MAP-E interface and reloads fw4

## DUID-LL Handling

NTT NGN expects DHCPv6 DUID-LL for WAN authentication. Some newer OpenWrt builds may generate a DUID-LLT default, which can prevent WAN6 from receiving IPv6.

During setup, the plugin checks:

- interface-level `network.<wan6>.clientid`
- global `network.globals.dhcp_default_duid`

If the effective value is already `00030001` plus the WAN device MAC address, it is left unchanged. Otherwise the plugin writes an interface-level `clientid` for WAN6, leaving the global default DUID untouched.

Example for MAC `aa:bb:cc:dd:ee:ff`:

```text
00030001aabbccddeeff
```

## Patched MAP Script

The bundled `map.sh` keeps the OpenWrt MAP protocol behavior but fixes Japan MAP-E port handling for fw4/nftables:

- uses all assigned MAP-E port ranges instead of only the first group
- preserves ICMP IPv4 connectivity through SNAT
- supports reserved ports through `Reserved IPv4 Ports`
- creates and removes dedicated nftables rules per MAP-E interface

OpenWrt 24.10 users may still need this patched script; do not assume the stock script is enough unless you have verified port-range usage and IPv4 ICMP behavior on your own line.

## Status Page

`Network > JP IPoE > Status` shows:

- WAN6 interface and device
- WAN6 IPv6 address
- MAP-E interface state
- MAP-E IPv4 address
- BR address
- assigned port ranges
- PPPoE fallback metrics

The `Auto-Detect BR Address` button runs `mapcalc` and can save the detected BR address into the plugin configuration.

## CLI

The LuCI buttons call the same script you can use over SSH:

```sh
/usr/sbin/jp-ipoe-setup start
/usr/sbin/jp-ipoe-setup stop
/usr/sbin/jp-ipoe-setup status
/usr/sbin/jp-ipoe-setup detect_br
```

Reinstall the patched MAP protocol script manually if needed:

```sh
/usr/libexec/jp-ipoe-install-map
```

## Troubleshooting

### WAN6 does not get IPv6

- Confirm the WAN physical device is correct.
- Confirm the WAN6 interface exists before running setup.
- Check that WAN6 sends DUID-LL. The plugin sets interface-level `clientid` automatically when needed.
- Check system logs for DHCPv6 errors:

```sh
logread -e jp-ipoe
```

### MAP-E starts but IPv4 does not work

- Confirm `Use Legacy MAP` is enabled.
- Confirm `BR Address` is correct for your line.
- Confirm the MAP-E interface is in the WAN firewall zone.
- Check `Status` for assigned port ranges.
- If BR detection fails, fill the MAP-E parameters manually from a calculator or from the ISP router's status page.

### `mapcalc` cannot detect a BR address

Detection depends on WAN6 having IPv6 and matching MAP-E rule data. If your IPv6 prefix is unsupported by the common calculator or by `mapcalc`, use provider/router supplied MAP-E parameters manually.

For 10G or prefix-delegated lines, a delegated `/56` or `/60` may be normal. Disable DHCPv6/NDP relay when you have proper prefix delegation and want standard LAN IPv6 server mode.

### RX stays zero on `map-<iface>`

Common causes are an incorrect BR address, missing legacy MAP mode, or incomplete MAP-E parameters. Recalculate or copy the BR and MAP-E parameters from a known-working ISP router if possible.

### Static IPv4 service

The MAP-E IPv4 address may differ from a separately contracted static IPv4 service. This plugin does not emulate provider-specific static IPv4 IPoE behavior.

## References

- RFC 7597: https://datatracker.ietf.org/doc/html/rfc7597
- Legacy MAP draft used by many NTT-era deployments: https://datatracker.ietf.org/doc/html/draft-ietf-softwire-map-03
- MAP-E calculator: http://ipv4.web.fc2.com/map-e.html
- OCN connectivity test: https://v6test.ocn.ne.jp/

