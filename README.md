# luci-app-jp-ipoe
### Thanks to fakemanhk/openwrt-jp-ipoe, What a great tutorial!
LuCI helper for Japan NTT IPoE MAP-E connections, focused on OCN Virtual Connect and v6plus (JPNE) style setups.

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

### Outbound port allocation

New TCP/UDP mappings and ICMP echo IDs rotate among the legal contiguous port
segments using native nftables `numgen` / verdict maps. The kernel can choose an
unused port **within the selected segment**, rather than being forced to one
hash-selected port. Manual and managed forwarding reservations split segments;
atomic rule replacement preserves existing conntrack mappings.

This is not a whole-pool allocator: a full segment can still cause packet loss
while another segment has space. Later allocations rotate segments, but neither
immediate cross-segment fallback nor zero loss is guaranteed. Separate connections
from one local source port need not retain the same external port across different
destinations; endpoint-independent mappings are not guaranteed.

## Requirements

- OpenWrt 22.03 or newer with fw4/nftables
- LuCI
- `map` and `conntrack` packages
- a working IPv6 WAN interface using DHCPv6, usually named `wan6`

The package depends on `map` and `conntrack`. On install, it also copies the bundled patched MAP protocol script to `/lib/netifd/proto/map.sh`. If an unpatched stock script already exists, it is backed up to `/lib/netifd/proto/map.sh.orig`.

## Supported Scope

This plugin targets shared IPv4 **MAP-E** service over NTT IPoE. Japan IPoE has three layers: NTT East/West own the fiber and NGN/IPv6 network, a **VNE** (Virtual Network Enabler) operates the actual IPv4-over-IPv6 backend, and retail ISPs resell a VNE under their own brand. What matters for this plugin is the VNE, not the retail brand.

Supported VNE backends — the auto-detect / Preview Parameters feature resolves MAP-E parameters from the WAN6 IPv6 prefix alone for any line on either backend:

- **OCN Virtual Connect** (MAP-E) — OCN, ぷらら (plala), and other ISPs reselling OCN Virtual Connect
- **v6プラス (JPNE)** (MAP-E) — So-net, @nifty, GMOとくとくBB, and other ISPs reselling v6プラス

Because detection keys off each VNE's NTT-NGN prefix blocks, every reseller on these VNEs works the same way regardless of the retail brand name.

Not covered by auto-detect (different VNE, different prefix blocks and BR — none of this data ships with the plugin):

- **IPv6オプション (BIGLOBE)**, **クロスパス (ARTERIA)**, **v6コネクト** — MAP-E, separate backends
- **transix (INTERLINK)** — DS-Lite, a different protocol entirely; not supported

Other MAP-E VNEs *may* work if you fill the MAP-E parameters manually (BR, prefixes, EA/PSID/offset) from a calculator or your ISP router. DS-Lite services cannot work with this plugin at all.

It is also not a general static IPv4 IPoE implementation. If your ISP sells a dedicated static IPv4 service, that may use provider-specific behavior that cannot be derived from normal MAP-E parameters.

## Quick Start

1. Install `luci-app-jp-ipoe`.
2. Make sure `Network > Interfaces` already has a DHCPv6 WAN interface, usually `wan6`.
3. Open `Network > JP IPoE > Configuration`.
4. Set `WAN Physical Device` to the real WAN device, for example `eth0` or `eth1`.
5. Keep `IPv6 WAN Interface Name` as `wan6` unless your interface uses another name.
6. Keep `Use Legacy MAP` enabled for OCN Virtual Connect and v6plus.
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
: Enables legacy MAP behavior. Keep this enabled for OCN Virtual Connect, v6plus, and typical NTT MAP-E setups.

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

Normal Apply / `start` first performs a read-only comparison with the **actual
managed UCI configuration and locally observable runtime**, not a saved success
hash or the frontend dirty flag. It checks WAN6 device/DUID/prefix settings,
MAP bounds and a fresh `mapcalc` result against the running rule, firewall zone
membership, PPPoE metrics, DHCP relay settings/service state, the tunnel address,
MTU/default route, the live SNAT port pool, and managed netifd forwarding data.

When these checks agree, it saves the plugin settings (including boot-only
options) and reports **no restart needed**, without rewriting network/DHCP/firewall
configuration or reloading those services. CLI stdout is `JP_IPOE_UNCHANGED=1`.
A mismatch, missing state, custom opaque MAP rule, or an unsupported inspection
result conservatively falls back to the existing full setup. This is local
readiness, not an Internet reachability test or a comprehensive custom nft audit.

Use **Force Reconnect / Repair** when the interface appears connected but does
not work. It requires confirmation in LuCI and deliberately runs the existing
managed stop/start path, bypassing the shortcut:

