'use strict';
'require view';
'require fs';
'require ui';
'require poll';
'require uci';

return view.extend({
	load: function() {
		return Promise.all([
			uci.load('jp_ipoe')
		]);
	},

	render: function() {
		var container = E('div', { 'class': 'cbi-map' }, [
			E('h2', { 'name': 'content' }, _('JP IPoE Status')),
			E('div', { 'class': 'cbi-map-descr' }, _('Real-time status of OCN Virtual Connect (MAP-E) IPoE interfaces.')),
			
			E('div', { 'class': 'cbi-section' }, [
				E('table', { 'class': 'table cbi-section-table' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, _('Item')),
						E('th', { 'class': 'th' }, _('Value'))
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-1' }, [
						E('td', { 'class': 'td left' }, _('WAN6 Interface')),
						E('td', { 'class': 'td left', 'id': 's-wan6-iface' }, '-')
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-2' }, [
						E('td', { 'class': 'td left' }, _('WAN6 Device')),
						E('td', { 'class': 'td left', 'id': 's-wan6-device' }, '-')
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-1' }, [
						E('td', { 'class': 'td left' }, _('WAN6 IPv6 Address')),
						E('td', { 'class': 'td left', 'id': 's-wan6-ipv6' }, '-')
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-2' }, [
						E('td', { 'class': 'td left' }, _('MAP-E Interface')),
						E('td', { 'class': 'td left', 'id': 's-mape-iface' }, '-')
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-1' }, [
						E('td', { 'class': 'td left' }, _('MAP-E Tunnel State')),
						E('td', { 'class': 'td left', 'id': 's-mape-state' }, '-')
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-2' }, [
						E('td', { 'class': 'td left' }, _('MAP-E IPv4 Address')),
						E('td', { 'class': 'td left', 'id': 's-mape-ipv4' }, '-')
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-1' }, [
						E('td', { 'class': 'td left' }, _('Border Relay (BR)')),
						E('td', { 'class': 'td left', 'id': 's-br-addr' }, '-')
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-2' }, [
						E('td', { 'class': 'td left' }, _('Assigned Port Ranges')),
						E('td', { 'class': 'td left', 'id': 's-port-info' }, '-')
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-1' }, [
						E('td', { 'class': 'td left' }, _('Recoverable State')),
						E('td', { 'class': 'td left', 'id': 's-restore-state' }, '-')
					]),
					E('tr', { 'class': 'tr cbi-rowstyle-2' }, [
						E('td', { 'class': 'td left' }, _('PPPoE Fallback Metric')),
						E('td', { 'class': 'td left', 'id': 's-pppoe-metric' }, '-')
					])
				])
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
		]);

		poll.add(L.bind(this.updateStatus, this), 10);
		this.updateStatus();

		return container;
	},

	updateStatus: function() {
		return fs.exec('/usr/sbin/jp-ipoe-setup', ['status']).then(function(res) {
			if (res.code === 0 && res.stdout) {
				try {
					var data = JSON.parse(res.stdout);
					
					var setField = function(id, text, isOk, isBold) {
						var el = document.getElementById(id);
						if (el) {
							el.textContent = text || '-';
							el.style.color = '';
							el.style.fontWeight = 'normal';
							if (isBold === true) el.style.fontWeight = 'bold';
							if (isOk === true) el.style.color = '#4caf50';
							if (isOk === false) el.style.color = '#f44336';
						}
					};

					[
						{ id: 's-wan6-iface', text: data.wan6_iface || '-' },
						{ id: 's-wan6-device', text: data.wan6_device || '-' },
						{ id: 's-wan6-ipv6', text: data.wan6_ipv6 || _('Not connected'), ok: !!data.wan6_ipv6 },
						{ id: 's-mape-iface', text: data.mape_iface || '-' },
						{ id: 's-mape-state', text: data.mape_state || 'down', ok: data.mape_state === 'up', bold: true },
						{ id: 's-mape-ipv4', text: data.mape_ipv4 || _('Not assigned'), ok: !!data.mape_ipv4 },
						{ id: 's-br-addr', text: data.br_addr || _('Not set'), ok: !!data.br_addr },
						{ id: 's-port-info', text: data.port_info || '-' },
						{ id: 's-restore-state', text: data.has_restore_state ? _('Available') : _('None'), ok: !!data.has_restore_state },
						{ id: 's-pppoe-metric', text: data.pppoe_fallback_metrics || _('None') }
					].forEach(function(field) {
						setField(field.id, field.text, field.ok, field.bold);
					});
				} catch(e) {
					var msg = document.getElementById('action-msg');
					if(msg) msg.textContent = _('Failed to parse status');
				}
			}
		});
	},

	detectBR: function() {
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

					if (data.br_addr && confirm(_('Save detected BR address to configuration?\n') + data.br_addr)) {
						uci.set('jp_ipoe', 'config', 'br_addr', data.br_addr);
						return uci.save().then(function() {
							return uci.apply();
						}).then(function() {
							if(msg) msg.textContent = _('BR address saved to config.');
						});
					}
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
	
	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
