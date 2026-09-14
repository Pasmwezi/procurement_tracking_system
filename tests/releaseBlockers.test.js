const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('cookie parsing and authenticated logout revocation are wired', () => {
    const server = read('server.js');
    const auth = read('routes/auth.js');
    assert.match(server, /app\.use\(cookieParser\(\)\)/);
    assert.match(auth, /router\.post\('\/logout', requireAuth/);
    assert.match(auth, /token_version = token_version \+ 1/);
});

test('team leaders cannot opt out of file, triage, officer, or report team scope', () => {
    const files = read('routes/files.js');
    const triage = read('routes/triage.js');
    const officers = read('routes/officers.js');
    const reports = read('routes/reports.js');
    assert.doesNotMatch(files, /team_leader' && req\.query\.team_id === 'me'/);
    assert.doesNotMatch(triage, /req\.query\.team_id === 'me'/);
    assert.match(files, /router\.param\('id'/);
    assert.match(triage, /router\.param\('id'/);
    assert.match(officers, /req\.user\.role === 'officer'.*403/);
    assert.match(reports, /req\.user\.role === 'team_leader' \? req\.user\.teamId : null/);
});

test('triage delete locks lifecycle row and assignment validates team and terminal state', () => {
    const triage = read('routes/triage.js');
    assert.match(triage, /router\.delete\('\/:id\/missing-docs\/:docId'[\s\S]*FOR UPDATE[\s\S]*COMMIT/);
    assert.match(triage, /role = 'officer' AND is_active = TRUE AND team_id = \$2/);
    assert.match(triage, /isTerminalStep \? 'Completed' : 'Active'/);
    assert.match(triage, /Invalid current_step_order for the selected process/);
});

test('all file creation paths preserve terminal-step and transactional audit semantics', () => {
    const files = read('routes/files.js');
    assert.match(files, /db: client,[\s\S]*required: true[\s\S]*COMMIT/);
    assert.ok((files.match(/isTerminalStep \? 'Completed' : 'Active'/g) || []).length >= 2);
    assert.match(files, /Invalid starting step for selected process/);
});

test('evaluation rejects missing and excessive technical scores', () => {
    const bids = read('routes/bids.js');
    assert.match(bids, /score === null[\s\S]*score > maxPoints/);
    assert.match(bids, /technical score between 0 and maximum_technical_points/);
});

test('compose passes bootstrap values and migration failures terminate startup', () => {
    const compose = read('docker-compose.yml');
    const server = read('server.js');
    assert.match(compose, /ADMIN_INITIAL_EMAIL:/);
    assert.match(compose, /ADMIN_INITIAL_PASSWORD:/);
    assert.match(server, /Migration failed:[\s\S]*process\.exit\(1\)/);
});
