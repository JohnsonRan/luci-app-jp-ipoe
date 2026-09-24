# CLAUDE.md

This file records engineering constraints for coding agents working in this repository. User-facing installation and operation belong in [README.md](README.md); implementation explanations, build commands and tests belong in [docs/development.md](docs/development.md). Do not turn the user guide into a session log or deployment-approval record.

## What this is

`luci-app-jp-ipoe` is an OpenWrt LuCI package that configures Japan NTT IPoE **MAP-E** (IPv4-over-IPv6) connections, targeting OCN Virtual Connect and JPNE v6plus lines. It does not build a binary — it installs shell scripts, a patched netifd protocol handler, LuCI views, and UCI config onto an OpenWrt router. `node tests/port-forwarding.cjs` runs dependency-free forwarding regression and syntax checks with mocked OpenWrt services (requires POSIX sh/awk). End-to-end correctness still requires a real OpenWrt device against a live NTT line.

The package layout follows OpenWrt convention: everything under `root/` is copied verbatim to the device filesystem, and `htdocs/` holds the LuCI client-side JS.

## Build / package

There is no standalone package build — it compiles inside the OpenWrt SDK. Local regression/syntax checks use `node tests/port-forwarding.cjs`. The `Makefile` is an OpenWrt `luci.mk` package definition; `postinst` runs `jp-ipoe-install-map` to install the patched `map.sh` and retains LuCI cache/rpcd refresh on live upgrades. Keep the `luci.mk` include after custom package hooks: it already calls `BuildPackage` for the application and translations, so do not call `BuildPackage` again. Keep the `# call BuildPackage - OpenWrt buildroot signature` comment: `include/scan.mk` discovers packages by literal text before evaluating includes; without it this package disappears from menuconfig. `LUCI_DESCRIPTION` supplies menuconfig help text.

