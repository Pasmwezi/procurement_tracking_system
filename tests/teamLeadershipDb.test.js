const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('fs');
const path = require('path');
/* global fetch */

if (!process.env.PG5_TEST_DATABASE_URL) {
    test('PG-5 route integration tests require PG5_TEST_DATABASE_URL', { skip: true }, () => {});
} else {
    process.env.DATABASE_URL = process.env.PG5_TEST_DATABASE_URL;
    const pool = require('../db/pool');
    let server;
    let base;

    async function request(route, method = 'GET', body, role = 'team_leader', id = 10, teamId = 1) {
        const response = await fetch(base + route, {
            method,
            headers: {
                'Content-Type': 'application/json',
                'x-role': role,
                'x-user-id': String(id),
                'x-team-id': String(teamId)
            },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, data: await response.json() };
    }

    test.before(async () => {
        await pool.query(`
            DROP SCHEMA public CASCADE; CREATE SCHEMA public;
            CREATE TABLE teams (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
            CREATE TABLE users (
                id INTEGER PRIMARY KEY,
                display_name TEXT NOT NULL,
                email TEXT,
                role TEXT NOT NULL,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                team_id INTEGER REFERENCES teams(id),
                updated_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE process_steps (id INTEGER PRIMARY KEY, step_name TEXT NOT NULL);
            CREATE TABLE files (
                id INTEGER PRIMARY KEY,
                pr_number TEXT NOT NULL,
                title TEXT NOT NULL,
                officer_id INTEGER NOT NULL REFERENCES users(id),
                current_step_id INTEGER REFERENCES process_steps(id),
                status TEXT NOT NULL DEFAULT 'Active'
            );
            CREATE TABLE triage_files (
                id INTEGER PRIMARY KEY,
                team_id INTEGER REFERENCES teams(id),
                status TEXT NOT NULL DEFAULT 'Triaged',
                updated_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE audit_log (
                id SERIAL PRIMARY KEY,
                user_id INTEGER,
                action TEXT NOT NULL,
                entity_type TEXT NOT NULL,
                entity_id INTEGER,
                old_value JSONB,
                new_value JSONB,
                ip_address TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
            INSERT INTO teams VALUES (1, 'One'), (2, 'Two');
            INSERT INTO users(id,display_name,role,team_id) VALUES
                (10,'Leader One','team_leader',1),
                (20,'Officer One','officer',1),
                (21,'Transferred Officer','officer',1),
                (30,'Leader Two','team_leader',2),
                (31,'Officer Two','officer',2);
            INSERT INTO process_steps VALUES (1,'Start');
            INSERT INTO files VALUES (100,'PR-100','Owned file',20,1,'Active');
        `);
        await pool.query(fs.readFileSync(path.join(__dirname, '../db/migrate-v5-team-leadership.sql'), 'utf8'));

        const app = express();
        app.use(express.json());
        app.use((req, _res, next) => {
            req.user = {
                id: Number(req.headers['x-user-id']),
                role: req.headers['x-role'],
                teamId: Number(req.headers['x-team-id'])
            };
            next();
        });
        app.use('/team-leadership', require('../routes/teamLeadership'));
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    test.after(async () => {
        if (server) await new Promise(resolve => server.close(resolve));
        await pool.end();
    });

    test('leaders record completed reviews with decision identity and transactional audit', async () => {
        const response = await request('/team-leadership/reviews', 'POST', {
            file_id: 100, gate: 'close-out', status: 'cleared', decision_note: 'Completed verification'
        });
        assert.equal(response.status, 201);
        assert.equal(response.data.status, 'cleared');
        assert.equal(response.data.decided_by, 10);
        assert.ok(response.data.decided_at);
        assert.equal(response.data.decision_note, 'Completed verification');
        const saved = await pool.query('SELECT * FROM pg5_reviews WHERE id=$1', [response.data.id]);
        assert.equal(saved.rows[0].status, 'cleared');
        const audit = await pool.query("SELECT * FROM audit_log WHERE action='pg5_review.record_completed' AND entity_id=$1", [response.data.id]);
        assert.equal(audit.rowCount, 1);
        assert.equal(audit.rows[0].new_value.status, 'cleared');
        await pool.query('DELETE FROM pg5_reviews WHERE id=$1', [response.data.id]);
    });

    test('officers can list only reviews for files they currently own', async () => {
        await pool.query("INSERT INTO pg5_reviews(file_id,gate,status,submitted_by) VALUES(100,'strategy','returned',20)");
        const response = await request('/team-leadership/reviews', 'GET', undefined, 'officer', 20, 1);
        assert.equal(response.status, 200);
        assert.equal(response.data.length, 1);
        assert.equal(response.data[0].file_id, 100);
    });

    test('completed recording cannot bypass an existing active review', async () => {
        const response = await request('/team-leadership/reviews', 'POST', {
            file_id: 100, gate: 'strategy', status: 'cleared', decision_note: 'Must decide the existing review'
        });
        assert.equal(response.status, 409);
        assert.equal((await pool.query("SELECT id FROM pg5_reviews WHERE file_id=100 AND gate='strategy'")).rowCount, 1);
    });

    test('completed review creation enforces role, team, active file and input boundaries', async () => {
        await pool.query("INSERT INTO files VALUES (102,'PR-102','Other team',31,1,'Active'),(103,'PR-103','Closed',20,1,'Completed')");
        const payload = { file_id: 100, gate: 'other', status: 'cleared', decision_note: 'Decision' };
        for (const status of ['cleared', 'conditionally cleared']) {
            assert.equal((await request('/team-leadership/reviews', 'POST', { ...payload, status }, 'officer', 20, 1)).status, 403);
        }
        assert.equal((await request('/team-leadership/reviews', 'POST', { ...payload, file_id: 102 })).status, 403);
        assert.equal((await request('/team-leadership/reviews', 'POST', { ...payload, file_id: 103 })).status, 403);
        for (const change of [{ decision_note: '' }, { decision_note: '  ' }, { decision_note: null }, { status: 'reviewing' }, { status: null }, { gate: 'invalid' }]) {
            assert.equal((await request('/team-leadership/reviews', 'POST', { ...payload, ...change })).status, 400);
        }
        assert.equal((await pool.query("SELECT id FROM pg5_reviews WHERE gate='other'")).rowCount, 0);
        const admin = await request('/team-leadership/reviews', 'POST', { ...payload, file_id: 102, status: 'conditionally cleared' }, 'admin', 10, 1);
        assert.equal(admin.status, 201);
        assert.equal(admin.data.status, 'conditionally cleared');
        assert.equal(admin.data.decided_by, 10);
        await pool.query('DELETE FROM pg5_reviews WHERE id=$1', [admin.data.id]);
    });

    test('completed recording rolls back when required audit fails', async () => {
        await pool.query(`CREATE FUNCTION reject_completed_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            IF NEW.action='pg5_review.record_completed' THEN RAISE EXCEPTION 'QA audit failure'; END IF;
            RETURN NEW; END $$;
            CREATE TRIGGER reject_completed_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_completed_audit()`);
        try {
            const response = await request('/team-leadership/reviews', 'POST', { file_id: 100, gate: 'other', status: 'cleared', decision_note: 'Audited decision' });
            assert.equal(response.status, 500);
            assert.equal((await pool.query("SELECT id FROM pg5_reviews WHERE gate='other'")).rowCount, 0);
        } finally {
            await pool.query('DROP TRIGGER reject_completed_audit ON audit_log; DROP FUNCTION reject_completed_audit()');
        }
    });

    test('completed recording rechecks scope after a concurrent team transfer', async () => {
        const blocker = await pool.connect();
        let pending;
        try {
            await blocker.query('BEGIN');
            await blocker.query('SELECT id FROM users WHERE id=20 FOR UPDATE');
            pending = request('/team-leadership/reviews', 'POST', { file_id: 100, gate: 'other', status: 'cleared', decision_note: 'Must not cross teams' });
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount) { waiting = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(waiting, true);
            await blocker.query('UPDATE users SET team_id=2 WHERE id=20');
            await blocker.query('COMMIT');
            assert.equal((await pending).status, 403);
            assert.equal((await pool.query("SELECT id FROM pg5_reviews WHERE gate='other'")).rowCount, 0);
        } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            if (pending) await pending;
            await pool.query('UPDATE users SET team_id=1 WHERE id=20');
        }
    });

    test('officers cannot self-clear submitted reviews', async () => {
        const existing = await pool.query("SELECT id FROM pg5_reviews WHERE file_id=100 AND gate='strategy'");
        assert.equal((await request(`/team-leadership/reviews/${existing.rows[0].id}/status`, 'PUT', { status: 'cleared' }, 'officer', 20, 1)).status, 409);
    });

    test('a file and gate cannot have two active PG-5 reviews', async () => {
        const duplicate = await request('/team-leadership/reviews', 'POST', {
            file_id: 100,
            gate: 'strategy',
            submission_note: 'Duplicate'
        }, 'officer', 20, 1);
        assert.equal(duplicate.status, 409);
        const count = await pool.query("SELECT COUNT(*)::int AS count FROM pg5_reviews WHERE file_id=100 AND gate='strategy' AND status IN ('submitted','reviewing','returned','resubmitted')");
        assert.equal(count.rows[0].count, 1);
    });

    test('an officer resubmission preserves the leader decision note', async () => {
        const review = await pool.query("SELECT id FROM pg5_reviews WHERE file_id=100 AND gate='strategy'");
        await pool.query("UPDATE pg5_reviews SET decision_note='Address the evaluation method' WHERE id=$1", [review.rows[0].id]);
        const response = await request(`/team-leadership/reviews/${review.rows[0].id}/status`, 'PUT', {
            status: 'resubmitted',
            submission_note: 'Method updated'
        }, 'officer', 20, 1);
        assert.equal(response.status, 200);
        assert.equal(response.data.decision_note, 'Address the evaluation method');
        assert.equal(response.data.submission_note, 'Method updated');
    });

    test('former-team leaders cannot overwrite a transferred officer weekly check-in', async () => {
        await pool.query("INSERT INTO weekly_checkins(officer_id,team_id,week_start,operational_summary,created_by,updated_by) VALUES(21,2,'2026-10-05','Team two record',30,30)");
        const response = await request('/team-leadership/weekly-checkins', 'POST', {
            officer_id: 21,
            week_start: '2026-10-05',
            operational_summary: 'Team one overwrite'
        }, 'team_leader', 10, 1);
        assert.equal(response.status, 409);
        const row = await pool.query("SELECT team_id,operational_summary FROM weekly_checkins WHERE officer_id=21 AND week_start='2026-10-05'");
        assert.deepEqual(row.rows[0], { team_id: 2, operational_summary: 'Team two record' });
    });

    test('former-team leaders cannot overwrite a transferred officer performance checkpoint', async () => {
        await pool.query("INSERT INTO performance_checkpoints(officer_id,team_id,year,checkpoint_type,due_date,created_by,updated_by) VALUES(21,2,2026,'mid-year','2026-06-30',30,30)");
        const response = await request('/team-leadership/performance-checkpoints', 'POST', {
            officer_id: 21,
            year: 2026,
            checkpoint_type: 'mid-year',
            due_date: '2026-07-31'
        }, 'team_leader', 10, 1);
        assert.equal(response.status, 409);
        const row = await pool.query("SELECT team_id,due_date::text FROM performance_checkpoints WHERE officer_id=21 AND year=2026 AND checkpoint_type='mid-year'");
        assert.deepEqual(row.rows[0], { team_id: 2, due_date: '2026-06-30' });
    });

    test('leaders can complete and reopen only business-owner actions in scope', async () => {
        const own = await pool.query("INSERT INTO business_owner_actions(team_id,business_owner,action_month,action,created_by,updated_by) VALUES(1,'Owner','2026-10-01','Follow up',10,10) RETURNING id");
        const other = await pool.query("INSERT INTO business_owner_actions(team_id,business_owner,action_month,action,created_by,updated_by) VALUES(2,'Other','2026-10-01','Other action',30,30) RETURNING id");

        const completed = await request(`/team-leadership/business-owner-actions/${own.rows[0].id}/status`, 'PUT', { completed: true });
        assert.equal(completed.status, 200);
        assert.ok(completed.data.completed_at);
        const reopened = await request(`/team-leadership/business-owner-actions/${own.rows[0].id}/status`, 'PUT', { completed: false });
        assert.equal(reopened.status, 200);
        assert.equal(reopened.data.completed_at, null);
        const denied = await request(`/team-leadership/business-owner-actions/${other.rows[0].id}/status`, 'PUT', { completed: true });
        assert.equal(denied.status, 404);
    });

    test('weekly check-in writes record the updater and required audit event', async () => {
        const response = await request('/team-leadership/weekly-checkins', 'POST', {
            officer_id: 20,
            week_start: '2026-10-12',
            operational_summary: 'Audited update'
        });
        assert.equal(response.status, 201);
        assert.equal(response.data.updated_by, 10);
        const audit = await pool.query("SELECT * FROM audit_log WHERE action='weekly_checkin.upsert' AND entity_id=$1", [response.data.id]);
        assert.equal(audit.rowCount, 1);
    });

    test('performance checkpoint writes record the updater and required audit event', async () => {
        const response = await request('/team-leadership/performance-checkpoints', 'POST', {
            officer_id: 20,
            year: 2027,
            checkpoint_type: 'objective-setting',
            due_date: '2027-04-01'
        });
        assert.equal(response.status, 201);
        assert.equal(response.data.updated_by, 10);
        const audit = await pool.query("SELECT * FROM audit_log WHERE action='performance_checkpoint.upsert' AND entity_id=$1", [response.data.id]);
        assert.equal(audit.rowCount, 1);
    });

    test('business-owner action creation records a required audit event', async () => {
        const response = await request('/team-leadership/business-owner-actions', 'POST', {
            team_id: 1,
            business_owner: 'Audited owner',
            action_month: '2026-11-01',
            action: 'Audited action'
        });
        assert.equal(response.status, 201);
        assert.equal(response.data.updated_by, 10);
        const audit = await pool.query("SELECT * FROM audit_log WHERE action='business_owner_action.create' AND entity_id=$1", [response.data.id]);
        assert.equal(audit.rowCount, 1);
    });

    test('weekly check-in authorization is rechecked after a concurrent officer transfer', async () => {
        const blocker = await pool.connect();
        let pending;
        try {
            await blocker.query('BEGIN');
            await blocker.query('SELECT id FROM users WHERE id=21 FOR UPDATE');
            pending = request('/team-leadership/weekly-checkins', 'POST', {
                officer_id: 21,
                week_start: '2026-10-19',
                operational_summary: 'Must not cross teams'
            });
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount) { waiting = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(waiting, true);
            await blocker.query('UPDATE users SET team_id=2 WHERE id=21');
            await blocker.query('COMMIT');
            assert.equal((await pending).status, 404);
            assert.equal((await pool.query("SELECT id FROM weekly_checkins WHERE officer_id=21 AND week_start='2026-10-19'")).rowCount, 0);
        } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            if (pending) await pending;
            await pool.query('UPDATE users SET team_id=1 WHERE id=21');
        }
    });

    test('review submission authorization is rechecked after concurrent file transfer', async () => {
        await pool.query("INSERT INTO files VALUES (101,'PR-101','Transfer race',20,1,'Active')");
        const blocker = await pool.connect();
        let pending;
        try {
            await blocker.query('BEGIN');
            await blocker.query('SELECT id FROM files WHERE id=101 FOR UPDATE');
            pending = request('/team-leadership/reviews', 'POST', {
                file_id: 101,
                gate: 'pre-award'
            }, 'team_leader', 10, 1);
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount) { waiting = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(waiting, true);
            await blocker.query('UPDATE files SET officer_id=31 WHERE id=101');
            await blocker.query('COMMIT');
            assert.equal((await pending).status, 403);
            assert.equal((await pool.query('SELECT id FROM pg5_reviews WHERE file_id=101')).rowCount, 0);
        } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            if (pending) await pending;
        }
    });

    test('PG-5 schema validation rejects partial defaults, constraints, and columns', async () => {
        const { validatePg5Schema } = require('../services/schemaReadiness');
        await validatePg5Schema(pool);

        await pool.query('ALTER TABLE pg5_reviews ALTER COLUMN id DROP DEFAULT');
        await assert.rejects(() => validatePg5Schema(pool), /schema validation failed/i);
        await pool.query("ALTER TABLE pg5_reviews ALTER COLUMN id SET DEFAULT nextval('pg5_reviews_id_seq'::regclass)");

        await pool.query('ALTER TABLE pg5_reviews DROP CONSTRAINT pg5_reviews_status_check');
        await pool.query("ALTER TABLE pg5_reviews ADD CONSTRAINT pg5_reviews_status_check CHECK (status IN ('submitted','reviewing','returned','resubmitted','conditionally cleared','escalated'))");
        await assert.rejects(() => validatePg5Schema(pool), /schema validation failed/i);
        await pool.query('ALTER TABLE pg5_reviews DROP CONSTRAINT pg5_reviews_status_check');
        await pool.query("ALTER TABLE pg5_reviews ADD CONSTRAINT pg5_reviews_status_check CHECK (status IN ('submitted','reviewing','returned','resubmitted','cleared','conditionally cleared','escalated'))");

        await pool.query('ALTER TABLE pg5_reviews DROP CONSTRAINT pg5_reviews_status_check');
        await pool.query("CREATE TABLE pg5_review_constraint_decoy (status VARCHAR(40) CONSTRAINT pg5_reviews_status_check CHECK (status IN ('submitted','reviewing','returned','resubmitted','cleared','conditionally cleared','escalated')))");
        await assert.rejects(() => validatePg5Schema(pool), /schema validation failed/i);
        await pool.query('DROP TABLE pg5_review_constraint_decoy');
        await pool.query("ALTER TABLE pg5_reviews ADD CONSTRAINT pg5_reviews_status_check CHECK (status IN ('submitted','reviewing','returned','resubmitted','cleared','conditionally cleared','escalated'))");

        await pool.query('ALTER TABLE weekly_checkins DROP COLUMN updated_by');
        await assert.rejects(() => validatePg5Schema(pool), /schema validation failed/i);
    });
}