```sh
jp-ipoe-setup repair
```

**Repair can interrupt IPv4 and IPv6 traffic.** Ordinary port-forward edits
remain on their separate hot-update path. No last-success snapshot is stored.
The no-op guard and supported nft JSON shapes still require real-device acceptance.

During router boot, including the first boot after firmware refresh, the init service runs:

1. `/usr/sbin/jp-ipoe-setup stop`
2. stops WAN PPPoE fallback interfaces such as `pppoe-wan`
3. restarts the WAN6 interface
4. runs the full JP IPoE start pipeline, bypassing the no-op shortcut
5. starts the stopped PPPoE fallback interfaces only after JP IPoE startup succeeds

Normal service start, service restart, and LuCI apply actions run the regular start/stop path without this boot-only WAN6 recovery sequence.

The setup script:

1. validates that the patched MAP protocol script is installed
2. enables IPv6 on the WAN device when an explicit device section exists
3. configures the WAN6 interface as DHCPv6
4. checks the WAN6 DHCPv6 DUID
5. waits for a global IPv6 address
6. if WAN6 has no IPv6, tears down managed MAP-E state, stops WAN PPPoE fallback interfaces, restarts WAN6, then waits for WAN6 to receive IPv6
7. derives and sets `wan6.ip6prefix` when relay/manual MAP settings need it
8. creates or updates the MAP-E interface and sets its MTU to `1460`
9. adds WAN6 and MAP-E to the WAN firewall zone
10. applies PPPoE fallback metrics if PPPoE interfaces exist
11. configures DHCPv6/RA/NDP relay or restores standard LAN server mode
12. brings up the MAP-E interface and reloads fw4

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
- maps ICMP echo identifiers into the assigned MAP-E port ranges
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

## Locally Checked Port Forwarding

Open **Port Forwarding** and select **IPv4**, **IPv6**, or **IPv4 + IPv6**.
The device selector uses LuCI's existing host hints to show names, MACs and
IPv4 addresses. Selecting a device fills its current IPv4 and global IPv6
addresses; additional IPv6 candidates are offered by the IPv6 input. Manual
entry remains available. This is **not a MAC binding** and does not follow DHCP
or IPv6 privacy-address changes. Verify the selected addresses and service;
prefer stable addresses. The list may omit devices not currently known to LuCI.

### MAP-E IPv4

MAP-E must be up. Enter a host in the main `lan` IPv4 subnet, its service port,
and TCP, UDP, or both. Leave the external port
empty to choose an assigned port automatically, or specify one for validation.
An example is `203.0.113.1:24080 → 192.168.1.10:8080`: only the **public** port
must belong to your MAP-E allocation.

- Checks assigned ranges, manual reservations, protocol-aware configured
  firewall redirects (conservatively across zones/addresses), router bindings
  including IPv6 sockets, and current outbound conntrack mappings.
- Requires `conntrack` and readable kernel socket tables. Running `miniupnpd`
  blocks creation/activation; stop and disable UPnP first. Arbitrary custom nft
  rules, other dynamic mapping services, and external reachability are **not**
  verified. Later configuration changes can still introduce conflicts.
- Stores `forward` sections in `/etc/config/jp_ipoe`; adds no persistent firewall
  redirects and does not rewrite `dont_snat_to`. The SNAT helper excludes the
  union of manual reservations and managed ports for the current public IPv4.
  At least one assigned port must remain for outbound NAT. Managed reservations
  exclude both TCP and UDP, even for a single-protocol forward.
- **Add/delete hot-updates rules without restarting MAP-E or clearing existing
  connections.** Addition atomically reserves SNAT ports, rechecks local
  bindings, updates the selected netifd firewall entry through `set_data`, then
  reloads fw4. Other interface data and firewall entries are preserved. Deletion
  withdraws DNAT and reloads fw4 before releasing the saved SNAT reservation;
  existing sessions can continue until they naturally end. `ucode` (provided by
  fw4) merges the JSON data; no tunnel/network restart or conntrack flush is used.
- A raced/busy port is rejected, not forcibly freed. Failed updates attempt
  rollback without restarting the tunnel. If withdrawal cannot be confirmed,
  the saved rule/reservation is retained and the error explicitly warns that
  forwarding may remain active. Retry deletion; do not assume failure means
  the rule is absent. A failed SNAT refresh can temporarily leave an extra
  reservation rather than risk a collision.
