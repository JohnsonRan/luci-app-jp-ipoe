# Development guide

For installation and LuCI usage, start with the [user guide](../README.md).
This document covers implementation, maintenance commands and validation.
[CLAUDE.md](../CLAUDE.md) records the invariants coding agents must preserve.

## Build packages

This is an OpenWrt LuCI package, not a standalone binary. `root/` supplies
router filesystem files; `htdocs/` supplies LuCI JavaScript. Runtime package
dependencies are `map` and `conntrack`; fw4 supplies ucode.

The [CI workflow](../.github/workflows/build-packages.yml) builds with OpenWrt
24.10 (`ipk`) and 25.12 (`apk`) SDKs for x86/64 and armsr/armv8. Use an SDK
matching the target firmware and configured package feeds. The supported
runtime kernel baseline is **Linux 6.12**. Stock OpenWrt 24.10 uses 6.6, so its
SDK output is retained for compatible custom `ipk` firmware with a 6.12+ kernel,
not as a claim of stock 24.10 runtime support. Kernel versions alone do not
establish that optional modules or userspace tools are present.

Copy this repository into `package/luci-app-jp-ipoe` in that SDK, then run
these commands from the SDK root:

```sh
./scripts/feeds update luci packages
./scripts/feeds install -p luci luci-base
./scripts/feeds install -p packages map
echo "CONFIG_PACKAGE_luci-app-jp-ipoe=m" >> .config
make defconfig
make package/luci-app-jp-ipoe/compile V=s
```

The [Makefile](../Makefile) uses `luci.mk`. It already invokes `BuildPackage`;
do not add a second invocation or move the include before custom package
hooks. Keep the literal `# call BuildPackage - OpenWrt buildroot signature`
comment so OpenWrt's package scanner discovers the package.

`postinst` installs the bundled MAP handler and refreshes LuCI/rpcd state on a
live upgrade. `prerm` restores the saved stock handler before package helpers
are removed, skipping opkg upgrades (apk uses separate upgrade hooks). It leaves
foreign handlers and their backups untouched. Restoration prepares a same-directory
temporary file before rename. If restoration fails, it preserves the backup and
attempts to remove the owned patched handler: apk continues purging package files
even when pre-deinstall fails. If no usable backup exists, the patched handler is
removed; reinstall `map` to recover stock support. An unwritable filesystem can
prevent both restoration and withdrawal and requires manual recovery. No hook
claims to validate live tunnel behavior.

Bump `PKG_VERSION` / `PKG_RELEASE` when releasing. Tags matching
`v*` trigger a release; a manual workflow run produces a nightly prerelease.
A successful package build is not a live-line connectivity test.

## Runtime architecture

| Component | Responsibility |
| --- | --- |
| [`config.js`](../htdocs/luci-static/resources/view/jp_ipoe/config.js) | One LuCI view with Configuration, Status and Port Forwarding tabs. Calls the backend through `fs.exec`. |
| [`jp-ipoe-setup`](../root/usr/sbin/jp-ipoe-setup) | Validation, setup/stop/repair/boot, shared mutation lock and command dispatch. |
| [`config.sh`](../root/usr/share/jp-ipoe/config.sh) | Loads plugin settings and saved IPv4 forwarding rules from UCI. |
| [`jp-ipoe-info`](../root/usr/libexec/jp-ipoe-info) | Status, BR detection and offline MAP-E parameter lookup. |
| [`map.sh`](../root/usr/share/jp-ipoe/map.sh) | Patched netifd MAP protocol handler; publishes redirects after SNAT reservation. |
| [`jp-ipoe-map-nft`](../root/usr/libexec/jp-ipoe-map-nft) | Generates, checks and removes per-interface SNAT tables. |
| [`jp-ipoe-forward`](../root/usr/libexec/jp-ipoe-forward), [`forward.sh`](../root/usr/share/jp-ipoe/forward.sh) | Validates and updates IPv4 forwarding and native IPv6 allowances. |

Plugin configuration and IPv4 `forward` sections live in `/etc/config/jp_ipoe`.
Native IPv6 allowances are persistent `rule` sections in `/etc/config/firewall`.
New plugin options must stay synchronized across the default UCI file,
`config.sh` and the LuCI form.

Status polling runs every ten seconds only while the Status tab is visible;
entering that tab also refreshes immediately. There is one menu node, not
separate configuration/status pages.

### Kernel diagnostics

