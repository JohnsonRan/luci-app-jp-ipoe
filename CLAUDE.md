# CLAUDE.md

Engineering constraints for coding agents. User-facing docs live in [README.md](README.md); implementation details, build recipe and tests in [docs/development.md](docs/development.md). Keep this file to rules that are easy to break, not a session log.

## What this is

OpenWrt LuCI package for Japan NTT IPoE **MAP-E** (OCN Virtual Connect, JPNE v6plus). No binary: shell scripts, a patched netifd `map.sh`, a LuCI view and UCI config. `root/` is copied verbatim to the device; `htdocs/` is LuCI JS. Runtime baseline: Linux 6.12, BusyBox ash.

- Tests: `node tests/port-forwarding.cjs` (mocked OpenWrt, needs POSIX sh/awk). Real correctness still needs an OpenWrt device on a live NTT line.
- Build only inside the OpenWrt SDK (`luci.mk`). Keep the `luci.mk` include after the custom postinst/prerm hooks, do not call `BuildPackage` again, and keep the literal `# call BuildPackage - OpenWrt buildroot signature` comment (scan.mk needs it). CI: `.github/workflows/build-packages.yml` (24.10 ipk, 25.12 apk). Bump `PKG_VERSION`/`PKG_RELEASE` for releases.

## Layout

| Path | Role |
|---|---|
| `root/usr/sbin/jp-ipoe-setup` | Entry point: `start`, `repair`, `apply`/`apply_repair`/`apply_status`, `stop`, `boot`, `status`, `resolve`, `forward_*`. Mutations run under `run_locked`. |
| `root/usr/share/jp-ipoe/config.sh` | `jp_ipoe_config_load` defaults, shared helpers (`jp_ipoe_mapcalc_lookup`, `find_pppoe_sections`). |
| `root/usr/share/jp-ipoe/map.sh` | Patched netifd MAP protocol; installed by `jp-ipoe-install-map` (backup `map.sh.orig`, `restore` on prerm). |
| `root/usr/libexec/jp-ipoe-map-nft` | Multi-range SNAT table `inet jpipoe_<cfg>`. |
| `root/usr/libexec/jp-ipoe-info` | Status JSON, offline rule lookup (`resolve`, `resolve_addr`) from `mape-rules`. |
| `root/usr/libexec/jp-ipoe-forward` + `share/jp-ipoe/forward.sh` | IPv4 DNAT forwards (netifd data) and native IPv6 fw4 rules. |
| `root/usr/libexec/jp-ipoe-readonly` | Only exec path for the read ACL. |
| `htdocs/.../view/jp_ipoe/config.js` | Single view, three client-side tabs (Configuration / Status / Port Forwarding). |

## Invariants

**Config**
- Manual mode (`auto=0`) requires `br_addr`, `ipaddr` and `ip6prefix`: mapcalc skips a rule without prefixes, so `validate_config` and the form (`rmempty=false`) both refuse before any write.
- A new option goes in `root/etc/config/jp_ipoe`, `config.sh` and `config.js`. If setup writes something from it, also compare it in `configuration_is_current`. If it is only consumed at runtime (like `dont_snat_to` by the SNAT helper), validate it in `validate_config` and make sure the unchanged path re-applies it (`refresh_snat_reservations`), or Apply silently does nothing.