- Saved IPv4 rules survive plugin/router restarts; enabled IPoE boot startup
  restores the tunnel and rechecks them. Stopping MAP-E withdraws live redirects,
  not their saved configuration. On reconnect, incompatible public
  IPv4/port allocations, changed LAN subnets, or detected local conflicts leave
  rules inactive instead of silently changing their external port. Delete and
  recreate an inactive rule. The UI's “Published to tunnel” means netifd carries
  the redirect, **not** that an external client reached the service.
- No NAT loopback/reflection. Test connectivity from outside your LAN. Secure
  the target service before exposing it to the Internet.

### Native IPv6 and dual stack

IPv6 is a persistent fw4 **ACCEPT traffic rule**, not NAT66. Connect to the
**device's global IPv6 address and service port**, for example
`[2001:db8::10]:8080` (documentation address; use your device's actual address).
No MAP-E port allocation or SNAT reservation is involved. The native WAN6
interface must be up; the destination must be routed directly through `lan`,
not the router itself, a link-local/ULA address, a WAN destination or a host
behind another gateway. Checks cover the LAN route and duplicate managed
endpoint/protocol rules, not service availability or other firewall policies.

- Rules are stored in `/etc/config/firewall`, using the reserved
  `jp_ipoe6_*` section/name namespace, and remain visible in **Firewall → Traffic
  Rules**. **Stopping MAP-E or uninstalling this plugin does not remove them.**
  Delete them explicitly. Recreate rules after the device's IPv6 address changes.
- Add/delete uses fw4 reload without restarting interfaces or flushing conntrack.
  Deletion first saves the rule disabled, reloads fw4 and confirms withdrawal,
  then deletes saved state. Unconfirmed withdrawal retains the disabled saved
  rule for retry; runtime access may still exist. Other rules or existing
  connections may still permit access after this rule is removed.
- “Firewall rule installed” only indicates that its named rule was found in the
  live ruleset. An inspection failure is shown as **state unavailable**, not as
  proof that access is closed. Neither status proves external reachability.
- **IPv4 + IPv6 creates two independent rules sequentially**, not an atomic pair.
  On failure, already successful rules remain and the UI warns of possible
  partial completion. Review the list and add only the missing family rather
  than blindly retrying both.

CLI equivalents (mutations use the same setup lock):

```sh
jp-ipoe-setup forward_list
jp-ipoe-setup forward_devices
jp-ipoe-setup forward_add6 tcp 2001:db8::10 8080  # replace with actual device GUA
jp-ipoe-setup forward_add tcp 192.168.1.10 8080
jp-ipoe-setup forward_add tcpudp 192.168.1.10 8080 24080
jp-ipoe-setup forward_remove cfg012345  # IPv4 ID from forward_list
# Use forward_remove with the full jp_ipoe6_* ID to remove an IPv6 rule.
```

Local regression checks (Node.js + POSIX sh/awk, no npm dependencies):

```sh
node tests/port-forwarding.cjs
```

These checks mock OpenWrt services. Optional real-kernel checks use temporary
Linux network namespaces (root, `ip`, `nft`, Python 3; the checker also needs
`ucode` with its `fs` module):

```sh
sudo python3 tests/snat-collision.py                      # TCP/UDP/ICMP, reservations, hot updates
sudo python3 tests/snat-collision.py --scenario time-wait # confirmed conntrack TIME_WAIT collision
sudo python3 tests/snat-collision.py --scenario cross-block # demonstrate the known limitation
sudo python3 tests/snat-checker.py                       # actual nft JSON, valid and corrupted states
```

`--helper /path/to/old/helper` runs the same collision fixture against an older
allocator; the old fixed-port implementation fails the within-block/TIME_WAIT
checks. The TIME_WAIT fixture confirms the real TCP state, then pins only that
isolated entry with a fixed timeout to prevent sequence-dependent reclamation.
These tests do not contact external hosts or alter the host firewall.
They cover native NAT allocation and existing-connection preservation, not live
MAP-E encapsulation or NTT reachability. Real netifd/fw4 operation, reconnects and
end-to-end forwarding still require a separately authorized router test.
No zero-packet-loss claim is made.
The new MAC/native-IPv6/dual-stack changes have not been deployed or accepted on a
router. Acceptance requires separate authorization to deploy the backend and open
one specified IPv6 service, test external access, delete the rule and check its
persistence; reboot/restart testing needs an explicitly approved interruption.

## CLI

The LuCI buttons call the same script you can use over SSH:

```sh
/usr/sbin/jp-ipoe-setup start
/usr/sbin/jp-ipoe-setup repair  # explicitly stop/rebuild managed IPoE
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
- If PPPoE fallback is configured, setup stops WAN PPPoE fallback interfaces, restarts WAN6, and waits for WAN6 to receive IPv6.
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

