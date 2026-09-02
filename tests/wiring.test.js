const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('transfer UI normalizes the paginated files API payload', () => {
    const app = source('public/js/app.js');
    const index = source('public/index.html');
    assert.match(index, /clientPayloads\.js/);
    assert.match(app, /normalizeFilesResponse\(response\)/);
});

test('officer transfer route delegates to the atomic transfer service', () => {
    const officers = source('routes/officers.js');
    assert.match(officers, /executeFileTransfers/);
    assert.match(officers, /error\.statusCode/);
    assert.doesNotMatch(officers, /for \(const t of transfers\)/);
});

test('admin process-step route delegates to safe reorder service', () => {
    const admin = source('routes/admin.js');
    assert.match(admin, /replaceProcessSteps/);
    assert.match(admin, /error\.statusCode/);
    assert.doesNotMatch(admin, /SET step_name = \$1, sla_days = \$2, cum_days = \$3, step_order = \$4/);
});

test('startup migration guarantees the audit table required by both workflows', () => {
    const server = source('server.js');
    assert.match(server, /CREATE TABLE IF NOT EXISTS audit_log/);
});

test('production authentication cannot use a repository-known JWT fallback', () => {
    const middleware = source('middleware/auth.js');
    const auth = source('routes/auth.js');
    assert.doesNotMatch(middleware, /file-tracker-secret-key-change-in-production/);
    assert.doesNotMatch(auth, /file-tracker-secret-key-change-in-production/);
    assert.match(middleware, /JWT_SECRET/);
    assert.match(auth, /JWT_SECRET/);
});

test('transfer modal uses the complete dedicated candidate endpoint', () => {
    const app = source('public/js/app.js');
    const officers = source('routes/officers.js');
    assert.match(app, /\/api\/officers\/\$\{officerId\}\/transfer-candidates/);
    assert.match(officers, /transfer-candidates/);
});

test('login page does not disclose default credentials', () => {
    const html = source('public/index.html');
    assert.doesNotMatch(html, /Default admin:/i);
});

test('unauthenticated CSS hides the protected application shell', () => {
    const css = source('public/css/styles.css');
    assert.match(css, /body:not\(\.authenticated\) \.sidebar/);
    assert.match(css, /body:not\(\.authenticated\) \.main-content/);
});

test('file completion follows the configured terminal step rather than an exact label', () => {
    const files = source('routes/files.js');
    assert.match(files, /AS is_terminal/);
    assert.match(files, /const isCompleted = next\.is_terminal/);
});

test('triage list and detail expose linked file progression', () => {
    const triage = source('routes/triage.js');
    const app = source('public/js/app.js');
    const html = source('public/index.html');
    assert.match(triage, /current_step_name/);
    assert.match(triage, /total_steps/);
    assert.match(triage, /file_progress/);
    assert.match(app, /renderTriageProgress/);
    assert.match(app, /File Progression/);
    assert.match(html, /<th>Progress<\/th>/);
});

test('file advancement synchronizes linked triage status to Awarded', () => {
    const files = source('routes/files.js');
    assert.match(files, /syncTriageAwardStatus/);
    assert.match(files, /stepName: next\.step_name/);
});

test('triage progression detail uses an available status badge renderer', () => {
    const app = source('public/js/app.js');
    assert.doesNotMatch(app, /statusBadge\(progress\.file_status\)/);
    assert.match(app, /triageStatusBadge\(progress\.file_status\)/);
});

test('historical triage award reconciliation has a transactional operator command', () => {
    const pkg = JSON.parse(source('package.json'));
    const script = source('scripts/reconcileTriageAwards.js');
    assert.equal(pkg.scripts['reconcile:triage-awards'], 'node scripts/reconcileTriageAwards.js');
    assert.match(script, /reconcileAssignedTriageAwards/);
    assert.match(script, /client\.query\('BEGIN'\)/);
    assert.match(script, /client\.query\('COMMIT'\)/);
    assert.match(script, /client\.query\('ROLLBACK'\)/);
});
