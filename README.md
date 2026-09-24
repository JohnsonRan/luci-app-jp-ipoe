# luci-app-jp-ipoe

Configure Japan NTT IPoE **MAP-E** connections from OpenWrt's LuCI interface.
Use IPv4 over IPv6, check connection status, and set up inbound IPv4 or IPv6
access to devices on your LAN.

- [Requirements](#requirements)
- [Install](#install)
- [First setup](#first-setup)
- [Everyday use](#everyday-use)
- [Port forwarding](#port-forwarding)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)

## Requirements

- OpenWrt with **Linux 6.12 or newer**, fw4/nftables and LuCI.
- An existing DHCPv6 WAN interface, usually `wan6`.
- A compatible shared-IPv4 MAP-E service. Automatic parameter lookup includes
  **OCN Virtual Connect** and **v6プラス (JPNE)** rule data.

Check the IPv4-over-IPv6 service used by your ISP, not just its retail brand.
Other MAP-E services require matching manual parameters and are not covered by
this automatic lookup. **DS-Lite and provider-specific static IPv4 IPoE
connections are not supported.**

## Install

1. Download the main `luci-app-jp-ipoe` package from
   [Releases](https://github.com/JohnsonRan/luci-app-jp-ipoe/releases).
   Branch-build artifacts are also available under
   [Actions](https://github.com/JohnsonRan/luci-app-jp-ipoe/actions/workflows/build-packages.yml).
   Match your OpenWrt release and package format: builds cover **24.10 (`ipk`)
   and 25.12 (`apk`)**, for x86/64 and arm64. For other firmware, use a
   [matching SDK build](docs/development.md#build-packages).
   **Stock 24.10 uses Linux 6.6 and is below the supported kernel baseline**;
   the `ipk` build is for compatible custom firmware with Linux 6.12 or newer.
2. Install using LuCI's package manager, or upload the file to `/tmp` and use
   one of the SSH examples below. Rename the uploaded file to the example's
   filename first.
3. Refresh LuCI, then open **Network → JP IPoE**. Configuration, Status and
   Port Forwarding are tabs on the same page.

For compatible `ipk` firmware with Linux 6.12 or newer:

```sh
opkg update
opkg install /tmp/luci-app-jp-ipoe.ipk
```

For OpenWrt 25.12:

```sh
apk update
apk add --allow-untrusted /tmp/luci-app-jp-ipoe.apk
```

Use `--allow-untrusted` only for an unsigned package you trust. The package
manager installs `map` and `conntrack` dependencies; working access to your
firmware's package repositories is needed.

Installation also replaces `/lib/netifd/proto/map.sh` with the bundled MAP
handler. An existing unpatched handler is backed up as `map.sh.orig`.

## First setup

**Back up your configuration and keep local LAN access to the router.** Apply
changes WAN6, LAN IPv6 settings, firewall membership and PPPoE route priority;
it can interrupt IPv4 and IPv6 connectivity.

1. In **Network → Interfaces**, confirm your DHCPv6 WAN interface exists.
2. Open **Network → JP IPoE → Configuration**. Select the correct **WAN Physical
   Device** and **IPv6 WAN Interface Name** (`wan6` unless you renamed it).
3. For OCN Virtual Connect or v6plus, enable **Auto Parameters**. It is off by
   default. Keep **Use Legacy MAP** enabled.
4. Set **Enable DHCPv6/NDP Relay** to match your line:
   - **Enabled** for a `/64` without prefix delegation (PD).
   - **Disabled** when your ISP delegates a prefix and you want normal LAN IPv6
     server mode. A delegated `/56` or `/60` can be normal.
5. Enable **Enable at Boot** if you want setup to run during router startup.
   It is off by default.
6. If WAN6 already has a global IPv6 address, **Preview Parameters** lets you
   check the detected values without applying network changes.
7. Click **Apply IPoE Configuration**.

On the **Status** tab, check that WAN6 has global IPv6, the MAP-E tunnel is
`up`, and an IPv4 address and assigned port ranges are shown. Then test Internet
access from a LAN device. An `up` interface alone does not prove connectivity.

### Manual settings

If automatic lookup does not cover your line, disable **Auto Parameters** and
enter the BR address and complete MAP-E parameters supplied by your provider,
ISP router, or the [MAP-E calculator](http://ipv4.web.fc2.com/map-e.html).
The preset numeric values are OCN-oriented, not universal defaults.

In manual mode, an empty **BR Address** lets the plugin attempt BR detection;
**Auto-Detect BR Address** can also detect, save and reapply that value. It is
not a replacement for correct MAP-E parameters.

Leave **MAP-E Interface Name** as `wan6mape` unless you need another name.
**Reserved IPv4 Ports** excludes space-separated ports from outbound NAT; it
does not open them for inbound access. Port Forwarding manages its own
reservations, so you do not need to copy its ports into this field.

## Everyday use

| Control | When to use it |
| --- | --- |
| **Apply IPoE Configuration** | Save and apply settings. If settings and the locally checked running state already match, no restart is needed. Otherwise, setup runs again. |
| **Force Reconnect / Repair** | Rebuild a connection that appears configured but does not work. **This interrupts traffic.** |
| **Stop IPoE Interfaces** | Stop the managed IPoE setup. This is not a restoration of your previous network configuration. |
| **Status** | Inspect addresses, tunnel state, assigned ports and PPPoE fallback priority. |

To prevent boot-time setup, disable **Enable at Boot**, apply that setting,
then stop IPoE. Stopping or uninstalling does not restore all previous settings;
keep your configuration backup.

PPPoE is given a lower route priority when present. During boot, or when WAN6
needs recovery, PPPoE may be stopped and WAN6 restarted. Stopped PPPoE interfaces
are restored on a best-effort basis after the operation returns, whether setup
succeeds or fails. After an interrupted operation or a failed restoration,
check whether your PPPoE backup needs starting in **Network → Interfaces**.

The **Status** tab also shows system conntrack usage and cumulative failure/
eviction counters. These cover the whole router, not just MAP-E, and do not
measure your assigned port usage or Internet packet loss. Compare successive
readings when troubleshooting; **Unavailable** means inspection failed, not zero.

## Port forwarding

Open **Port Forwarding**, choose **IPv4**, **IPv6**, or **IPv4 + IPv6**, then
select a device or enter its address manually. Targets must be directly on the
main `lan` network. IPv4 checks both subnet membership and the current route;
a destination routed through another gateway or interface is rejected.

The device picker fills current addresses; **it does not bind a rule to a MAC
address or follow address changes**. Prefer stable addresses, such as a DHCP
reservation for IPv4, and verify the destination before adding a rule.

**Secure the service before exposing it to the Internet.** Test from outside
your LAN. Local checks and a published/installed status do not prove that the
service is reachable or audit every custom firewall rule.

### IPv4

1. Ensure MAP-E is up.
2. Enter the LAN device's service port and choose TCP, UDP, or both.
3. Leave the external port empty to select an assigned MAP-E port automatically,
   or enter one from your assigned ranges.
4. Connect using the MAP-E **public IPv4 address and external port**. The
   device's internal service port does not need to be in the assigned ranges.

- Stop and disable UPnP (`miniupnpd`) before creating or activating IPv4 rules.
- Adding or deleting rules does not restart MAP-E or clear existing connections.
- Saved rules survive restarts. Stopping MAP-E withdraws active IPv4 forwarding,
  but keeps saved rules. If the public IPv4 address, port allocation or LAN
  changes, incompatible rules stay inactive; delete and recreate them.
- NAT loopback/reflection is not provided. A test from inside your LAN may fail
  even when outside access works.

### IPv6

IPv6 adds a firewall allowance, not NAT or port translation. Connect directly
to the **device's global IPv6 address and service port**, for example
`[2001:db8::10]:8080` (replace this documentation address with the real address).
WAN6 must be up, but MAP-E need not be. The destination must be directly
reachable through `lan`, not a router address, link-local/ULA address, or a
host behind another gateway.

**IPv6 rules survive MAP-E stop, reboot and plugin uninstall.** Delete them
explicitly in this tab or **Network → Firewall → Traffic Rules**; their names
start with `jp_ipoe6_`. Recreate a rule if the device's IPv6 address changes.

### Failed or partial updates

**IPv4 + IPv6 creates two independent rules.** If only one succeeds, keep it
and add only the missing family rather than blindly retrying both.

If an add/delete operation fails, forwarding may remain active. Review the
list and retry removal; an error or **state unavailable** is not proof that
access is closed. Deleting a rule does not necessarily end existing connections,
and other firewall rules may still allow access.

## Troubleshooting

Over SSH, start with these read-only checks:

```sh
jp-ipoe-setup status
logread -e jp-ipoe
```

| Symptom | What to check |
| --- | --- |
| JP IPoE menu is missing | Refresh LuCI or log out and back in after installation. |
| WAN6 has no global IPv6 | Check the WAN device, DHCPv6 interface and logs. Setup handles the NTT DUID-LL client ID automatically. If PPPoE recovery failed, check its interface state too. |
| Preview cannot resolve parameters | WAN6 must already have global IPv6. If it does, your prefix may be outside the bundled lookup; obtain matching manual parameters. |
| MAP-E is up but IPv4 fails, or RX stays zero | Check Legacy MAP, BR address, assigned ports and WAN firewall membership. Incorrect or incomplete MAP-E parameters are common causes. |
| LAN IPv6 does not work | Check whether your line has PD and whether relay/server mode matches it. Test IPv6 separately from IPv4. |
| Inbound service is unreachable | Check the target address, listening service and host firewall. For IPv4, use an assigned external port; for IPv6, use the device's current global address. Test from outside the LAN. |

Use **Force Reconnect / Repair** if the settings are correct but the connection
is stuck. It interrupts traffic; it is not an Internet connectivity test.

## Known limitations

- MAP-E shares an IPv4 address: you can use only your assigned external ports,
  not arbitrary ports such as 80 or 443.
- Outbound allocation uses all assigned port ranges, excluding reservations.
  A selected range can still fill while another has free ports, so this is not
  a guarantee against packet loss under load.
- Connections from the same local source port to different destinations may
  receive different external ports; endpoint-independent NAT is not guaranteed.
- Local checks do not certify end-to-end service availability. Test your own
  line and exposed services; see [validation scope](docs/development.md#validation-scope)
  for what automated tests cover.

## Development and credits

For architecture, command reference, SDK builds and tests, see the
[development guide](docs/development.md). Coding-agent constraints live in
[CLAUDE.md](CLAUDE.md).

Thanks to [fakemanhk/openwrt-jp-ipoe](https://github.com/fakemanhk/openwrt-jp-ipoe)
for the original setup tutorial. Parameter lookup data follows the
[MAP-E calculator](http://ipv4.web.fc2.com/map-e.html).
