const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.JWT_SECRET = crypto.randomBytes(48).toString('hex');
const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const originalQuery = pool.query;
after(() => { pool.query = originalQuery; });
async function authenticate(claims, version = 0) {
    pool.query = async () => ({ rows: [{ id: 1, role: 'officer', is_active: true, token_version: version }] });
    let status = 200;
    let allowed = false;
    const res = { status(n) { status = n; return this; }, json() {} };
    await requireAuth({ headers: { authorization: `Bearer ${jwt.sign({ id: 1, ...claims }, process.env.JWT_SECRET)}` } }, res, () => { allowed = true; });
    return { status, allowed };
}
test('revoked access credentials are rejected, current version works', async () => {
    assert.deepEqual(await authenticate({ purpose: 'access', tokenVersion: 0 }, 1), { status: 401, allowed: false });
    assert.deepEqual(await authenticate({ purpose: 'access', tokenVersion: 1 }, 1), { status: 200, allowed: true });
});
test('refresh credentials cannot authorize protected resources', async () => {
    assert.deepEqual(await authenticate({ isRefresh: true }), { status: 401, allowed: false });
});
test('team leaders without a team fail closed at role boundaries', () => {
    let status = 200;
    let allowed = false;
    const res = { status(n) { status = n; return this; }, json() {} };
    requireRole('team_leader')({ user: { id: 1, role: 'team_leader', teamId: null } }, res, () => { allowed = true; });
    assert.deepEqual({ status, allowed }, { status: 403, allowed: false });
});
