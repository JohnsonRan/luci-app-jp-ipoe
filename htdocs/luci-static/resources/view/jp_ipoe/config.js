'use strict';
'require view';
'require form';
'require fs';
'require ui';
'require uci';
'require poll';
'require tools.widgets as widgets';

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('jp_ipoe')
		]);
	},

	render: function() {
		var self = this;

		var formatCommandOutput = function(res) {
			var output = (res.stderr || res.stdout || '').trim();
			var errors = output.split(/\n/).filter(function(line) {
				return line.indexOf('ERROR:') === 0;
			});

			if (errors.length)
				return _('Setup script exited with code:') + ' ' + res.code + '\n' + errors.join('\n');

			if (output)
				return _('Setup script exited with code:') + ' ' + res.code + '\n' + output.split(/\n/).slice(-8).join('\n');

			return _('Setup script exited with code:') + ' ' + res.code;
		};
		var runSetupAction = function(args, okMessage) {
			return fs.exec('/usr/sbin/jp-ipoe-setup', args).then(function(res) {
				if (res.code === 0)
					ui.addNotification(null, E('p', okMessage), 'info');
				else
					ui.addNotification(null, E('pre', {}, formatCommandOutput(res)), 'error');
			}).catch(function(e) {
				ui.addNotification(null, E('p', _('Error executing setup script:') + ' ' + e.message), 'error');
			});
		};

		var m, s, o;

		m = new form.Map('jp_ipoe', null, _('Configure OCN Virtual Connect (MAP-E) IPoE connection. This plugin uses an existing IPv6 WAN (DHCPv6) interface and manages the MAP-E tunnel settings.'));

		s = m.section(form.NamedSection, 'config', 'jp_ipoe', _('Settings'));
		s.addremove = false;

		o = s.option(form.Flag, 'enabled', _('Enable at Boot'), _('Automatically apply configuration on router startup.'));
		o.default = o.disabled;

		o = s.option(widgets.DeviceSelect, 'wan_device', _('WAN Physical Device'), _('Physical network device used for WAN connection (e.g. eth0).'));
		o.default = 'eth0';
		o.noaliases = true;

		o = s.option(widgets.NetworkSelect, 'wan6_iface', _('IPv6 WAN Interface Name'), _('Name of the existing DHCPv6 interface to use (default: wan6).'));
		o.default = 'wan6';
		o.nocreate = true;

		o = s.option(form.Value, 'mape_iface', _('MAP-E Interface Name'), _('Name for the MAP-E tunnel interface (default: wan6mape).'));
		o.default = 'wan6mape';
		o.datatype = 'string';

		o = s.option(form.Flag, 'legacymap', _('Use Legacy MAP'), _('Enable legacy MAP mode. Required for OCN Virtual Connect.'));
		o.default = o.enabled;
		o.rmempty = false;

		o = s.option(form.Flag, 'auto', _('Auto Parameters'), _('Automatically derive all MAP-E parameters (BR, IPv4/IPv6 prefixes, EA/PSID/offset) from the WAN6 IPv6 prefix, using the built-in OCN rule tables. No need to run the MAP-E calculator. Disable to enter parameters manually.'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.Value, 'br_addr', _('BR Address (Border Relay)'), _('OCN\'s Border Relay IPv6 address (e.g. 2001:f88:...). Use the MAP-E calculator (http://ipv4.web.fc2.com/map-e.html) to obtain this value.'));
		o.datatype = 'ip6addr';
		o.optional = true;
		o.placeholder = '2001:f88:...';
		o.depends('auto', '0');

		o = s.option(form.Value, 'ipaddr', _('IPv4 Prefix (ipaddr)'), _('Mapped IPv4 prefix calculated from the MAP-E calculator (e.g. 153.153.153.153).'));
		o.datatype = 'ip4addr';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'ip4prefixlen', _('IPv4 Prefix Length'), _('Normally 20 for OCN.'));
		o.datatype = 'integer';
		o.default = '20';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'ip6prefix', _('IPv6 Prefix'), _('Mapped IPv6 prefix (e.g. 2400:4050::).'));
		o.datatype = 'ip6addr';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'ip6prefixlen', _('IPv6 Prefix Length'), _('Normally 38 for OCN.'));
		o.datatype = 'integer';
		o.default = '38';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'ealen', _('EA bits length'), _('Normally 18 for OCN.'));
		o.datatype = 'integer';
		o.default = '18';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'psidlen', _('PSID bits length'), _('Normally 6 for OCN.'));
		o.datatype = 'integer';
		o.default = '6';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'offset', _('PSID offset'), _('Normally 6 for OCN.'));
		o.datatype = 'integer';
		o.default = '6';
		o.optional = true;
		o.depends('auto', '0');

		o = s.option(form.Value, 'dont_snat_to', _('Reserved IPv4 Ports'), _('Space-separated IPv4 ports that should never be selected for MAP-E SNAT. Leave empty unless you intentionally reserve fixed inbound service ports.'));
		o.datatype = 'string';
		o.optional = true;
		o.placeholder = '2938 7088 10233';

		o = s.option(form.Flag, 'dhcpv6_relay', _('Enable DHCPv6/NDP Relay'), _('Enable this if your ISP provides only an RA /64 prefix without Prefix Delegation (PD). If you have IPv6-PD, uncheck this to use standard Server mode.'));
		o.default = o.enabled;
		o.rmempty = false;

		var s2 = m.section(form.NamedSection, 'config', 'jp_ipoe', _('Actions'), _('Apply or remove IPoE configuration immediately.'));

		o = s2.option(form.Button, '_apply', _('Apply IPoE Configuration'));
		o.inputstyle = 'action';
		o.onclick = function() {
			ui.addNotification(null, E('p', _('Applying IPoE configuration. Please wait ~30 seconds for IPv6 prefix detection.')), 'info');
			return m.save(null, true).then(function() {
				return runSetupAction(['start'], _('IPoE configuration applied.'));
			});
		};

		o = s2.option(form.Button, '_stop', _('Stop IPoE Interfaces'));
		o.inputstyle = 'negative';
		o.onclick = function() {
			return runSetupAction(['stop'], _('IPoE interfaces stopped.'));
		};

		o = s2.option(form.Button, '_preview', _('Preview Parameters'));
		o.inputstyle = 'neutral';
		o.description = _('Resolve the MAP-E parameters from the current WAN6 IPv6 prefix without applying. Requires WAN6 to have a global IPv6 address.');
		o.onclick = function() {
			return self.previewParams();
		};

		return m.render().then(function(formNode) {
			var configPanel = E('div', { 'id': 'jp-tab-config' }, [
				formNode,
				E('div', {
					'id': 'jp-preview-out',
					'style': 'margin-top:8px; font-family:monospace; white-space:pre-wrap; color:inherit; display:none; padding:8px 10px; border:1px solid rgba(128,128,128,0.4); border-radius:4px; background:rgba(128,128,128,0.08);'
				}, '')
			]);

			var statusPanel = E('div', { 'id': 'jp-tab-status', 'style': 'display:none;' }, self.renderStatusPanel());

			var mkTab = function(name, label, active) {
				return E('li', { 'class': active ? 'cbi-tab' : 'cbi-tab-disabled' }, [
					E('a', {
						'href': '#',
						'click': function(ev) {
							ev.preventDefault();
							self.switchTab(name);
						}
					}, label)
				]);
			};

			var tabmenu = E('ul', { 'class': 'cbi-tabmenu', 'id': 'jp-tabmenu' }, [
				mkTab('config', _('Configuration'), true),
				mkTab('status', _('Status'), false)
			]);

			poll.add(L.bind(self.updateStatus, self), 10);
			requestAnimationFrame(function() { self.updateStatus(); });

			return E('div', { 'class': 'cbi-map' }, [
				E('h2', {}, _('JP IPoE')),
				tabmenu,
				configPanel,
				statusPanel
			]);
		});
	},

	switchTab: function(name) {
		var cfg = document.getElementById('jp-tab-config');
		var stat = document.getElementById('jp-tab-status');
		var menu = document.getElementById('jp-tabmenu');
		if (!cfg || !stat || !menu)
			return;

		var isConfig = (name === 'config');
		cfg.style.display = isConfig ? '' : 'none';
		stat.style.display = isConfig ? 'none' : '';

		var tabs = menu.querySelectorAll('li');
		tabs[0].className = isConfig ? 'cbi-tab' : 'cbi-tab-disabled';
		tabs[1].className = isConfig ? 'cbi-tab-disabled' : 'cbi-tab';

		if (!isConfig)
			this.updateStatus();
	},

	previewParams: function() {
		var out = document.getElementById('jp-preview-out');
		if (out) {
			out.style.display = '';
			out.textContent = _('Resolving parameters from WAN6 prefix...');
		}

		return fs.exec('/usr/sbin/jp-ipoe-setup', ['resolve']).then(function(res) {
			if (res.code === 0 && res.stdout) {
				var p = {};
				res.stdout.split(/\n/).forEach(function(line) {
					var mm = line.match(/^JP_AUTO_(\w+)='?([^']*)'?/);
					if (mm) p[mm[1]] = mm[2];
				});
				if (out)
					out.textContent =
						_('BR') + ': ' + (p.BR || '-') + '\n' +
						_('IPv4 Prefix') + ': ' + (p.IPADDR || '-') + '/' + (p.IP4PREFIXLEN || '') + '\n' +
						_('IPv6 Prefix') + ': ' + (p.IP6PREFIX || '-') + '/' + (p.IP6PREFIXLEN || '') + '\n' +
						'EA / PSID / ' + _('offset') + ': ' + (p.EALEN || '') + ' / ' + (p.PSIDLEN || '') + ' / ' + (p.OFFSET || '');
			} else {
				var err = (res.stderr || '').split(/\n/).filter(function(x) {
					return x.indexOf('ERROR:') === 0;
				}).join(' ');
				if (out) out.textContent = err || _('Could not resolve parameters.');
			}
		}).catch(function(e) {
			if (out) out.textContent = _('Error:') + ' ' + e.message;
		});
	},

	renderStatusPanel: function() {
		var self = this;
		var rows = [
			['s-wan6-iface', _('WAN6 Interface')],
			['s-wan6-device', _('WAN6 Device')],
			['s-wan6-ipv6', _('WAN6 IPv6 Address')],
			['s-mape-iface', _('MAP-E Interface')],
			['s-mape-state', _('MAP-E Tunnel State')],
			['s-mape-ipv4', _('MAP-E IPv4 Address')],
			['s-br-addr', _('Border Relay (BR)')],
			['s-port-info', _('Assigned Port Ranges')],
			['s-pppoe-metric', _('PPPoE Fallback Metric')]
		];

		return [
			E('div', { 'class': 'cbi-map-descr' }, _('Real-time status of OCN Virtual Connect (MAP-E) IPoE interfaces.')),
			E('div', { 'class': 'cbi-section' }, [
				E('table', { 'class': 'table cbi-section-table' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Item')),
						E('th', { 'class': 'th' }, _('Value'))
					])
				].concat(rows.map(function(row, index) {
					return E('tr', { 'class': 'tr cbi-rowstyle-' + (index % 2 + 1) }, [
						E('td', { 'class': 'td left' }, row[1]),
						E('td', { 'class': 'td left', 'id': row[0] }, '-')
					]);
				})))
			]),
			E('div', { 'class': 'cbi-page-actions', 'style': 'display:flex; gap:8px;' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						return this.updateStatus();
					})
				}, _('Refresh')),
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.createHandlerFn(this, function() {
						return this.detectBR();
					})
				}, _('Auto-Detect BR Address')),
				E('span', { 'id': 'action-msg', 'style': 'align-self:center; font-style:italic; color:#888;' })
			])
		];
	},

	updateStatus: function() {
		// Skip the polled status exec when the Status tab is hidden: the poll
		// stays registered but becomes a cheap DOM check, avoiding a process
		// spawn + ubus round-trips every 10s while the user sits on Config.
		// switchTab() calls this directly on entering Status, so display stays
		// instant.
		var stat = document.getElementById('jp-tab-status');
		if (stat && stat.style.display === 'none')
			return Promise.resolve();

		return fs.exec('/usr/sbin/jp-ipoe-setup', ['status']).then(function(res) {
			if (res.code === 0 && res.stdout) {
				try {
					var data = JSON.parse(res.stdout);
					[
						{ id: 's-wan6-iface', text: data.wan6_iface || '-' },
						{ id: 's-wan6-device', text: data.wan6_device || '-' },
						{ id: 's-wan6-ipv6', text: data.wan6_ipv6 || _('Not connected'), ok: !!data.wan6_ipv6 },
						{ id: 's-mape-iface', text: data.mape_iface || '-' },
						{ id: 's-mape-state', text: data.mape_state || 'down', ok: data.mape_state === 'up', bold: true },
						{ id: 's-mape-ipv4', text: data.mape_ipv4 || _('Not assigned'), ok: !!data.mape_ipv4 },
						{ id: 's-br-addr', text: data.br_addr || _('Not set'), ok: !!data.br_addr },
						{ id: 's-port-info', text: data.port_info || '-' },
						{ id: 's-pppoe-metric', text: data.pppoe_fallback_metrics || _('None') }
					].forEach(function(field) {
						this.setField(field.id, field.text, field.ok, field.bold);
					}, this);
				} catch(e) {
					var msg = document.getElementById('action-msg');
					if(msg) msg.textContent = _('Failed to parse status');
				}
			}
		}.bind(this));
	},

	setField: function(id, text, isOk, isBold) {
		var el = document.getElementById(id);
		if (!el)
			return;

		el.textContent = text || '-';
		el.style.color = isOk === true ? '#4caf50' : isOk === false ? '#f44336' : '';
		el.style.fontWeight = isBold === true ? 'bold' : 'normal';
	},

	detectBR: function() {
		var self = this;
		var msg = document.getElementById('action-msg');
		if(msg) msg.textContent = _('Detecting BR address via mapcalc...');

		return fs.exec('/usr/sbin/jp-ipoe-setup', ['detect_br']).then(function(res) {
			if (res.code === 0 && res.stdout) {
				try {
					var data = JSON.parse(res.stdout);
					if (data.error) {
						if(msg) msg.textContent = _('Detection failed') + ': ' + data.error;
						return;
					}

					if(msg) msg.textContent = _('BR address detected') + ': ' + data.br_addr;

					var e = document.getElementById('s-br-addr');
					if (e) {
						e.textContent = data.br_addr;
						e.style.color = '#4caf50';
					}

					if (data.br_addr)
						self.promptSaveBR(data.br_addr);
				} catch (e) {
					if(msg) msg.textContent = _('Failed to parse detection result');
				}
			} else {
				if(msg) msg.textContent = _('Detection failed');
			}
		}).catch(function(e) {
			if(msg) msg.textContent = _('Detection error');
		});
	},

	promptSaveBR: function(br) {
		var self = this;
		ui.showModal(_('Save BR Address'), [
			E('p', {}, _('Save detected BR address to configuration and re-apply IPoE?')),
			E('p', {}, E('strong', {}, br)),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-neutral',
					'click': ui.hideModal
				}, _('Cancel')),
				' ',
				E('button', {
					'class': 'btn cbi-button cbi-button-positive',
					'click': ui.createHandlerFn(self, function() {
						return self.saveAndApplyBR(br);
					})
				}, _('Save & Apply'))
			])
		]);
	},

	saveAndApplyBR: function(br) {
		var msg = document.getElementById('action-msg');
		uci.set('jp_ipoe', 'config', 'br_addr', br);
		return uci.save().then(function() {
			return uci.apply();
		}).then(function() {
			if(msg) msg.textContent = _('BR address saved; re-applying IPoE...');
			return fs.exec('/usr/sbin/jp-ipoe-setup', ['start']);
		}).then(function(res) {
			ui.hideModal();
			if(msg) msg.textContent = (res && res.code === 0)
				? _('BR address saved and IPoE re-applied.')
				: _('BR address saved, but IPoE re-apply failed.');
		}).catch(function(e) {
			ui.hideModal();
			if(msg) msg.textContent = _('Failed to save BR address');
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
