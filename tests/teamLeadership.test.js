const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    recommendOfficerClassification,
    validateAssignmentMatch,
    validateReviewTransition,
    sanitizePerformanceCheckpoint
} = require('../services/teamLeadership');

function source(relativePath) {
    return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

test('triage recommendation deterministically maps value and complexity', () => {
    assert.equal(recommendOfficerClassification('High', 'High'), 'PG-4');
    assert.equal(recommendOfficerClassification('Low', 'Low'), 'PG-2');
    assert.equal(recommendOfficerClassification('High', 'Low'), 'PG-3');
    assert.equal(recommendOfficerClassification('Low', 'High'), 'PG-3');
    assert.throws(() => recommendOfficerClassification('Medium', 'Low'), /Low or High/);
});

test('assignment mismatch or unclassified officer requires a nonblank rationale', () => {
    assert.deepEqual(validateAssignmentMatch('PG-3', 'PG-3', ''), { override: false, rationale: null });
    assert.deepEqual(validateAssignmentMatch('PG-3', 'PG-2', 'Development opportunity'), {
        override: true,
        rationale: 'Development opportunity'
    });
    assert.throws(() => validateAssignmentMatch('PG-4', null, '  '), /override rationale/i);
    assert.throws(() => validateAssignmentMatch('PG-4', 'PG-3', ''), /override rationale/i);
});

test('review decisions follow the defined review lifecycle', () => {
    assert.equal(validateReviewTransition('submitted', 'reviewing', 'team_leader'), true);
    assert.equal(validateReviewTransition('reviewing', 'returned', 'team_leader'), true);
    assert.equal(validateReviewTransition('returned', 'resubmitted', 'officer'), true);
    assert.equal(validateReviewTransition('resubmitted', 'cleared', 'team_leader'), true);
    assert.throws(() => validateReviewTransition('submitted', 'cleared', 'officer'), /not allowed/i);
    assert.throws(() => validateReviewTransition('cleared', 'reviewing', 'team_leader'), /not allowed/i);
});

test('performance checkpoints accept scheduling fields and reject narrative or rating data', () => {
    assert.deepEqual(sanitizePerformanceCheckpoint({
        officer_id: 7,
        year: 2026,
        checkpoint_type: 'mid-year',
        due_date: '2026-06-30',
        completion_date: null,
        hr_record_date: null,
        followup_date: '2026-07-15'
    }), {
        officer_id: 7,
        year: 2026,
        checkpoint_type: 'mid-year',
        due_date: '2026-06-30',
        completion_date: null,
        hr_record_date: null,
        followup_date: '2026-07-15'
    });
    assert.throws(() => sanitizePerformanceCheckpoint({
        officer_id: 7,
        year: 2026,
        checkpoint_type: 'year-end',
        due_date: '2026-12-31',
        rating: 'exceeds'
    }), /narrative or rating/i);
});

test('PG-5 migration is idempotent and includes constrained team-lead records', () => {
    const migration = source('db/migrate-v5-team-leadership.sql');
    assert.match(migration, /ADD COLUMN IF NOT EXISTS officer_classification/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS pg5_reviews/);
    assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS[\s\S]*?ON pg5_reviews\(file_id, gate\)[\s\S]*?WHERE status IN \('submitted','reviewing','returned','resubmitted'\)/);
    assert.match(migration, /strategy.*pre-solicitation.*payment\/holdback.*close-out/s);
    assert.match(migration, /submitted.*reviewing.*returned.*resubmitted.*conditionally cleared.*escalated/s);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS weekly_checkins/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS business_owner_actions/);
    assert.match(migration, /CREATE TABLE IF NOT EXISTS performance_checkpoints/);
    assert.doesNotMatch(migration, /performance_checkpoints[\s\S]*\b(rating|narrative)\b/i);
});

test('team-lead API is mounted with role-aware access and migration fails closed', () => {
    const server = source('server.js');
    const readiness = source('services/schemaReadiness.js');
    const route = source('routes/teamLeadership.js');
    const triage = source('routes/triage.js');
    assert.match(server, /\/api\/team-leadership/);
    assert.match(server, /migrate-v5-team-leadership\.sql/);
    assert.match(server, /validatePg5Schema/);
    assert.match(server, /recordSchemaRevision/);
    assert.match(readiness, /schema_migrations/);
    assert.match(readiness, /information_schema\.columns/);
    assert.match(readiness, /pg_constraint/);
    assert.match(server, /process\.exit\(1\)/);
    assert.match(route, /recommendOfficerClassification/);
    assert.match(triage, /validateAssignmentMatch/);
    assert.match(route, /weekly-checkins/);
    assert.match(route, /management-summary/);
    assert.match(route, /business-owner-actions/);
    assert.match(route, /performance-checkpoints/);
});

test('PG-5 workspace provides officers a scoped submission and resubmission UI', () => {
    const html = source('public/index.html');
    const app = source('public/js/app.js');
    assert.match(html, /data-page="teamLeadership" data-roles="admin team_leader officer"/);
    assert.match(html, /id="pageTeamLeadership"/);
    assert.match(html, /id="formPg5ReviewSubmission"[^>]*data-roles="officer"/);
    assert.match(html, /id="tlReviewFile"/);
    assert.match(html, /id="tlReviewGate"/);
    assert.match(html, /PG-5 Review Queue/);
    assert.match(html, /Weekly Check-ins/);
    assert.match(html, /Business-owner Actions/);
    assert.match(html, /Performance Checkpoints/);
    assert.match(app, /loadTeamLeadership/);
    assert.match(app, /\/api\/team-leadership\/management-summary/);
    assert.match(app, /\/api\/team-leadership\/reviews/);
    assert.match(app, /status:\s*'resubmitted'/);
    assert.match(app, /completeBusinessOwnerAction/);
});
