// Tiny persistence layer for the panel: linked Discord/Fluxer identities
// grouped into "accounts", and hand-off tokens. Uses node:sqlite (built
// into Node since 22.5, unflagged) rather than adding a native dependency
// like better-sqlite3 -- simpler to build in a slim Docker image. If the
// installed Node 22.x in the image predates 22.5, `import { DatabaseSync }
// from 'node:sqlite'` will throw at startup; check `node --version` in the
// built image if this container won't boot.
//
// What's stored here is deliberately minimal: platform user IDs and
// display names only, never OAuth access/refresh tokens. Each login only
// needs a token long enough to call that platform's "who am I" and
// "am I an admin of guild X" endpoints, then the token is discarded --
// nothing bearer-capable is persisted, so there's nothing here that grants
// access on its own. "Safely stored" in the sense Tucker asked for: yes,
// but mostly because there's very little to protect in the first place.
// The live permission check (see server.js) is the real security boundary,
// not anything read from this database.

import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.PANEL_DB_PATH || '/data/panel.db';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS identities (
    provider TEXT NOT NULL,
    platform_user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    username TEXT,
    linked_at INTEGER NOT NULL,
    PRIMARY KEY (provider, platform_user_id)
  );

  CREATE TABLE IF NOT EXISTS handoff_tokens (
    token TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    guild_name TEXT,
    requested_by_account_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    claimed_by_account_id TEXT,
    claimed_at INTEGER
  );
`);

function now() {
  return Date.now();
}

export function findAccountIdByIdentity(provider, platformUserId) {
  const row = db
    .prepare('SELECT account_id FROM identities WHERE provider = ? AND platform_user_id = ?')
    .get(provider, platformUserId);
  return row ? row.account_id : null;
}

export function createAccount() {
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO accounts (id, created_at) VALUES (?, ?)').run(id, now());
  return id;
}

export function linkIdentity(accountId, provider, platformUserId, username) {
  db.prepare(
    `INSERT INTO identities (provider, platform_user_id, account_id, username, linked_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(provider, platform_user_id) DO UPDATE SET
       account_id = excluded.account_id,
       username = excluded.username`
  ).run(provider, platformUserId, accountId, username, now());
}

// Login (as opposed to link): reuse the account already tied to this
// identity if one exists, otherwise create a fresh one. Returns the
// account id.
export function getOrCreateAccountForIdentity(provider, platformUserId, username) {
  const existing = findAccountIdByIdentity(provider, platformUserId);
  if (existing) {
    db.prepare('UPDATE identities SET username = ? WHERE provider = ? AND platform_user_id = ?').run(
      username,
      provider,
      platformUserId
    );
    return existing;
  }
  const accountId = createAccount();
  linkIdentity(accountId, provider, platformUserId, username);
  return accountId;
}

export function getIdentities(accountId) {
  return db
    .prepare('SELECT provider, platform_user_id AS platformUserId, username FROM identities WHERE account_id = ?')
    .all(accountId);
}

export function getIdentitiesForProvider(accountId, provider) {
  return db
    .prepare(
      'SELECT platform_user_id AS platformUserId, username FROM identities WHERE account_id = ? AND provider = ?'
    )
    .all(accountId, provider);
}

export function createHandoffToken({ provider, guildId, guildName, requestedByAccountId, ttlMs }) {
  const token = crypto.randomBytes(20).toString('hex');
  const createdAt = now();
  db.prepare(
    `INSERT INTO handoff_tokens
       (token, provider, guild_id, guild_name, requested_by_account_id, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(token, provider, guildId, guildName || null, requestedByAccountId, createdAt, createdAt + ttlMs);
  return token;
}

export function getHandoffToken(token) {
  return db
    .prepare(
      `SELECT token, provider, guild_id AS guildId, guild_name AS guildName,
              requested_by_account_id AS requestedByAccountId, created_at AS createdAt,
              expires_at AS expiresAt, claimed_by_account_id AS claimedByAccountId,
              claimed_at AS claimedAt
       FROM handoff_tokens WHERE token = ?`
    )
    .get(token);
}

export function markHandoffClaimed(token, accountId) {
  db.prepare(
    'UPDATE handoff_tokens SET claimed_by_account_id = ?, claimed_at = ? WHERE token = ? AND claimed_by_account_id IS NULL'
  ).run(accountId, now(), token);
}

export function usernameForAccount(accountId, provider) {
  const rows = getIdentitiesForProvider(accountId, provider);
  return rows[0]?.username || null;
}
