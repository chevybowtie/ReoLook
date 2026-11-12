// User accounts on a device. Unlike the other settings this is a set of operations, not one value
// with an undo: a password cannot be read back, so nothing here is undoable and every operation has
// its own guard rails. Verified on an RLC-410 (v3.0.0.136):
//   AddUser    { User: { userName, password, level } }
//   ModifyUser { User: { userName, newPassword } }   (an administrator needs no old password)
//   DelUser    { User: { userName } }
// ModifyUser accepts a `level` and silently ignores it, so a level cannot be changed in place.
import { WriteError } from './device-settings.mjs';

const NAME = /^[A-Za-z0-9_.@-]{1,31}$/;
// printable ASCII without space or characters that tend to break camera firmware parsers
const PASSWORD = /^[\x21\x23-\x25\x28-\x3b\x3d\x3f-\x5b\x5d-\x7e]{6,31}$/;

export const userRules = { name: 'letters, digits and _ . @ -, up to 31 characters', password: '6 to 31 printable characters, no spaces or " \' \\ < > &' };

/** Accounts as the device lists them. Never includes anything secret (the device sends none). */
export async function listUsers(client) {
  const v = await client.command('GetUser', {});
  if (!Array.isArray(v?.User)) throw new Error('the device did not report its accounts');
  return v.User.map((u) => ({ userName: String(u.userName), level: String(u.level) }));
}

/**
 * What the device allows for accounts: the permission levels and the password length. Falls back to common values when it will not say.
 */
export async function userConstraints(client) {
  try {
    const r = (await client.describe('GetUser', {})).range?.User;
    return { levels: Array.isArray(r?.level) ? r.level : ['guest', 'admin'], passwordMin: r?.password?.minLen ?? 6, passwordMax: r?.password?.maxLen ?? 31 };
  } catch { return { levels: ['guest', 'admin'], passwordMin: 6, passwordMax: 31 }; }
}

/**
 * Check an operation against the accounts that exist and the accounts ReoLook itself relies on.
 * Throws WriteError with the reason; returns what is needed to carry it out.
 *   ctx: { users, viewerName, sessionUser, constraints }
 */
export function checkOperation(op, ctx) {
  const { users, viewerName, sessionUser, constraints } = ctx;
  const action = op?.action, name = typeof op?.userName === 'string' ? op.userName : '';
  if (!['add', 'delete', 'password'].includes(action)) throw new WriteError('unknown account operation');
  if (!NAME.test(name)) throw new WriteError(`the account name must be ${userRules.name}`);
  const existing = users.find((u) => u.userName === name);
  const admins = users.filter((u) => u.level === 'admin');
  /** Checks the new password against the device's rules. @throws {WriteError} saying what the password must be */
  const needPassword = () => {
    const p = typeof op.password === 'string' ? op.password : '';
    if (!PASSWORD.test(p) || p.length < constraints.passwordMin || p.length > constraints.passwordMax) {
      throw new WriteError(`the password must be ${constraints.passwordMin} to ${constraints.passwordMax} printable characters, with no spaces or " ' \\ < > &`);
    }
    return p;
  };
  /**
   * Requires the account name to have been typed to confirm a destructive change. @throws {WriteError} (with `needsConfirm`) otherwise
   */
  const typed = () => { if (op.confirm !== name) throw new WriteError(`type the account name (${name}) to confirm`, 400, { needsConfirm: name }); };

  if (action === 'add') {
    if (existing) throw new WriteError(`an account named ${name} already exists`, 409);
    const level = op.level ?? 'guest';
    if (!constraints.levels.includes(level)) throw new WriteError(`level must be one of: ${constraints.levels.join(', ')}`);
    const password = needPassword();
    if (level === 'admin') typed();
    return { action, userName: name, level, password, summary: `added ${level} account ${name}` };
  }
  if (!existing) throw new WriteError(`there is no account named ${name}`, 404);
  if (action === 'delete') {
    if (name === viewerName) throw new WriteError(`${name} is the account ReoLook uses to view this device; deleting it would stop live view and recording`, 409);
    if (name === sessionUser) throw new WriteError('you are signed in with this account; deleting it would end this session', 409);
    if (existing.level === 'admin' && admins.length <= 1) throw new WriteError('this is the only administrator account; the device would be left with none', 409);
    typed();
    return { action, userName: name, summary: `deleted account ${name}` };
  }
  // password
  if (name === viewerName) throw new WriteError(`${name} is the account ReoLook uses to view this device; changing its password here would lock ReoLook out. Change it in the device's own page and then update ReoLook's settings`, 409);
  if (name === sessionUser) throw new WriteError('you are signed in with this account; its password cannot be changed from this session', 409);
  const password = needPassword();
  typed();
  return { action, userName: name, password, summary: `changed the password of ${name}` };
}

/** Carry out a checked operation and verify it from the device's side. Returns { verified, users }. */
export async function applyOperation(client, checked, { check = null } = {}) {
  if (checked.action === 'add') await client.command('AddUser', { User: { userName: checked.userName, password: checked.password, level: checked.level } });
  else if (checked.action === 'delete') await client.command('DelUser', { User: { userName: checked.userName } });
  else await client.command('ModifyUser', { User: { userName: checked.userName, newPassword: checked.password } });
  const users = await listUsers(client);
  const has = users.find((u) => u.userName === checked.userName);
  let verified = checked.action === 'delete' ? !has : Boolean(has) && (checked.action !== 'add' || has.level === checked.level);
  // the strongest check for a password: the new credentials actually sign in
  if (verified && check && checked.password) verified = await check(checked.userName, checked.password);
  return { verified, users };
}
