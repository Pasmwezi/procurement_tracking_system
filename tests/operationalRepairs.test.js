const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('reports router is mounted behind authenticated management roles', () => {
    const server = read('server.js');
    assert.match(server, /require\('\.\/routes\/reports'\)/);
    assert.match(server, /app\.use\('\/api\/reports', requireAuth, requireRole\('admin', 'team_leader'\), reportsRouter\)/);
});

test('startup schema includes evaluation columns and token revocation migration', () => {
    const server = read('server.js');
    assert.match(server, /ADD COLUMN IF NOT EXISTS basis_of_selection/);
    assert.match(server, /ADD COLUMN IF NOT EXISTS token_version/);
    assert.match(server, /users_password_revokes_sessions/);
});

test('fresh installation has no repository-known administrator password', () => {
    const init = read('db/init.sql');
    const server = read('server.js');
    const seed = read('db/seedAdmin.js');
    const readme = read('README.md');
    assert.doesNotMatch(init, /INSERT INTO users[\s\S]{0,300}App Administrator/);
    assert.match(server, /ADMIN_INITIAL_PASSWORD/);
    assert.doesNotMatch(server, /bcrypt\.hash\(['"][^'"]+['"], 10\)/);
    assert.doesNotMatch(server, /Default admin created \([^)]+\//);
    assert.doesNotMatch(seed, /admin123|DATABASE_URL\s*\|\|/);
    assert.doesNotMatch(readme, /admin123|file-tracker-secret-key-change-in-production|tracker_pass/);
});

test('SMTP test fails honestly when sendEmail reports no delivery', () => {
    const admin = read('routes/admin.js');
    assert.match(admin, /const sent = await sendTestEmail\(toAddress\)/);
    assert.match(admin, /if \(!sent\).*SMTP is not configured/s);
});

test('contract expiry notifications include the required current step', () => {
    const source = read('services/slaChecker.js');
    const server = read('server.js');
    const email = read('services/emailService.js');
    assert.match(source, /f\.current_step_id/);
    assert.match(source, /INSERT INTO notifications \(file_id, officer_id, step_id, message/);
    assert.match(source, /FOR UPDATE OF c, f/);
    assert.match(source, /contract_id = \$1/);
    assert.match(server, /idx_notifications_contract_expiry/);
    assert.match(email, /connectionTimeout/);
});

test('file creation validates owner, exact start step, and terminal status', () => {
    const source = read('routes/files.js');
    assert.match(source, /role = 'officer'/);
    assert.match(source, /Invalid current_step_order/);
    assert.match(source, /targetStep\.step_order === allSteps\[allSteps\.length - 1\]\.step_order/);
});

test('sole-source bid gating matches seeded process casing', () => {
    const bids = read('routes/bids.js');
    assert.match(bids, /process_name\.toLowerCase\(\) === 'sole_source'/);
});

test('compose and database pool do not contain fallback database credentials', () => {
    const compose = read('docker-compose.yml');
    const pool = read('db/pool.js');
    assert.match(compose, /DB_PASSWORD:\?Database password must be set/);
    assert.doesNotMatch(pool, /process\.env\.DATABASE_URL \|\|/);
});