CI (`.github/workflows/build-packages.yml`) builds against the OpenWrt SDK for 24.10 (ipk) and 25.12 (apk), x86/64 and arm64. SDK prerequisites and the build recipe are in [Build packages](docs/development.md#build-packages).

Bump `PKG_VERSION` / `PKG_RELEASE` in `Makefile` when releasing. Tagging `v*` triggers a GitHub release; `workflow_dispatch` produces a nightly prerelease.

## Architecture

The system has three layers that must stay in sync: **LuCI UI → orchestration script → netifd protocol handler**.

### 1. Configuration model (UCI)

Plugin settings and IPv4 state live in `/etc/config/jp_ipoe`: section `config` of type `jp_ipoe`, plus user-created IPv4 `forward` sections loaded by `jp_forward_load_rule` in `config.sh`. Native IPv6 allowances instead use persistent `rule` sections in `/etc/config/firewall`, in the reserved `jp_ipoe6_*` section/name namespace. Defaults seeded by `root/etc/config/jp_ipoe`; full default values (including MAP-E params 20/38/18/6/6 for OCN) are loaded by `jp_ipoe_config_load` in `root/usr/share/jp-ipoe/config.sh`. **Any new config option must be added in three places**: the default config file, `config.sh` (`config_get`), and the LuCI form `htdocs/.../jp_ipoe/config.js`.

### 2. Orchestration: `jp-ipoe-setup`

`root/usr/sbin/jp-ipoe-setup` is the entry point for everything. Subcommands include `start`, `repair`, `stop`, `boot`, `status`, `detect_br`, `resolve`, and the forwarding commands. Normal `start` first calls the read-only `configuration_is_current` shortcut: compare owned UCI values, freshly calculated versus active MAP bounds, local address/route/service state, live SNAT pool (`jp-ipoe-map-nft check`) and managed netifd redirect data. Unknown/missing inspection results fall back to the existing pipeline. No persisted last-success fingerprint. A successful no-op saves only `jp_ipoe` and prints `JP_IPOE_UNCHANGED=1`; it must not reload services or rewrite network/firewall/DHCP. `repair` uses the existing managed stop/start path and forces the full pipeline; `boot` also bypasses the shortcut. These local checks do not prove Internet reachability or audit arbitrary custom nft rules. Changes to owned options in the setup helpers must also update `configuration_is_current` (or conservatively disable its shortcut); changes to SNAT generation must keep its read-only checker in sync.

When required, `start` runs the strict pipeline (`cmd_start`): validate config → ensure patched `map.sh` is installed → configure WAN6 (DHCPv6 + DUID-LL) → wait for IPv6 → create MAP-E interface → add to firewall zone → DHCPv6/NDP relay → bring up tunnel. Any failure after network config triggers `rollback_failed_start`, which tears down the managed MAP-E interface so a failed apply never leaves half-state.

Key behaviors that are easy to break:
- **DUID-LL** (`ensure_wan6_duid_ll`): NTT NGN requires DHCPv6 DUID-LL (`00030001` + WAN MAC). The script only writes an interface-level `clientid` when the effective DUID isn't already correct, and never touches the global default DUID.
- **PPPoE fallback conflict** (`recover_wan6_after_pppoe_conflict`, `cmd_boot`): `boot` first stops managed IPoE and WAN PPPoE interfaces, restarts WAN6, then forces the full startup pipeline. Ordinary full setup can also stop PPPoE and retry WAN6 if initial IPv6 acquisition fails. Stopped PPPoE interfaces are restored only after IPoE succeeds; their `metric=200` lowers route priority. Keep the unconditional boot sequence separate from normal `start`.
- **`ip6prefix` handling** (`wan6_ip6prefix_required`): `wan6.ip6prefix` is only set when relay mode or manual MAP/BR params are in use; PD-matched lines leave it unset.

The init script `root/etc/init.d/jp_ipoe` (procd, START=95) only runs when `enabled=1`; `boot()` calls `jp-ipoe-setup boot`, while `restart`/`reload` use the plain `start`/`stop` path.

### 3. Patched netifd protocol: `map.sh` + nft helper

`root/usr/share/jp-ipoe/map.sh` is a patched copy of OpenWrt's stock `/lib/netifd/proto/map.sh`. It is installed to `/lib/netifd/proto/map.sh` by `jp-ipoe-install-map` (backing up the stock script to `map.sh.orig` if present). The marker `JP_IPOE_PATCH_VERSION=` is how both the installer and `validate_map_protocol` detect whether the patched version is in place — **keep that marker when editing `map.sh`**.

The patch's purpose: stock OpenWrt only SNATs to the *first* assigned MAP-E port range. Japan MAP-E assigns multiple non-contiguous port ranges. In `proto_map_setup`, when `RULE_*_PORTSETS` has multiple ranges, it delegates firewall setup to `jp-ipoe-map-nft setup` instead of emitting a single SNAT object.

`root/usr/libexec/jp-ipoe-map-nft` builds a dedicated nftables table (`jpipoe_<cfg>`). `build_ranges` normalizes the assigned port union and splits it around manual/managed reservations. New TCP/UDP mappings and ICMP echo IDs use `numgen inc` + a verdict map to rotate among `pool_*` chains, with native range SNAT choosing a free port inside the selected segment. Do not restore forced single-port preservation: a legal source port can already be occupied. This is deliberately not whole-pool fallback; a full segment can still drop packets while another segment has space, and endpoint-independent mappings across separate connections are not guaranteed. Recreating the table happens in one nft transaction and leaves existing conntrack mappings intact. Keep `check_rules` synchronized with the full generated chain/rule graph. Tables are torn down on `proto_map_teardown`.

Optional root/Linux regressions and experimental commands are documented under [Tests](docs/development.md#tests). Preserve the fixture boundaries: real TCP/UDP/ICMP allocation and existing-connection checks; TIME_WAIT pinning only in the isolated fixture; cross-block success meaning the limitation was demonstrated, not solved; actual nft JSON checked with native ucode. These supplement, not replace, mocked regressions and live OpenWrt/NTT acceptance. NFQUEUE experiments are not production allocator code.

### 4. Status/detection helper: `jp-ipoe-info`

`root/usr/libexec/jp-ipoe-info` outputs JSON for the LuCI status page (`status`) and runs `mapcalc` for BR-address auto-detection (`detect_br`, `lookup_br`). `jp-ipoe-setup status`/`detect_br` are thin wrappers that load config and forward to this helper. The LuCI status page polls `jp-ipoe-setup status` every 10s.

It also resolves the full MAP-E rule from the WAN6 IPv6 prefix alone (`resolve <wan6_iface>` / `resolve_addr <ipv6>`), replicating the lookup logic of `ipv4.web.fc2.com/map-e.html` offline. The rule tables (`38`/`31` for JPNE v6plus, `38_20` for OCN Virtual Connect; ~690 entries ported verbatim from that page) live in `root/usr/share/jp-ipoe/mape-rules` (`<table> <hexkey> <octets...>`). `resolve` prints shell-eval `JP_AUTO_*` assignments (ipaddr, ip4prefixlen, ip6prefix, ip6prefixlen, ealen, psidlen, offset, BR) and exits non-zero when the prefix is not on a covered VNE. The per-host IPv4/PSID/ports are still computed by `mapcalc` downstream — `resolve` only supplies the matched rule.

### Auto mode

When `auto=1`, `apply_network_config` calls `apply_auto_params` (after WAN6 IPv6 is up, before `setup_mape`) to override the loaded `IPADDR`/`IP4PREFIXLEN`/`IP6PREFIX`/`IP6PREFIXLEN`/`EALEN`/`PSIDLEN`/`OFFSET`/`BR_ADDR` vars from the `resolve` output, so the rest of the pipeline is unchanged. `auto=1` also forces `wan6_ip6prefix_required` true (the resolved params behave like manual params). The LuCI form hides all manual MAP-E fields when `auto` is enabled.

### Port forwarding

`jp-ipoe-setup forward_list/forward_add/forward_add6/forward_remove` dispatch to `root/usr/libexec/jp-ipoe-forward`; mutations share the setup lock. The following describes the IPv4 path. `root/usr/share/jp-ipoe/forward.sh` supplies validation, allocation, local conflict checks and netifd redirect emission. Creation checks LAN membership, UCI redirects, sockets and conntrack; requires `conntrack` and refuses active `miniupnpd`. Add/remove hot-update the live SNAT pool and use netifd `set_data` + fw4 reload, without ifdown/ifup or conntrack deletion. The ucode merge changes only the selected firewall entry and preserves other interface data. Delete withdraws DNAT before releasing its reservation; an unconfirmed rollback retains the saved rule/reservation and reports partial state, never stops the tunnel. `map.sh` first installs the SNAT reservation union (manual + managed ports for this public IP), then rechecks local conflicts and emits dynamic fw4 redirects. Never publish DNAT before reservation. Rules bind to public IPv4 + external port; incompatible allocations are suspended, not silently reassigned. No persistent firewall redirects or edits to manual `dont_snat_to`. Published runtime data is not external reachability proof; custom nft rules are outside local checking scope.

Native IPv6 uses the `jp_forward6_*` functions in the command helper: validate the global destination using kernel IPv6 parsing and a direct `lan` route, then persist a standard fw4 ACCEPT traffic rule. It neither reserves MAP-E ports nor requires MAP-E to be up. Removal disables/commits the owned rule before fw4 reload, confirms its absence, then deletes saved state; unknown nft state must not be treated as confirmed withdrawal. `forward_list` merges IPv4 and IPv6 entries, with an `inspection_failed` flag when native runtime state cannot be read. IPv6 rules deliberately survive MAP-E stop, reboot and plugin uninstall; the UI must disclose this and their fixed-address semantics. They can also be removed from LuCI Firewall. No restart/hotplug layer is needed for these native persistent rules.

`forward_devices` forwards to stock `ubus call luci-rpc getHostHints`; the view still goes through the setup script and falls back to manual address input if hints are unavailable. MAC selection only fills current addresses, with GUA IPv6 candidates in a native datalist; it is not dynamic binding. Dual-stack creation is two sequential, independently saved commands with explicit partial-failure feedback, not a transaction. Do not redeploy a frontend using these commands onto an older backend without a compatibility check. Backend deployment and public-service exposure require separate authorization from frontend-only deployment.

### 5. LuCI frontend

A single view `htdocs/luci-static/resources/view/jp_ipoe/config.js` renders a client-side three-tab page (no reload between tabs): **Configuration** (the `form.Map` + Apply/Stop/Preview buttons), **Status** (the read-only status table, polled every 10s), and **Port Forwarding** (local-checked add/delete, refreshed on entry or user action). The status poll stays registered but `updateStatus` short-circuits while the Status panel is hidden (it only runs `jp-ipoe-setup status` when the panel is visible), so sitting on the Configuration tab costs no recurring `fs.exec`; `switchTab` calls `updateStatus` directly on entering Status for an instant refresh. Tab switching toggles panel `display` and `cbi-tab`/`cbi-tab-disabled` classes — there is one menu node (`admin/network/jp_ipoe` → `jp_ipoe/config`), not a parent with status/config children. The **Preview Parameters** button calls `jp-ipoe-setup resolve` and shows the auto-resolved params inline without applying. ACL grants `exec` on `jp-ipoe-setup` and `uci` access to `jp_ipoe` in `root/usr/share/rpcd/acl.d/`. The view talks to the backend **only** through `jp-ipoe-setup` (`fs.exec`) — there is no rpcd method; the ACL whitelists the script by path, so any subcommand is allowed.

## Conventions

- POSIX `sh` only (BusyBox ash on device) — no bashisms. Source `/lib/functions.sh` and use `config_*` / `uci` helpers, not hand-rolled parsing.
- Logging goes through `log` / `log_err` (in `jp-ipoe-setup`), which write to both `logger -t jp-ipoe` and stderr. Lines starting `ERROR:` are parsed back out by the LuCI Apply handler, so keep that prefix for user-visible failures.
- `mapcalc` lookups respect `RULE_BMR` (the matched rule index), falling back to `RULE_1_*` — see `mapcalc_lookup` / `jp_ipoe_info_mapcalc_lookup` (duplicated in both scripts).
- Translations: `po/templates/jp_ipoe.pot` and `po/zh_Hans/`. Wrap user-facing LuCI strings in `_()`.
- MAP-E MTU is fixed at 1460 (`MAPE_MTU`); PPPoE fallback metric at 200 (`PPPOE_FALLBACK_METRIC`).