`jp-ipoe-info status` includes a `conntrack` object with `count`, `max`,
`insert_failed`, `drop` and `early_drop`. Values are decimal strings (including
`"0"`), avoiding 32-bit JSON truncation; `""` means unavailable. Counts/limits
come from `/proc/sys/net/netfilter/`; failure/eviction counters sum complete
per-CPU `conntrack -S` records. Command failure, an empty dump, missing fields,
malformed numbers or duplicate CPU records must not silently produce zeros.
Failure of this inspection does not fail the rest of interface status.

These are cumulative **system-wide** conntrack counters, not MAP-E port
occupancy, per-interface drops, or end-to-end packet loss. The UI labels this
scope and clears stale fields if a refresh fails. It tolerates older backends
without these fields. There is no background collector or additional package
dependency; polling remains confined to the visible Status tab.

### Apply, repair and boot

Normal `start` first calls the read-only `configuration_is_current` check. It
compares owned UCI settings and observable runtime: WAN6 device/DUID/prefix,
fresh versus active MAP bounds, firewall membership, PPPoE metrics, DHCP
relay/service state, tunnel address/MTU/default route, the live SNAT pool and
managed netifd redirects. It does not rely on a saved success fingerprint.

If all checks match, only plugin settings are committed and stdout is
`JP_IPOE_UNCHANGED=1`. Network/firewall/DHCP configuration is not rewritten and
those services are not reloaded. Missing, opaque or unsupported state takes
the full setup path instead. Keep this checker in sync with changes to owned
configuration and generated SNAT rules. Local readiness does not establish
Internet reachability or audit arbitrary custom nft rules.

The full pipeline validates configuration and the installed MAP handler,
configures WAN6 and its DUID, waits for IPv6, resolves automatic parameters if
enabled, creates MAP-E, updates the WAN zone and LAN IPv6 mode, then brings up
the tunnel. MAP-E MTU is `1460`; PPPoE fallback metric is `200`. A failed apply
after network changes attempts to tear down managed MAP-E state; it is not a full
restore of the user's previous configuration. Required UCI writes, commits,
ifup, odhcpd restart and fw4 reload failures must not be hidden by later logs.
A section newly created by this invocation can be removed even if its initial
options were only partly written. If cleanup itself fails, report partial state;
never claim the router was restored.

`validate_interface_roles()` rejects unsafe/equal names, LAN, a WAN6 that is not
an existing DHCPv6 interface, and a MAP name already used by an unrelated
section/protocol/tunnel. An existing MAP section must use `map-e` and link to
the selected WAN6. Stop applies the same role guards, permitting an already
missing WAN6. These checks intentionally refuse ambiguous legacy partial state
rather than guessing ownership.

Firewall selection is read-only until ownership is validated. Prefer WAN6's
existing unique zone, then the `wan` network's zone, then a uniquely named
`wan` zone. `resolve_ipoe_firewall_zone()` rejects ambiguous membership or an
existing MAP interface in another zone; normal startup checks this before
installing the handler or writing network configuration, and firewall setup
rechecks before adding membership. Stop checks for ambiguous WAN6/MAP membership
before teardown; repair and boot abort if stop is refused. Cleanup removes MAP
membership only from its actual zone. PPPoE fallback selection is confined to
the selected WAN zone, not interfaces merely named `wan` or `pppoe-wan`.
These guards preserve configuration boundaries; they do not add multi-WAN or
multi-LAN support, or serialize external UCI edits.

`repair` deliberately uses managed stop/start and bypasses the shortcut.
When boot startup is enabled, `boot` first stops managed IPoE and WAN PPPoE
interfaces, restarts WAN6, then forces the full pipeline. Ordinary full setup
can also stop PPPoE and retry WAN6 if initial IPv6 acquisition fails. After a
locked operation returns, `run_locked()` attempts to restore its stopped PPPoE
interfaces while still holding the lock, on both success and failure. INT, TERM
and HUP terminate the operation and use the same cleanup path; repeated signals
during restoration are ignored. A restoration failure changes an otherwise
successful result to failure. SIGKILL, power loss and a failed restoration are
not covered by a recovery guarantee. Do not make ordinary Apply perform the unconditional boot recovery
sequence.

### WAN6 identity and MAP parameters

NTT setup uses DHCPv6 DUID-LL: `00030001` followed by the WAN MAC without
separators, for example `00030001aabbccddeeff`. The effective interface/global
DUID is checked first. If needed, only WAN6's `clientid` is written; the global
default DUID is left untouched.

`wan6.ip6prefix` is set when relay or manual MAP/BR parameters require it.
Auto mode also sets it using the resolved rule; PD-matched setups that do not
require it leave it unset.

