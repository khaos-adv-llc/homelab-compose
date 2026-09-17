const STATUS_POLL_MS = 5000;
const claimTokenMatch = location.pathname.match(/^\/claim\/([a-f0-9]+)$/);
const claimToken = claimTokenMatch ? claimTokenMatch[1] : null;

const el = (id) => document.getElementById(id);
const loggedOutEl = el('logged-out');
const loggedInEl = el('logged-in');
const claimBannerEl = el('claim-banner');
const identitiesEl = el('identities');
const linkActionsEl = el('link-actions');

function loginUrl(provider, { link = false } = {}) {
  const returnTo = claimToken ? `/claim/${claimToken}` : '/';
  const params = new URLSearchParams({ returnTo });
  if (link) params.set('link', '1');
  return `/auth/${provider}/login?${params}`;
}

el('login-discord').href = loginUrl('discord');
el('login-fluxer').href = loginUrl('fluxer');

async function loadClaimBanner() {
  if (!claimToken) return;
  try {
    const res = await fetch(`/api/claim/${claimToken}`);
    const info = await res.json();
    claimBannerEl.hidden = false;
    if (!res.ok) {
      claimBannerEl.innerHTML = `<p class="status error">${info.error || 'This link is invalid.'}</p>`;
      return;
    }
    const who = info.requestedByUsername ? `<strong>${info.requestedByUsername}</strong> ` : 'Someone ';
    if (info.claimed) {
      claimBannerEl.innerHTML = `<p class="status connected">This bridge is now managed by <strong>${info.claimedByUsername || 'an admin'}</strong>.</p>`;
    } else if (info.expired) {
      claimBannerEl.innerHTML = `<p class="status error">This hand-off link has expired.</p>`;
    } else {
      claimBannerEl.innerHTML = `<p class="status">${who}asked for help managing the <strong>${info.provider}</strong> side of the bridge for <strong>${info.guildName || 'a server'}</strong>. Log in with an account that administers that server to take over.</p>`;
    }
  } catch {
    claimBannerEl.hidden = true;
  }
}

async function claimIfNeeded() {
  if (!claimToken) return;
  try {
    const res = await fetch(`/api/claim/${claimToken}`, { method: 'POST' });
    const body = await res.json();
    if (!res.ok) {
      claimBannerEl.hidden = false;
      claimBannerEl.innerHTML = `<p class="status error">${body.error}</p>`;
    }
  } catch {
    // best-effort -- the normal per-leg status/controls below still work
    // even if this silently fails.
  }
}

function providerLabel(p) {
  return p === 'discord' ? 'Discord' : 'Fluxer';
}

async function refreshMe() {
  const res = await fetch('/api/me');
  const me = await res.json();

  if (!me.loggedIn) {
    loggedOutEl.hidden = false;
    loggedInEl.hidden = true;
    return null;
  }

  loggedOutEl.hidden = true;
  loggedInEl.hidden = false;

  const byProvider = { discord: null, fluxer: null };
  for (const id of me.identities) byProvider[id.provider] = id.username;

  identitiesEl.textContent = ['discord', 'fluxer']
    .map((p) => (byProvider[p] ? `${providerLabel(p)}: ${byProvider[p]}` : `${providerLabel(p)}: not linked`))
    .join('  ·  ');

  linkActionsEl.innerHTML = '';
  for (const p of ['discord', 'fluxer']) {
    if (byProvider[p]) continue;
    const a = document.createElement('a');
    a.className = `btn btn-${p}`;
    a.href = loginUrl(p, { link: true });
    a.textContent = `Link ${providerLabel(p)}`;
    linkActionsEl.appendChild(a);
  }

  return me;
}

async function loadGuildsAndChannels(provider) {
  const guildSel = el(`${provider}-guild`);
  const channelSel = el(`${provider}-channel`);
  guildSel.innerHTML = '';
  channelSel.innerHTML = '';

  const guilds = await (await fetch(`/api/my-guilds?provider=${provider}`)).json();
  if (!Array.isArray(guilds) || guilds.length === 0) {
    guildSel.innerHTML = '<option>(no servers you admin)</option>';
    return;
  }
  for (const g of guilds) {
    const opt = document.createElement('option');
    opt.value = g.id;
    opt.textContent = g.name;
    guildSel.appendChild(opt);
  }

  async function loadChannels() {
    channelSel.innerHTML = '';
    const channels = await (await fetch(`/api/guilds/${provider}/${guildSel.value}/channels`)).json();
    for (const c of channels) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.joinable === false ? `${c.name} (not joinable)` : c.name;
      opt.disabled = c.joinable === false;
      channelSel.appendChild(opt);
    }
  }
  guildSel.onchange = loadChannels;
  await loadChannels();
}

// Tracks whether the guild/channel pickers have already been populated
// for a given provider during the current "not connected" stretch, so
// the 5s status poll below doesn't keep wiping and rebuilding the
// <select> elements out from under someone mid-click. Reset to false
// once that leg connects, so the pickers load fresh next time it's
// disconnected again.
const pickerLoaded = { discord: false, fluxer: false };

