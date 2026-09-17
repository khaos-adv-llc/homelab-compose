// Single control surface for the Fluxer<->Discord voice bridge, reachable
// at one public URL (per Tucker, Sept 17 2026: "a single front facing
// fluxerbridge.valdeze.ch url, simple and clean"). This REPLACES the
// earlier two-panel design (web-panel + user-panel) -- see README.md's
// "Access model, v3" section for why, and the project doc for the full
// history of how this evolved.
//
// ACCESS MODEL (v3):
//   - Log in with Discord OR Fluxer OAuth2. Either creates or resumes an
//     "account" in the local database (db.js), which you can then attach
//     your OTHER platform's identity to as well ("link account").
//   - There is no separate admin login and no Authentik group anymore.
//     Instead, "can you control the bridge on platform X for guild Y" is
//     answered live, every time, by asking that platform itself (via the
//     relevant leg's bot) whether any of your linked identities on X is an
//     admin (Administrator or Manage Server, on Discord; see fluxer-leg's
//     is_guild_admin for the Fluxer equivalent and its caveats) of guild Y
//     right now. Nothing about "being an admin" is stored here or trusted
//     from a token -- it's re-checked on every sensitive action.
//   - If you're not an admin of the guild that's (or should be) bridged,
//     you can generate a hand-off link and send it to someone who is. That
//     link carries NO authority of its own -- it's just a pointer plus
//     some context ("X wants help bridging Y"). Whoever opens it still has
//     to log in and pass the same live admin check as anyone else. See the
//     /claim routes below.
//
// This is what actually lets a non-admin who wants the bridge running ask
// a real admin to grant it, per Tucker's original "hand off the request to
// a user on that platform that does [have permission]" ask, without
// building a second privilege system that could itself be abused.

import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  DISCORD_LEG_HOST = 'discord-leg',
  DISCORD_LEG_CONTROL_PORT = '5102',
  FLUXER_LEG_HOST = 'fluxer-leg',
  FLUXER_LEG_CONTROL_PORT = '5103',
  PANEL_PORT = '8080',

  PUBLIC_BASE_URL, // e.g. https://fluxerbridge.valdeze.ch -- required
  SESSION_SECRET, // required -- signs the session cookie

  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,

  FLUXER_INSTANCE_URL = 'https://fluxer.app',
  FLUXER_OAUTH_CLIENT_ID,
  FLUXER_OAUTH_CLIENT_SECRET,

  DISCONNECT_COOLDOWN_SECONDS = '30',
  HANDOFF_TOKEN_TTL_HOURS = '24',
} = process.env;

for (const [name, val] of Object.entries({
  PUBLIC_BASE_URL,
  SESSION_SECRET,
  DISCORD_OAUTH_CLIENT_ID,
  DISCORD_OAUTH_CLIENT_SECRET,
  FLUXER_OAUTH_CLIENT_ID,
  FLUXER_OAUTH_CLIENT_SECRET,
})) {
  if (!val) {
    console.error(`FATAL: ${name} is not set -- check .env / Infisical`);
    process.exit(1);
  }
}

const LEGS = {
  discord: `http://${DISCORD_LEG_HOST}:${DISCORD_LEG_CONTROL_PORT}`,
  fluxer: `http://${FLUXER_LEG_HOST}:${FLUXER_LEG_CONTROL_PORT}`,
};

let fluxerApiBase = null;
async function getFluxerApiBase() {
  if (fluxerApiBase) return fluxerApiBase;
  const res = await fetch(`${FLUXER_INSTANCE_URL}/.well-known/fluxer`);
  if (!res.ok) throw new Error(`well-known lookup failed: ${res.status}`);
  const doc = await res.json();
  fluxerApiBase = `${doc.endpoints.api_public}/v1`;
  return fluxerApiBase;
}

const app = express();
app.use(express.json());
app.use(cookieParser(SESSION_SECRET));

// ---------------------------------------------------------------------
// Session: signed, httpOnly cookie holding only an account id -- no
// platform tokens ever touch this cookie or the database (see db.js).
// ---------------------------------------------------------------------

const SESSION_COOKIE = 'session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // a week -- linking two
// accounts is enough of a chore that a 1hr session (the old design) would
// be annoying; nothing bearer-capable lives in it, so a longer lifetime
// doesn't raise the stakes much. Reduce this if that trade feels wrong.

