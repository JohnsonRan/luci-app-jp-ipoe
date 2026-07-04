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

	// Lines starting "ERROR:" on stderr are the backend's user-visible failure
	// contract (see CLAUDE.md); every handler that surfaces command failures
	// must extract them through here.
	extractErrorLines: function(text) {
		return (text || '').split(/\n/).filter(function(line) {
			return line.indexOf('ERROR:') === 0;
		});
	},

	formatCommandOutput: function(res) {
		var output = (res.stderr || res.stdout || '').trim();
		var errors = this.extractErrorLines(output);

		if (errors.length)
			return _('Setup script exited with code:') + ' ' + res.code + '\n' + errors.join('\n');

		if (output)
			return _('Setup script exited with code:') + ' ' + res.code + '\n' + output.split(/\n/).slice(-8).join('\n');

		return _('Setup script exited with code:') + ' ' + res.code;
	},

	runSetupAction: function(args, okMessage, failMessage) {
		var self = this;
		return fs.exec('/usr/sbin/jp-ipoe-setup', args).then(function(res) {
			if (res.code === 0)
				ui.addNotification(null, E('p', okMessage), 'info');
			else
				ui.addNotification(null, E('pre', {},
					(failMessage ? failMessage + '\n' : '') + self.formatCommandOutput(res)), 'error');
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Error executing setup script:') + ' ' + e.message), 'error');
		});
	},

	// Single source for the status table: renderStatusPanel builds the rows
	// from id/label, updateStatus fills them via get(data).
	statusFields: function() {
		return [
			{ id: 's-wan6-iface', label: _('WAN6 Interface'), get: function(d) { return { text: d.wan6_iface || '-' }; } },
			{ id: 's-wan6-device', label: _('WAN6 Device'), get: function(d) { return { text: d.wan6_device || '-' }; } },
			{ id: 's-wan6-ipv6', label: _('WAN6 IPv6 Address'), get: function(d) { return { text: d.wan6_ipv6 || _('Not connected'), ok: !!d.wan6_ipv6 }; } },
			{ id: 's-mape-iface', label: _('MAP-E Interface'), get: function(d) { return { text: d.mape_iface || '-' }; } },
			{ id: 's-mape-state', label: _('MAP-E Tunnel State'), get: function(d) { return { text: d.mape_state || 'down', ok: d.mape_state === 'up', bold: true }; } },
			{ id: 's-mape-ipv4', label: _('MAP-E IPv4 Address'), get: function(d) { return { text: d.mape_ipv4 || _('Not assigned'), ok: !!d.mape_ipv4 }; } },
			{ id: 's-br-addr', label: _('Border Relay (BR)'), get: function(d) { return { text: d.br_addr || _('Not set'), ok: !!d.br_addr }; } },
			{ id: 's-port-info', label: _('Assigned Port Ranges'), get: function(d) { return { text: d.port_info || '-' }; } },
			{ id: 's-pppoe-metric', label: _('PPPoE Fallback Metric'), get: function(d) { return { text: d.pppoe_fallback_metrics || _('None') }; } }
		];
	},

	render: function() {
		var self = this;

		var m, s, o;

		m = new form.Map('jp_ipoe', null, _('Configure OCN Virtual Connect / v6plus (MAP-E) IPoE connection using an existing IPv6 WAN (DHCPv6) interface.'));

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

		o = s.option(form.Flag, 'legacymap', _('Use Legacy MAP'), _('Enable legacy MAP mode. Required for OCN Virtual Connect and v6plus.'));
		o.default = o.enabled;
		o.rmempty = false;

		o = s.option(form.Flag, 'auto', _('Auto Parameters'), _('Automatically derive all MAP-E parameters from the WAN6 IPv6 prefix using the built-in OCN/v6plus rule tables. Disable to enter parameters manually.'));
		o.default = o.disabled;
		o.rmempty = false;

		o = s.option(form.Value, 'br_addr', _('BR Address (Border Relay)'), _('Border Relay IPv6 address, from the MAP-E calculator (http://ipv4.web.fc2.com/map-e.html).'));
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
				return self.runSetupAction(['start'], _('IPoE configuration applied.'));
			});
		};

		o = s2.option(form.Button, '_stop', _('Stop IPoE Interfaces'));
		o.inputstyle = 'negative';
		o.onclick = function() {
			return self.runSetupAction(['stop'], _('IPoE interfaces stopped.'));
		};

		o = s2.option(form.Button, '_preview', _('Preview Parameters'));
		o.inputstyle = 'neutral';
		o.description = _('Resolve the MAP-E parameters from the current WAN6 IPv6 prefix without applying. Requires WAN6 to have a global IPv6 address.');
		o.onclick = function() {
			return self.previewParams();
		};

		o = s2.option(form.Button, '_detect_br', _('Auto-Detect BR Address'));
		o.inputstyle = 'neutral';
		o.description = _('Detect the Border Relay address from the live MAP-E rule via mapcalc, then optionally save it and re-apply. Only needed in manual mode; auto mode derives the BR automatically.');
		o.depends('auto', '0');
		o.onclick = function() {
			return self.detectBR();
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

			self.activeTab = 'config';
			poll.add(L.bind(self.updateStatus, self), 10);

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

		this.activeTab = name;
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
		var self = this;
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
				var err = self.extractErrorLines(res.stderr).join(' ');
				if (out) out.textContent = err || _('Could not resolve parameters.');
			}
		}).catch(function(e) {
			if (out) out.textContent = _('Error:') + ' ' + e.message;
		});
	},

	renderStatusPanel: function() {
		return [
			E('div', { 'class': 'cbi-map-descr' }, _('Real-time status of the managed MAP-E IPoE interfaces.')),
			E('div', { 'class': 'cbi-section' }, [
				E('table', { 'class': 'table cbi-section-table' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Item')),
						E('th', { 'class': 'th' }, _('Value'))
					])
				].concat(this.statusFields().map(function(field, index) {
					return E('tr', { 'class': 'tr cbi-rowstyle-' + (index % 2 + 1) }, [
						E('td', { 'class': 'td left' }, field.label),
						E('td', { 'class': 'td left', 'id': field.id }, '-')
					]);
				})))
			]),
			E('div', { 'class': 'cbi-page-actions', 'style': 'display:flex; gap:8px;' }, [
				E('button', {
					'class': 'btn cbi-button cbi-button-action',
					'click': ui.createHandlerFn(this, function() {
						return this.updateStatus();
					})
				}, _('Refresh'))
			])
		];
	},

	updateStatus: function() {
		// Skip the polled status exec while the Status tab is inactive: the
		// poll stays registered but does no work, avoiding a process spawn +
		// ubus round-trips every 10s while the user sits on Config.
		// switchTab() calls this directly on entering Status, so display stays
		// instant.
		if (this.activeTab !== 'status')
			return Promise.resolve();

		return fs.exec('/usr/sbin/jp-ipoe-setup', ['status']).then(function(res) {
			if (res.code === 0 && res.stdout) {
				try {
					var data = JSON.parse(res.stdout);
					this.statusFields().forEach(function(field) {
						var v = field.get(data);
						this.setField(field.id, v.text, v.ok, v.bold);
					}, this);
				} catch(e) {
					ui.addNotification(null, E('p', _('Failed to parse status')), 'error');
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
		ui.addNotification(null, E('p', _('Detecting BR address via mapcalc...')), 'info');

		return fs.exec('/usr/sbin/jp-ipoe-setup', ['detect_br']).then(function(res) {
			var errMsg = _('Detection failed');

			if (res.code === 0 && res.stdout) {
				try {
					var data = JSON.parse(res.stdout);
					if (!data.error && data.br_addr)
						return self.promptSaveBR(data.br_addr);
					if (data.error)
						errMsg += ': ' + data.error;
				} catch (e) {
					errMsg = _('Failed to parse detection result');
				}
			}

			ui.addNotification(null, E('p', errMsg), 'error');
		}).catch(function(e) {
			ui.addNotification(null, E('p', _('Detection error')), 'error');
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
		var self = this;
		uci.set('jp_ipoe', 'config', 'br_addr', br);
		return uci.save().then(function() {
			return uci.apply();
		}).then(function() {
			ui.hideModal();
			return self.runSetupAction(['start'],
				_('BR address saved and IPoE re-applied.'),
				_('BR address saved, but IPoE re-apply failed.'));
		}).catch(function(e) {
			ui.hideModal();
			ui.addNotification(null, E('p', _('Failed to save BR address')), 'error');
		});
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
