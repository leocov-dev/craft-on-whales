// mc-router page: global settings save + per-server hostname/auto-scale routing.
import { toast } from '../lib/toast.js';
import { withBusy } from '../lib/loading.js';

const page = document.getElementById('mc-router-page');
if (page) init();

function init() {
  document.getElementById('mr-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const body = {
      enabled: document.getElementById('mr-enabled').checked,
      listenPort: Number(document.getElementById('mr-port').value),
      autoScaleUp: document.getElementById('mr-scale-up').checked,
      autoScaleDown: document.getElementById('mr-scale-down').checked,
      autoScaleDownAfter: document.getElementById('mr-scale-after').value.trim(),
      autoScaleAsleepMotd: document.getElementById('mr-motd-asleep').value,
      autoScaleLoadingMotd: document.getElementById('mr-motd-loading').value,
    };
    await withBusy(btn, 'Saving…', async () => {
      const res = await request('/api/mc-router', 'POST', body);
      if (res) toast(body.enabled ? 'mc-router enabled.' : 'mc-router disabled.');
    });
  });

  document.getElementById('mr-routes-table')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-route-save]');
    if (!btn) return;
    const row = btn.closest('[data-server-id]');
    const hostname = row.querySelector('[data-route-hostname]').value.trim();
    const autoScale = row.querySelector('[data-route-autoscale]').value || null;
    await withBusy(btn, 'Saving…', async () => {
      const res = await request(`/api/servers/${row.dataset.serverId}`, 'PATCH', {
        routerHostname: hostname,
        routerAutoScale: autoScale,
      });
      if (res) {
        toast(
          res.needsRecreate
            ? 'Route saved — applies the next time this server starts, or recreate it now to apply immediately.'
            : 'Route saved.'
        );
      }
    });
  });

  async function request(url, method, body) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        toast(data.error || `Request failed (${res.status})`, { kind: 'error', timeout: 8000 });
        return null;
      }
      return data;
    } catch (err) {
      toast(`Network error: ${err.message}`, { kind: 'error' });
      return null;
    }
  }
}