function setSession(res, accountId) {
  res.cookie(SESSION_COOKIE, accountId, {
    signed: true,
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function getAccountId(req) {
  return req.signedCookies[SESSION_COOKIE] || null;
}

function requireSession(req, res, next) {
  const accountId = getAccountId(req);
  if (!accountId) {
    res.status(401).json({ error: 'not logged in' });
    return;
  }
  req.accountId = accountId;
  next();
}

// ---------------------------------------------------------------------
// OAuth: state/return/mode cookies, shared shape for both providers.
// `returnTo` lets a claim-link visitor land back on /claim/:token after
// logging in; `mode=link` lets an already-logged-in visitor attach a
// second platform identity to their existing account instead of switching
// accounts.
// ---------------------------------------------------------------------

function safeReturnPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
  return raw;
}

function startOAuth(res, { returnTo, link }) {
  const state = crypto.randomBytes(16).toString('hex');
  const cookieOpts = { httpOnly: true, secure: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 };
  res.cookie('oauth_state', state, cookieOpts);
  res.cookie('oauth_return', safeReturnPath(returnTo), cookieOpts);
  res.cookie('oauth_mode', link ? 'link' : 'login', cookieOpts);
  return state;
}

function finishOAuth(req, res) {
  const stateOk = Boolean(req.cookies.oauth_state) && req.cookies.oauth_state === req.query.state;
  const returnTo = safeReturnPath(req.cookies.oauth_return);
  const mode = req.cookies.oauth_mode === 'link' ? 'link' : 'login';
  res.clearCookie('oauth_state');
  res.clearCookie('oauth_return');
  res.clearCookie('oauth_mode');
  return { stateOk, returnTo, mode };
}

async function completeLogin(req, res, { provider, platformUserId, username, returnTo, mode }) {
  if (mode === 'link') {
    const existingAccount = getAccountId(req);
    if (!existingAccount) {
      res.status(400).send('link requested but you are not logged in -- log in first, then link your other account from the panel.');
      return;
    }
    const ownerOfIdentity = db.findAccountIdByIdentity(provider, platformUserId);
    if (ownerOfIdentity && ownerOfIdentity !== existingAccount) {
      // That identity is already someone else's account. Rather than
      // silently merging two accounts, switch the session to the
      // identity's existing account -- the least surprising behavior
      // available without a real account-merge UI (not built here).
      console.warn(`link: ${provider}:${platformUserId} already belongs to a different account -- switching session to it instead of merging`);
      setSession(res, ownerOfIdentity);
    } else {
      db.linkIdentity(existingAccount, provider, platformUserId, username);
    }
  } else {
    const accountId = db.getOrCreateAccountForIdentity(provider, platformUserId, username);
    setSession(res, accountId);
  }
  res.redirect(returnTo);
}

// ---------------------------------------------------------------------
// Discord OAuth2.
// ---------------------------------------------------------------------

const DISCORD_AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const DISCORD_TOKEN_URL = 'https://discord.com/api/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/users/@me';
const DISCORD_REDIRECT_URI = `${PUBLIC_BASE_URL}/auth/discord/callback`;

app.get('/auth/discord/login', (req, res) => {
  const link = req.query.link === '1' && Boolean(getAccountId(req));
  const state = startOAuth(res, { returnTo: req.query.returnTo, link });
  const url = new URL(DISCORD_AUTHORIZE_URL);
  url.searchParams.set('client_id', DISCORD_OAUTH_CLIENT_ID);
  url.searchParams.set('redirect_uri', DISCORD_REDIRECT_URI);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'identify guilds');
  url.searchParams.set('state', state);
  res.redirect(url.toString());
});

app.get('/auth/discord/callback', async (req, res) => {
  const { stateOk, returnTo, mode } = finishOAuth(req, res);
  if (!stateOk) {
    res.status(400).send('invalid or expired OAuth state -- try logging in again');
    return;
  }
  try {
    const tokenRes = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: DISCORD_OAUTH_CLIENT_ID,
        client_secret: DISCORD_OAUTH_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();

    const userRes = await fetch(DISCORD_USER_URL, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!userRes.ok) throw new Error(`user fetch failed: ${userRes.status}`);
    const user = await userRes.json();
    // access_token is discarded here -- never persisted (see db.js).

    await completeLogin(req, res, { provider: 'discord', platformUserId: user.id, username: user.username, returnTo, mode });
  } catch (err) {
    console.error('Discord OAuth error:', err);
    res.status(500).send('Discord login failed -- see server logs');
  }
});

// ---------------------------------------------------------------------
// Fluxer OAuth2.
// ---------------------------------------------------------------------

const FLUXER_REDIRECT_URI = `${PUBLIC_BASE_URL}/auth/fluxer/callback`;

app.get('/auth/fluxer/login', async (req, res) => {
  try {
    const apiBase = await getFluxerApiBase();
    const link = req.query.link === '1' && Boolean(getAccountId(req));
    const state = startOAuth(res, { returnTo: req.query.returnTo, link });
    const url = new URL(`${apiBase}/oauth2/authorize`);
    url.searchParams.set('client_id', FLUXER_OAUTH_CLIENT_ID);
    url.searchParams.set('redirect_uri', FLUXER_REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  } catch (err) {
    console.error('Fluxer OAuth init error:', err);
    res.status(502).send('could not reach the Fluxer instance -- see server logs');
  }
});

app.get('/auth/fluxer/callback', async (req, res) => {
  const { stateOk, returnTo, mode } = finishOAuth(req, res);
  if (!stateOk) {
    res.status(400).send('invalid or expired OAuth state -- try logging in again');
    return;
  }
  try {
    const apiBase = await getFluxerApiBase();
    const tokenRes = await fetch(`${apiBase}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: FLUXER_OAUTH_CLIENT_ID,
        client_secret: FLUXER_OAUTH_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: req.query.code,
        redirect_uri: FLUXER_REDIRECT_URI,
      }),
    });
    if (!tokenRes.ok) throw new Error(`token exchange failed: ${tokenRes.status}`);
    const { access_token } = await tokenRes.json();

    const userRes = await fetch(`${apiBase}/oauth2/userinfo`, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!userRes.ok) throw new Error(`userinfo fetch failed: ${userRes.status}`);
    const user = await userRes.json();

    await completeLogin(req, res, { provider: 'fluxer', platformUserId: user.id, username: user.username, returnTo, mode });
  } catch (err) {
    console.error('Fluxer OAuth error:', err);
    res.status(500).send('Fluxer login failed -- see server logs');
  }
});

app.get('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/');
});

// ---------------------------------------------------------------------
// Live permission checks -- ask the relevant leg's bot, every time. This
// is the actual security boundary for everything below; nothing stored in
// db.js is trusted as proof of admin status on its own.
// ---------------------------------------------------------------------

async function legJson(base, urlPath, init) {
  const res = await fetch(`${base}${urlPath}`, init);
  if (!res.ok) throw new Error(`${urlPath} -> ${res.status}`);
  return res.json();
}

async function isAdminOfGuild(provider, guildId, accountId) {
  const identities = db.getIdentitiesForProvider(accountId, provider);
  if (identities.length === 0) return false;
  const base = LEGS[provider];
  for (const identity of identities) {
    try {
      const { isAdmin } = await legJson(base, `/guilds/${guildId}/members/${identity.platformUserId}/is-admin`);
      if (isAdmin) return true;
    } catch (err) {
      console.warn(`is-admin check failed (${provider} ${guildId} ${identity.platformUserId}):`, err.message);
    }
  }
  return false;
}

async function adminGuildsFor(provider, accountId) {
  const identities = db.getIdentitiesForProvider(accountId, provider);
  if (identities.length === 0) return [];
  const base = LEGS[provider];
  const byId = new Map();
  for (const identity of identities) {
    try {
      const guilds = await legJson(base, `/users/${identity.platformUserId}/admin-guilds`);
      for (const g of guilds) byId.set(g.id, g);
    } catch (err) {
      console.warn(`admin-guilds lookup failed (${provider} ${identity.platformUserId}):`, err.message);
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------
// API consumed by the page.
// ---------------------------------------------------------------------

app.get('/api/me', (req, res) => {
  const accountId = getAccountId(req);
  if (!accountId) {
    res.json({ loggedIn: false });
    return;
  }
  res.json({ loggedIn: true, accountId, identities: db.getIdentities(accountId) });
});

app.get('/api/my-guilds', requireSession, async (req, res) => {
  const provider = req.query.provider;
  if (!LEGS[provider]) {
    res.status(400).json({ error: 'provider must be discord or fluxer' });
    return;
  }
  try {
    res.json(await adminGuildsFor(provider, req.accountId));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/guilds/:provider/:guildId/channels', requireSession, async (req, res) => {
  const { provider, guildId } = req.params;
  if (!LEGS[provider]) {
    res.status(400).json({ error: 'provider must be discord or fluxer' });
    return;
  }
  // Only expose channels for guilds this account actually administers --
  // channel names aren't hugely sensitive, but there's no reason to leak
  // them to every logged-in visitor either.
  if (!(await isAdminOfGuild(provider, guildId, req.accountId))) {
    res.status(403).json({ error: 'you are not an admin of that guild' });
    return;
  }
  try {
    res.json(await legJson(LEGS[provider], `/guilds/${guildId}/channels`));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/status', async (req, res) => {
  const accountId = getAccountId(req);
  const result = {};
  for (const provider of ['discord', 'fluxer']) {
    try {
      const status = await legJson(LEGS[provider], '/status');
      let canControl = false;
      if (accountId && status.connected && status.current) {
        canControl = await isAdminOfGuild(provider, status.current.guildId ?? status.current.guild_id, accountId);
      }
      result[provider] = { connected: status.connected, current: status.current, canControl };
    } catch (err) {
      result[provider] = { error: `could not reach the ${provider} leg: ${err.message}` };
    }
  }
  res.json({ loggedIn: Boolean(accountId), legs: result });
});

app.post('/api/connect', requireSession, async (req, res) => {
  const { provider, guildId, channelId, guildName, channelName } = req.body || {};
  if (!LEGS[provider] || !guildId || !channelId) {
    res.status(400).json({ error: 'provider, guildId and channelId are required' });
    return;
  }
  if (!(await isAdminOfGuild(provider, guildId, req.accountId))) {
    res.status(403).json({ error: 'you are not an admin of that guild' });
    return;
  }
  try {
    const body = provider === 'fluxer' ? { guildId, channelId, guildName, channelName } : { guildId, channelId };
    const upstream = await fetch(`${LEGS[provider]}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const payload = await upstream.json();
    res.status(upstream.status).json(payload);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

const lastDisconnectAt = new Map(); // `${accountId}:${provider}` -> ms epoch

app.post('/api/disconnect', requireSession, async (req, res) => {
  const { provider } = req.body || {};
  if (!LEGS[provider]) {
    res.status(400).json({ error: 'provider must be discord or fluxer' });
    return;
  }

  const key = `${req.accountId}:${provider}`;
  const cooldownMs = Number(DISCONNECT_COOLDOWN_SECONDS) * 1000;
  const last = lastDisconnectAt.get(key);
  if (last && Date.now() - last < cooldownMs) {
    res.status(429).json({ error: `wait ${Math.ceil((cooldownMs - (Date.now() - last)) / 1000)}s before trying again` });
    return;
  }

  try {
    const status = await legJson(LEGS[provider], '/status');
    if (!status.connected || !status.current) {
      res.status(409).json({ error: 'not currently bridged on that side' });
      return;
    }
    const guildId = status.current.guildId ?? status.current.guild_id;
    // Always re-check live, right before acting -- never trust an earlier
    // pass of this same check.
    if (!(await isAdminOfGuild(provider, guildId, req.accountId))) {
      res.status(403).json({ error: 'you are not an admin of the currently bridged guild' });
      return;
    }
    await fetch(`${LEGS[provider]}/disconnect`, { method: 'POST' });
    lastDisconnectAt.set(key, Date.now());
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------
// Hand-off links. Deliberately NOT a capability grant -- see the comment
// at the top of this file. Creating one just needs a session; claiming one
// still runs the exact same live admin check as every other action here.
// ---------------------------------------------------------------------

app.post('/api/handoff/request', requireSession, async (req, res) => {
  const { provider } = req.body || {};
  if (!LEGS[provider]) {
    res.status(400).json({ error: 'provider must be discord or fluxer' });
    return;
  }
  try {
    const status = await legJson(LEGS[provider], '/status');
    if (!status.connected || !status.current) {
      res.status(409).json({ error: 'nothing is bridged on that side right now to request access to' });
      return;
    }
    const guildId = status.current.guildId ?? status.current.guild_id;
    const guildName = status.current.guildName ?? status.current.guild_name;
    const token = db.createHandoffToken({
      provider,
      guildId,
      guildName,
      requestedByAccountId: req.accountId,
      ttlMs: Number(HANDOFF_TOKEN_TTL_HOURS) * 60 * 60 * 1000,
    });
    res.json({ url: `${PUBLIC_BASE_URL}/claim/${token}` });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/claim/:token', (req, res) => {
  const row = db.getHandoffToken(req.params.token);
  if (!row) {
    res.status(404).json({ error: 'unknown or expired link' });
    return;
  }
  res.json({
    provider: row.provider,
    guildId: row.guildId,
    guildName: row.guildName,
    expired: Date.now() > row.expiresAt,
    claimed: Boolean(row.claimedByAccountId),
    claimedByUsername: row.claimedByAccountId ? db.usernameForAccount(row.claimedByAccountId, row.provider) : null,
    requestedByUsername: db.usernameForAccount(row.requestedByAccountId, row.provider),
  });
});

app.post('/api/claim/:token', requireSession, async (req, res) => {
  const row = db.getHandoffToken(req.params.token);
  if (!row) {
    res.status(404).json({ error: 'unknown or expired link' });
    return;
  }
  if (Date.now() > row.expiresAt) {
    res.status(410).json({ error: 'this link has expired -- ask for a new one' });
    return;
  }
  const isAdmin = await isAdminOfGuild(row.provider, row.guildId, req.accountId);
  if (!isAdmin) {
    res.status(403).json({
      error: `your ${row.provider} account isn't an admin of ${row.guildName || 'that server'}. If that's wrong, make sure you've linked the right ${row.provider} account.`,
    });
    return;
  }
  db.markHandoffClaimed(req.params.token, req.accountId);
  res.json({ ok: true });
});

app.get('/claim/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(Number(PANEL_PORT), () => {
  console.log(`panel listening on :${PANEL_PORT}`);
});