**Start / stop**
- `start` first runs `configuration_is_current`, which compares owned UCI state, interface/odhcpd liveness, the running MAP rule against a fresh `mapcalc`, and whether the SNAT table exists. A match only commits `jp_ipoe`, rebuilds the live SNAT table from the current reservations (`jp-ipoe-forward refresh_snat`, one nft transaction, failure fails the Apply) and prints `JP_IPOE_UNCHANGED=1`, with no service reloads or network/firewall/DHCP writes. Runtime drift is what `repair` (forced stop+start) is for. `boot` also bypasses the shortcut. No persisted success fingerprint.
- LuCI never runs `start`/`repair` in the foreground: rpcd `file.exec` SIGKILLs at its exec timeout (30s stock) and LuCI's XHR gives up at 20s, while a full setup waits minutes for WAN6. LuCI calls `apply`/`apply_repair` (detached, log in `/tmp/jp-ipoe-apply.log`) and polls read-only `apply_status` until a `JP_IPOE_APPLY_RC=<n>` line appears.
- `bringup_mape` waits (bounded) for the MAP interface to be up; a netifd handler error (`errors[0].code`, e.g. `INVALID_MAP_RULE`) or a timeout fails the start with an `ERROR:` line. `ifup` alone is not success.
- `init.d/jp_ipoe` must not have a config reload trigger. rpcd's `uci commit` (LuCI Apply) emits `config.change`, and a restart would tear MAP-E down behind the explicit Apply run.
- Failed full setup calls `rollback_failed_start`, which is managed MAP-E teardown and not a transaction. Report cleanup failure as partial state. Once WAN6 is configured, it stays through later failures and through Stop.

**Ownership guards**
- `validate_interface_roles`: WAN6 is missing or DHCPv6; MAP is missing or `map`/`map-e` with `tunlink`=WAN6; never LAN or equal names.
- `find_firewall_zone` / `resolve_ipoe_firewall_zone`: return 1 when missing, 2 when ambiguous; never move MAP into a second zone. PPPoE selection is scoped to the WAN zone.
- Do not loosen either set of guards.

**DUID and prefix**
- DUID-LL is `00030001`+WAN MAC, written only as the WAN6 `clientid`. Never touch the global DUID.
- Every valid configuration (auto or complete manual MAP/BR parameters) manages `wan6.ip6prefix`, regardless of LAN relay mode. Derive it from current WAN6 state, never a saved prefix.

**PPPoE fallback**
- `boot` stops managed IPoE and WAN PPPoE, restarts WAN6, then forces full setup. This sequence is explicitly required by the user; do not simplify away stop or WAN6 restart. Keep this separate from normal `start`.
- `run_locked` restores stopped PPPoE while still holding the lock, on success, failure and INT/TERM/HUP. A failed restore makes the operation fail.

**Patched `map.sh`**
- Keep the `JP_IPOE_PATCH_VERSION=` marker; install/restore depend on it.
- prerm restores the stock backup atomically or withdraws the patched handler. Never touch foreign handlers or backups.

**SNAT**
- Rotate among `pool_*` chains via `numgen inc` + vmap, with range SNAT inside the selected segment.
- Do not force single-port preservation.
- Recreate the table in one nft transaction.

**IPv4 forwarding**
- Reserve SNAT ports before publishing DNAT.
- Release a reservation only after withdrawal is confirmed.
- Unknown runtime state keeps the saved rule.
- No persistent firewall redirects; no edits to manual `dont_snat_to`.

**IPv6 forwarding**
- Persistent fw4 ACCEPT rules in the `jp_ipoe6_*` namespace that survive stop and uninstall; the UI must say so.

**LuCI and backend output**
- Read ACL execs only `jp-ipoe-readonly` (`status`, `resolve`, `apply_status`, `forward_list`, `forward_devices`); the write ACL execs `jp-ipoe-setup`.
- Apply commits only `jp_ipoe` (never `uci.apply`), and save/commit failure stops the chain.
- Backend lines starting with `ERROR:` are what LuCI shows the user; keep the prefix.
- Status conntrack values: empty means unavailable, never zero.

**Deployment**
- Backend deployment and public-service exposure need separate authorization from frontend-only deployment.
- Check backend compatibility before deploying a newer frontend.

## Conventions

- POSIX `sh` only; use `/lib/functions.sh` `config_*` / `uci`, not hand-rolled parsing.
- Log through `log` / `log_err` (logger + stderr).
- Wrap UI strings in `_()` and keep `po/templates/jp_ipoe.pot` and `po/zh_Hans/` in sync.
- Constants: MAP-E MTU 1460 (`MAPE_MTU`), PPPoE fallback metric 200 (`PPPOE_FALLBACK_METRIC`).