Automatic lookup uses the bundled [`mape-rules`](../root/usr/share/jp-ipoe/mape-rules)
data: JPNE tables `38` / `31` and OCN table `38_20`. `resolve` supplies the
matched rule as `JP_AUTO_*` shell assignments; `mapcalc` still computes the
host IPv4 address, PSID and ports. Unsupported prefixes fail lookup, rather
than silently selecting another provider. Manual-mode numeric defaults
`20/38/18/6/6` are OCN-oriented, not a universal rule.

### SNAT allocation

The installer copies the patched handler to `/lib/netifd/proto/map.sh`, backing
up an existing unpatched handler as `map.sh.orig`. Preserve its
`JP_IPOE_PATCH_VERSION=` marker. The patch addresses stock first-range-only
SNAT behavior by delegating multi-range allocation to `jp-ipoe-map-nft`.

`build_ranges()` normalizes the legal port union and splits it around manual
and managed forwarding reservations. New TCP/UDP mappings and ICMP echo IDs
use native nftables `numgen inc` and a verdict map to rotate among `pool_*`
chains. Native range SNAT can avoid occupied tuples **inside the selected
segment**, unlike the previous forced single-port mapping. A legal source port
must not be forced through unchanged: its translated tuple may already exist.

This is not whole-pool fallback. A full selected segment can still lose packets
while another segment has space. Later allocations rotate segments, but this
does not guarantee immediate recovery, zero packet loss, or endpoint-independent
mappings across separate destinations.

The helper recreates `inet jpipoe_<cfg>` in one nft transaction, preserving
existing conntrack mappings and removing obsolete pool chains. `check_rules()`
checks the generated chain/rule graph, including singleton ranges; changes to
generation must update the checker. Teardown removes the per-interface table.

### IPv4 forwarding

Creation checks assigned ranges, manual reservations, strict IPv4/subnet
membership and a direct `lan` FIB route, protocol-aware UCI redirects,
router bindings (including IPv6 sockets) and
outbound conntrack mappings. It requires readable socket/conntrack state and
rejects active `miniupnpd`. Custom nft rules, other dynamic mapping services and
external reachability are outside these local checks. `ip -4 route get` rejects
local, indirect and non-LAN destinations even if their addresses fall inside
the LAN subnet. Query failure suspends publication instead of assuming a safe
route. This lookup is a snapshot in its query context, not a proof about future
routes or packets with different policy-routing marks/sources.

The SNAT reservation is the union of manual ports and saved managed ports for
the current public IPv4. A managed reservation excludes both TCP and UDP, even
for a single-protocol forward; at least one port must remain for outbound NAT.
No persistent firewall redirect is created and `dont_snat_to` is not rewritten.

Addition reserves SNAT ports first, rechecks conflicts, then uses netifd
`set_data` and fw4 reload to publish DNAT. The ucode merge changes only the
selected firewall entry, preserving other interface data. `map.sh` follows the
same reservation-before-publication order when rebuilding an interface.

Deletion withdraws DNAT before releasing the saved reservation. An unconfirmed
rollback retains saved state/reservations and reports possible active access;
a failed SNAT refresh can leave an extra reservation rather than risk a collision.
Even stale UCI allocations require readable netifd state before deleting saved
rules. A failed/unknown interface query retains the saved record; it is not
interpreted as an offline interface. Neither path restarts the tunnel nor
flushes conntrack. Existing sessions may
continue after deletion. Rules bind to public IPv4 plus external port;
incompatible allocations or local conflicts suspend them instead of reassigning
them silently. NAT loopback/reflection is not provided.

### Native IPv6, device selection and dual stack

IPv6 uses persistent fw4 ACCEPT rules in the reserved `jp_ipoe6_*` namespace,
not NAT66 or MAP-E reservations. Kernel parsing and a direct `lan` route check
validate the destination. Add/delete reloads fw4 without restarting interfaces
or clearing conntrack. MAP-E need not be up.

Deletion disables and commits the owned rule before reload, confirms withdrawal,
then deletes saved state. Unknown nft state is not confirmed removal: retain
the disabled rule for retry and report inspection failure. Other rules or
existing connections may still allow access. Rules intentionally survive MAP-E
stop, reboot and plugin uninstall; preserve this warning in the UI/user guide.

Device selection uses stock `luci-rpc getHostHints` through the setup wrapper.
It fills current addresses and offers global IPv6 candidates, with manual input
as fallback. It is not dynamic MAC binding. Dual-stack creation executes two
independently saved commands sequentially and must report partial success.
Do not deploy a frontend that uses these commands onto an older backend without
checking compatibility.

## Command reference