async function refreshLeg(provider) {
  const statusEl = el(`${provider}-status`);
  const pickerEl = el(`${provider}-picker`);
  const connectBtn = el(`${provider}-connect-btn`);
  const disconnectBtn = el(`${provider}-disconnect-btn`);
  const handoffBtn = el(`${provider}-handoff-btn`);
  const handoffLinkEl = el(`${provider}-handoff-link`);

  const res = await fetch('/api/status');
  const data = await res.json();
  const leg = data.legs[provider];

  pickerEl.hidden = true;
  connectBtn.hidden = true;
  disconnectBtn.hidden = true;
  handoffBtn.hidden = true;
  handoffLinkEl.hidden = true;

  if (leg.error) {
    statusEl.textContent = leg.error;
    statusEl.className = 'status error';
    return;
  }

  if (!leg.connected) {
    statusEl.textContent = 'Not bridged right now.';
    statusEl.className = 'status';
  } else {
    const name = leg.current?.channelName || leg.current?.channel_name || 'a voice channel';
    const guild = leg.current?.guildName || leg.current?.guild_name || '';
    statusEl.textContent = `Bridged: ${name} (${guild})`;
    statusEl.className = 'status connected';
  }

  if (!data.loggedIn) return;

  // The picker stays visible whether or not this leg is already bridged --
  // picking a different server/channel and clicking the button switches
  // straight to it (both legs' /connect already tear down any existing
  // connection before making the new one), instead of forcing a separate
  // disconnect click first. Loaded once per page load (pickerLoaded), not
  // on every 5s poll -- see its declaration for why (that's the fix for
  // the dropdown resetting mid-selection).
  pickerEl.hidden = false;
  connectBtn.hidden = false;
  connectBtn.textContent = leg.connected ? 'Switch here' : 'Connect';
  if (!pickerLoaded[provider]) {
    pickerLoaded[provider] = true;
    await loadGuildsAndChannels(provider);
  }
  connectBtn.onclick = async () => {
    connectBtn.disabled = true;
    const guildSel = el(`${provider}-guild`);
    const channelSel = el(`${provider}-channel`);
    const body = {
      provider,
      guildId: guildSel.value,
      channelId: channelSel.value,
      guildName: guildSel.options[guildSel.selectedIndex]?.textContent,
      channelName: channelSel.options[channelSel.selectedIndex]?.textContent,
    };
    const r = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await r.json();
    if (!r.ok) {
      statusEl.textContent = payload.error || 'connect failed';
      statusEl.className = 'status error';
    }
    connectBtn.disabled = false;
    await refreshLeg(provider);
  };

  if (!leg.connected) return;

  if (leg.canControl) {
    disconnectBtn.hidden = false;
    disconnectBtn.onclick = async () => {
      disconnectBtn.disabled = true;
      const r = await fetch('/api/disconnect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const payload = await r.json();
      if (!r.ok) {
        statusEl.textContent = payload.error || 'disconnect failed';
        statusEl.className = 'status error';
      }
      disconnectBtn.disabled = false;
      await refreshLeg(provider);
    };
  } else {
    handoffBtn.hidden = false;
    handoffBtn.onclick = async () => {
      handoffBtn.disabled = true;
      const r = await fetch('/api/handoff/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      const payload = await r.json();
      handoffBtn.disabled = false;
      if (!r.ok) {
        statusEl.textContent = payload.error || 'could not create a hand-off link';
        statusEl.className = 'status error';
        return;
      }
      handoffLinkEl.hidden = false;
      handoffLinkEl.innerHTML = `Share this with a server admin: <a href="${payload.url}">${payload.url}</a>`;
      try { await navigator.clipboard.writeText(payload.url); } catch {}
    };
  }
}

async function refreshServers(provider, loggedIn) {
  const sectionEl = el(`${provider}-servers-section`);
  const listEl = el(`${provider}-servers-list`);
  if (!loggedIn) {
    sectionEl.hidden = true;
    return;
  }
  try {
    const servers = await (await fetch(`/api/servers?provider=${provider}`)).json();
    if (!Array.isArray(servers) || servers.length === 0) {
      sectionEl.hidden = true;
      return;
    }
    listEl.innerHTML = '';
    for (const g of servers) {
      const row = document.createElement('div');
      row.className = 'server-row';

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = g.name;
      row.appendChild(name);

      if (g.botPresent) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-danger';
        removeBtn.textContent = 'Remove bridge';
        removeBtn.onclick = async () => {
          if (!confirm(`Remove the bridge from "${g.name}"? It'll need to be re-invited to come back.`)) return;
          removeBtn.disabled = true;
          const r = await fetch(`/api/guilds/${provider}/${g.id}/leave`, { method: 'POST' });
          const payload = await r.json();
          if (!r.ok) {
            alert(payload.error || 'could not remove the bridge from that server');
            removeBtn.disabled = false;
            return;
          }
          await refreshAll();
        };
        row.appendChild(removeBtn);
      } else {
        const addLink = document.createElement('a');
        addLink.className = 'btn btn-primary';
        addLink.href = g.inviteUrl;
        addLink.target = '_blank';
        addLink.rel = 'noopener noreferrer';
        addLink.textContent = 'Add bridge';
        row.appendChild(addLink);
      }

      listEl.appendChild(row);
    }
    sectionEl.hidden = false;
  } catch {
    sectionEl.hidden = true;
  }
}

async function refreshAll() {
  const me = await refreshMe();
  await Promise.all(['discord', 'fluxer'].map(refreshLeg));
  await Promise.all(['discord', 'fluxer'].map((p) => refreshServers(p, Boolean(me))));
  return me;
}

(async () => {
  await loadClaimBanner();
  const me = await refreshAll();
  if (me && claimToken) await claimIfNeeded();
  setInterval(refreshAll, STATUS_POLL_MS);
})();
