'use strict';
/**
 * Authentication and authorisation.
 *
 * Passwords are scrypt with a per-user salt — never a bare hash, never
 * reversible. Sessions live in the database rather than in a signed token, so
 * revoking one takes effect on the next request instead of whenever the token
 * happens to expire. That matters in a warehouse where a handheld gets lost.
 */
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MAX_FAILED = 5;
const LOCKOUT_MINUTES = 15;
const DEFAULT_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 12);

async function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 10) {
    throw new AuthError('A password must be at least 10 characters.', 400);
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scrypt(plain, salt, SCRYPT.keylen, SCRYPT);
  return { hash: key.toString('hex'), salt };
}

async function verifyPassword(plain, hash, salt) {
  if (!hash || !salt) return false;
  const key = await scrypt(plain, salt, SCRYPT.keylen, SCRYPT);
  const a = Buffer.from(key.toString('hex'), 'utf8');
  const b = Buffer.from(hash, 'utf8');
  // constant time, and length-safe
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

class AuthError extends Error {
  constructor(message, status = 401) { super(message); this.status = status; }
}

async function createUser(db, { companyId, username, fullName, email, roleCode, password, warehouseIds }) {
  const { hash, salt } = await hashPassword(password);
  const r = await db.query(
    `INSERT INTO app_user (company_id, username, full_name, email, role_id, password_hash, password_salt)
     VALUES ($1,$2,$3,$4,(SELECT id FROM role WHERE code=$5),$6,$7) RETURNING id`,
    [companyId, username, fullName, email || null, roleCode, hash, salt]);
  const id = r.rows[0].id;
  for (const w of warehouseIds || []) {
    await db.query('INSERT INTO user_warehouse (user_id, warehouse_id) VALUES ($1,$2)', [id, w]);
  }
  return id;
}

/**
 * Sign in. Failures are counted against the user row and the account locks for
 * a period once the threshold is passed — the columns for this are in the
 * schema rather than in an in-memory counter, so a restart doesn't clear them.
 */
async function login(db, { companyCode, username, password, device, ip }) {
  const r = await db.query(
    `SELECT u.*, c.id AS co_id FROM app_user u
       JOIN company c ON c.id = u.company_id
      WHERE c.code = $1 AND u.username = $2`, [companyCode, username]);
  const u = r.rows[0];

  // Same message and similar cost whether the user exists or not, so the
  // response can't be used to enumerate usernames.
  if (!u) {
    await scrypt(password, 'decoy-salt', SCRYPT.keylen, SCRYPT);
    throw new AuthError('Those sign-in details were not recognised.');
  }
  if (!u.is_active) throw new AuthError('This account has been deactivated.', 403);
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(u.locked_until) - Date.now()) / 60000);
    throw new AuthError(`Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
  }

  const good = await verifyPassword(password, u.password_hash, u.password_salt);
  if (!good) {
    const failed = u.failed_logins + 1;
    const lock = failed >= MAX_FAILED
      ? `now() + interval '${LOCKOUT_MINUTES} minutes'` : 'NULL';
    await db.query(
      `UPDATE app_user SET failed_logins=$1, locked_until=${lock} WHERE id=$2`, [failed, u.id]);
    await audit(db, u.company_id, u.id, 'Sign-in failed', 'app_user', u.id, null, null,
      `attempt ${failed} of ${MAX_FAILED}`, device, ip);
    throw new AuthError('Those sign-in details were not recognised.');
  }

  await db.query('UPDATE app_user SET failed_logins=0, locked_until=NULL WHERE id=$1', [u.id]);
  const sid = crypto.randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO session (id, user_id, expires_at, device)
     VALUES ($1,$2, now() + ($3 || ' hours')::interval, $4)`,
    [sid, u.id, String(DEFAULT_TTL_HOURS), device || null]);
  await audit(db, u.company_id, u.id, 'Sign-in', 'session', sid, null, null, null, device, ip);
  return { sessionId: sid, user: await context(db, sid) };
}

async function logout(db, sessionId) {
  await db.query('UPDATE session SET revoked_at = now() WHERE id=$1 AND revoked_at IS NULL', [sessionId]);
}

/** Resolve a session into the identity and permission set used by every route. */
async function context(db, sessionId) {
  if (!sessionId) throw new AuthError('Sign in to continue.');
  const r = await db.query(
    `SELECT u.id, u.company_id, u.full_name, u.username, r.code AS role_code, r.id AS role_id
       FROM session s JOIN app_user u ON u.id = s.user_id JOIN role r ON r.id = u.role_id
      WHERE s.id=$1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active`,
    [sessionId]);
  if (!r.rows.length) throw new AuthError('Your session has expired. Sign in again.');
  const u = r.rows[0];
  const perms = await db.query(
    'SELECT permission_code FROM role_permission WHERE role_id=$1', [u.role_id]);
  const wh = await db.query('SELECT warehouse_id FROM user_warehouse WHERE user_id=$1', [u.id]);
  return {
    userId: u.id, companyId: u.company_id, name: u.full_name, username: u.username,
    role: u.role_code,
    permissions: new Set(perms.rows.map(p => p.permission_code)),
    // no rows means every warehouse; a row list confines the user to those
    warehouses: wh.rows.length ? wh.rows.map(w => Number(w.warehouse_id)) : null
  };
}

function can(ctx, permission) { return ctx.permissions.has(permission); }

function require_(ctx, permission) {
  if (!can(ctx, permission)) {
    throw new AuthError(`Your role (${ctx.role}) does not allow this action.`, 403);
  }
}

function requireWarehouse(ctx, warehouseId) {
  if (ctx.warehouses && !ctx.warehouses.includes(Number(warehouseId))) {
    throw new AuthError('You are not assigned to that warehouse.', 403);
  }
}

async function audit(db, companyId, userId, action, entity, entityId, oldV, newV, reason, device, ip) {
  await db.query(
    `INSERT INTO audit_log (company_id, user_id, action, entity, entity_id, old_value, new_value, reason, device, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [companyId, userId, action, entity, entityId == null ? null : String(entityId),
     oldV == null ? null : String(oldV), newV == null ? null : String(newV),
     reason || null, device || null, ip || null]);
}

module.exports = {
  AuthError, hashPassword, verifyPassword, createUser,
  login, logout, context, can, require: require_, requireWarehouse, audit
};