LuCI uses the same `/usr/sbin/jp-ipoe-setup` entry point. These examples are for
a router with the package installed. `start`, `repair` and `stop` change network
state; `repair` deliberately interrupts traffic.

```sh
jp-ipoe-setup status
jp-ipoe-setup resolve
jp-ipoe-setup detect_br
jp-ipoe-setup start
jp-ipoe-setup repair
jp-ipoe-setup stop
```

Forwarding mutations use the setup lock. Substitute actual LAN addresses,
assigned external ports and IDs from `forward_list`; the examples below are not
usable public service endpoints. `forward_add` / `forward_add6` expose services.

```sh
jp-ipoe-setup forward_list
jp-ipoe-setup forward_devices
jp-ipoe-setup forward_add tcp 192.168.1.10 8080
jp-ipoe-setup forward_add tcpudp 192.168.1.10 8080 24080
jp-ipoe-setup forward_add6 tcp 2001:db8::10 8080
jp-ipoe-setup forward_remove cfg012345
# For IPv6, use the full jp_ipoe6_* ID from forward_list.
```

If another package replaced the MAP handler, reinstall the bundled copy with
`/usr/libexec/jp-ipoe-install-map` before applying IPoE again.

## Tests

### Mocked regression and syntax checks

From the repository root, with Node.js and POSIX `sh`/`awk` available:

```sh
node tests/port-forwarding.cjs
```

No npm dependencies are required. CI runs this suite before any SDK builds;
Python fixture syntax is also checked there, without executing kernel tests.
The suite includes relay/server-mode startup, interface-role and firewall
ownership guards, failure propagation, cleanup/retry, signal/lock ordering,
PPPoE scoping and BMR-aware status. These tests mock OpenWrt services; they do
not establish live netifd/fw4 or Internet behavior.

### Native kernel checks

Use a Linux test host, not the production router. These checks need root,
`ip`, `nft` and Python 3; the checker also needs native `ucode` with its `fs`
module. They create temporary network namespaces, contact no external hosts,
and do not change the host firewall.

Run from the repository root in a root shell with `uv` and system Python 3
available (no additional Python packages are needed):

```sh
uv run --no-project --offline --python /usr/bin/python3 tests/snat-collision.py
uv run --no-project --offline --python /usr/bin/python3 tests/snat-collision.py --scenario time-wait
uv run --no-project --offline --python /usr/bin/python3 tests/snat-collision.py --scenario cross-block
uv run --no-project --offline --python /usr/bin/python3 tests/snat-checker.py
```

- The default collision fixture covers TCP/UDP/ICMP, reservation hot updates,
  failed transactions and existing-connection preservation.
- `time-wait` confirms a real TCP conntrack TIME_WAIT entry, then sets a fixed
  timeout **only on that isolated entry** to prevent sequence-dependent
  reclamation. It does not fabricate the TCP state.
- `cross-block` demonstrates the accepted limitation: the selected segment
  fills while another still has free ports. A successful test exit does not
  establish cross-segment fallback.
- `snat-checker.py` checks actual nft JSON using native ucode, including valid
  and corrupted rulesets. Use `--ucode /path/to/ucode-wrapper` if needed.

The collision fixture accepts `--protocol tcp|udp|icmp|all` and
`--helper /path/to/old/helper`. The old fixed-port helper fails the within-segment
and pinned TIME_WAIT controls.

## Validation scope

Mock tests cover control flow and generated data. Namespace tests cover native
NAT behavior, not live MAP-E encapsulation or an NTT line. Package builds cover
packaging, not router acceptance. None of these proves zero packet loss or that
a particular Internet connectivity symptom has been fixed.

Live validation must separately cover WAN6/MAP-E startup, reconnects, netifd/fw4
updates and external reachability. Native IPv6 and dual-stack changes also need
real-device checks of address selection, partial failure, external access,
removal and persistence; mocked tests alone do not establish their behavior on
a deployed router.

Agree on scope with the router owner before backend deployment, exposing a
service, or disruptive restart/reboot testing. Frontend-only deployment does
not authorize those actions. Record firmware/kernel versions, tested operations
and remaining gaps in test or release records, rather than treating one
router's deployment history as the product's support contract.

## References

- [RFC 7597: MAP-E](https://datatracker.ietf.org/doc/html/rfc7597)
- [Legacy MAP draft](https://datatracker.ietf.org/doc/html/draft-ietf-softwire-map-03)
- [MAP-E calculator and rule-table source](http://ipv4.web.fc2.com/map-e.html)
- [OCN connectivity test](https://v6test.ocn.ne.jp/)
