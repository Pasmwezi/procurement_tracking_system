const test = require('node:test');
const assert = require('node:assert/strict');

const express = require('express');
const XLSX = require('xlsx');
/* global fetch, FormData, Blob */

// Use a dedicated disposable database, never the application's DATABASE_URL.
if (!process.env.WORKFLOW_TEST_DATABASE_URL) {
    test('workflow route regressions require WORKFLOW_TEST_DATABASE_URL', { skip: true }, () => {});
} else {
    process.env.DATABASE_URL = process.env.WORKFLOW_TEST_DATABASE_URL;
    process.env.JWT_SECRET ||= 'a'.repeat(64);
    const pool = require('../db/pool');
    const jwt = require('jsonwebtoken');
    const cookieParser = require('cookie-parser');
    const { requireAuth } = require('../middleware/auth');
    let server, base;
    const req = async (path, method, body, role = 'team_leader', id = 1) => {
        const r = await fetch(base + path, { method, headers: { 'x-role': role, 'x-id': String(id), ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body instanceof FormData ? body : JSON.stringify(body) });
        return { status: r.status, data: await r.json() };
    };
    const triage = async status => (await pool.query("INSERT INTO triage_files(pr_number,title,business_owner,status,team_id) VALUES ('PR-' || nextval('fixture_seq'),'Fixture','Owner',$1,1) RETURNING *", [status])).rows[0];
    test.before(async () => {
        await pool.query(`CREATE SEQUENCE fixture_seq;
            CREATE TABLE users(id int PRIMARY KEY, display_name text, email text, role text, is_active boolean, team_id int, updated_at timestamp, password_hash text, password_changed boolean DEFAULT true, token_version int NOT NULL DEFAULT 0);
            INSERT INTO users(id,display_name,email,role,is_active,team_id) VALUES (1,'Leader',null,'team_leader',true,1),(2,'Officer',null,'officer',true,1),(3,'Other',null,'officer',true,2),(4,'Inactive',null,'officer',false,1);
            CREATE TABLE process_steps(id int PRIMARY KEY, process_name text, step_name text, step_order int, sla_days int);
            INSERT INTO process_steps VALUES(1,'P','Start',1,1);
            CREATE TABLE files(id serial PRIMARY KEY, pr_number text UNIQUE, title text, process_name text, officer_id int, current_step_id int, step_started_at timestamp, created_at timestamp, estimated_value numeric, status text DEFAULT 'Active', completed_at timestamp);
            CREATE TABLE file_step_log(id serial PRIMARY KEY,file_id int,step_id int,started_at timestamp,completed_at timestamp,sla_met boolean);
            CREATE TABLE triage_files(id serial PRIMARY KEY,pr_number varchar(100) UNIQUE,title text,business_owner text,status text,team_id int,estimated_value numeric,created_by int,file_id int,doc_deadline timestamp,cancellation_reason text,updated_at timestamp);
            CREATE TABLE triage_missing_docs(id serial PRIMARY KEY,triage_file_id int,document_name text,provided boolean DEFAULT false);
            CREATE TABLE triage_status_history(id serial PRIMARY KEY,triage_file_id int,from_status text,to_status text,changed_by int,note text);
            CREATE TABLE audit_log(user_id int,action text,entity_type text,entity_id int,old_value jsonb,new_value jsonb,ip_address text);
            CREATE TABLE notifications(id serial PRIMARY KEY,officer_id int,is_read boolean DEFAULT false);`);
        const app = express(); app.use(express.json()); app.use(cookieParser());
        app.use((req, res, next) => { req.user = { id: Number(req.headers['x-id']), role: req.headers['x-role'], teamId: 1 }; next(); });
        app.use('/triage', require('../routes/triage'));
        app.use('/notifications', require('../routes/notifications'));
        app.use('/admin', require('../routes/admin'));
        app.use('/officers', require('../routes/officers'));
        app.use('/auth', require('../routes/auth'));
        app.get('/session-check', requireAuth, (_req, res) => res.json({ ok: true }));
        server = app.listen(0, '127.0.0.1');
        await new Promise(resolve => server.once('listening', resolve));
        base = `http://127.0.0.1:${server.address().port}`;
    });
    test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await pool.end(); });
    test('assignment waits for cancellation and rechecks current eligibility', async () => {
        const t = await triage('Triaged');
        const blocker = await pool.connect();
        let pending;
        try {
            await blocker.query('BEGIN');
            await blocker.query('SELECT id FROM triage_files WHERE id=$1 FOR UPDATE', [t.id]);
            pending = req(`/triage/${t.id}/assign`, 'POST', { officer_id: 2, process_name: 'P' });
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                const q = await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'");
                if (q.rowCount) { waiting = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(waiting, true, 'assignment must reach a database lock');
            await blocker.query("UPDATE triage_files SET status='Cancelled' WHERE id=$1", [t.id]);
            await blocker.query('COMMIT');
            assert.equal((await pending).status, 409);
            assert.equal((await pool.query('SELECT status,file_id FROM triage_files WHERE id=$1', [t.id])).rows[0].status, 'Cancelled');
            assert.equal((await pool.query('SELECT id FROM files WHERE pr_number=$1', [t.pr_number])).rowCount, 0);
        } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
    });
    test('cancellation waits for assignment and rejects a now-linked intake', async () => {
        const t = await triage('Triaged');
        const blocker = await pool.connect();
        let pending;
        try {
            await blocker.query('BEGIN');
            await blocker.query('SELECT id FROM triage_files WHERE id=$1 FOR UPDATE', [t.id]);
            pending = req(`/triage/${t.id}/status`, 'PUT', { status: 'Cancelled' });
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                if ((await pool.query("SELECT query FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount) { waiting = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(waiting, true);
            await blocker.query("UPDATE triage_files SET status='Assigned', file_id=123 WHERE id=$1", [t.id]);
            await blocker.query('COMMIT');
            assert.equal((await pending).status, 409);
            assert.equal((await pool.query('SELECT status FROM triage_files WHERE id=$1', [t.id])).rows[0].status, 'Assigned');
        } finally { await blocker.query('ROLLBACK'); blocker.release(); if (pending) await pending; }
    });
    test('adding missing docs cannot reopen cancelled intake', async () => {
        const t = await triage('Cancelled');
        assert.equal((await req(`/triage/${t.id}/missing-docs`, 'POST', { documents: ['Doc'] })).status, 409);
        assert.equal((await pool.query('SELECT * FROM triage_missing_docs WHERE triage_file_id=$1', [t.id])).rowCount, 0);
    });
    test('notification mutations respect officer ownership and leader scope', async () => {
        const n = (await pool.query('INSERT INTO notifications(officer_id) VALUES(2) RETURNING id')).rows[0];
        assert.equal((await req(`/notifications/${n.id}/read`, 'PUT', {}, 'officer', 1)).status, 404);
        assert.equal((await pool.query('SELECT is_read FROM notifications WHERE id=$1', [n.id])).rows[0].is_read, false);
        assert.equal((await req(`/notifications/${n.id}/read`, 'PUT', {}, 'officer', 2)).status, 200);
        assert.equal((await req(`/notifications/${n.id}/read`, 'PUT', {})).status, 200);
        assert.equal((await req('/notifications/999999/read', 'PUT', {})).status, 404);
        const other = (await pool.query('INSERT INTO notifications(officer_id) VALUES(3) RETURNING id')).rows[0];
        assert.equal((await req(`/notifications/${other.id}/read`, 'PUT', {})).status, 404);
        await req('/notifications/read-all', 'PUT', {});
        assert.equal((await pool.query('SELECT is_read FROM notifications WHERE id=$1', [other.id])).rows[0].is_read, false);
    });
    test('import skips a failed row without rolling back reported successes', async () => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(['IMP-A', 'IMP-A', 'X'.repeat(101), 'IMP-B'].map(pr_number => ({ pr_number, title: 'Fixture', business_owner: 'Owner' }))), 'Import');
        const form = new FormData();
        form.append('file', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'fixture.xlsx');
        const result = await req('/triage/import', 'POST', form);
        assert.equal(result.status, 201);
        const persisted = await pool.query("SELECT id FROM triage_files WHERE pr_number LIKE 'IMP-%'");
        assert.equal(result.data.imported, persisted.rowCount);
        assert.equal(result.data.imported, 2);
        assert.equal(result.data.skipped, 2);
    });
    test('document receipt cannot resurrect cancelled intake', async () => {
        const t = await triage('Missing Document(s)');
        const d = (await pool.query("INSERT INTO triage_missing_docs(triage_file_id,document_name) VALUES($1,'Doc') RETURNING id", [t.id])).rows[0];
        assert.equal((await req(`/triage/${t.id}/status`, 'PUT', { status: 'Cancelled' })).status, 200);
        assert.equal((await req(`/triage/${t.id}/missing-docs/${d.id}`, 'PUT', { provided: true })).status, 409);
        assert.equal((await pool.query('SELECT status FROM triage_files WHERE id=$1', [t.id])).rows[0].status, 'Cancelled');
        assert.equal((await pool.query("SELECT * FROM triage_status_history WHERE triage_file_id=$1 AND to_status='Triaged'", [t.id])).rowCount, 0);
    });
    test('terminal triage documents cannot be toggled or deleted', async () => {
        const t = await triage('Cancelled');
        const doc = await pool.query("INSERT INTO triage_missing_docs(triage_file_id,document_name) VALUES($1,'Historical') RETURNING id", [t.id]);
        assert.equal((await req(`/triage/${t.id}/missing-docs/${doc.rows[0].id}`, 'PUT', { provided: true })).status, 409);
        assert.equal((await req(`/triage/${t.id}/missing-docs/${doc.rows[0].id}`, 'DELETE', {})).status, 409);
        assert.equal((await pool.query('SELECT provided FROM triage_missing_docs WHERE id=$1', [doc.rows[0].id])).rows[0].provided, false);
    });
    test('terminal triage metadata is immutable', async () => {
        const t = await triage('Cancelled');
        assert.equal((await req(`/triage/${t.id}`, 'PUT', { title: 'Rewritten history' })).status, 409);
        assert.equal((await pool.query('SELECT title FROM triage_files WHERE id=$1', [t.id])).rows[0].title, 'Fixture');
    });
    test('generic administrator user update cannot bypass officer lifecycle safeguards', async () => {
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES('ADMIN-GUARD','Guard','P',2,1,'Active') RETURNING id");
        assert.equal((await req('/admin/users/2', 'PUT', { is_active: false }, 'admin')).status, 400);
        assert.equal((await req('/admin/users/2', 'PUT', { role: 'team_leader' }, 'admin')).status, 409);
        assert.equal((await req('/admin/users/2', 'PUT', { team_id: 2 }, 'admin')).status, 409);
        assert.equal((await req('/officers/2', 'DELETE', {}, 'team_leader')).status, 409);
        assert.deepEqual((await pool.query('SELECT role, team_id, is_active FROM users WHERE id=2')).rows[0], { role: 'officer', team_id: 1, is_active: true });
        await pool.query('DELETE FROM files WHERE id=$1', [file.rows[0].id]);
    });
    test('administrator activation uses its dedicated endpoint', async () => {
        assert.equal((await req('/admin/users/4', 'PUT', { is_active: true }, 'admin')).status, 400);
        assert.equal((await req('/admin/users/4/activate', 'PUT', {}, 'admin')).status, 200);
        const accessToken = jwt.sign({ id: 4, role: 'officer', teamId: 1, purpose: 'access', tokenVersion: 0 }, process.env.JWT_SECRET);
        const refreshToken = jwt.sign({ id: 4, purpose: 'refresh', tokenVersion: 0 }, process.env.JWT_SECRET);
        assert.equal((await fetch(base + '/session-check', { headers: { Authorization: `Bearer ${accessToken}` } })).status, 200);
        assert.equal((await req('/admin/users/4', 'DELETE', {}, 'admin')).status, 200);
        assert.equal((await req('/admin/users/4/activate', 'PUT', {}, 'admin')).status, 200);
        assert.equal((await pool.query('SELECT is_active FROM users WHERE id=4')).rows[0].is_active, true);
        assert.equal((await pool.query('SELECT token_version FROM users WHERE id=4')).rows[0].token_version, 1);
        assert.equal((await fetch(base + '/session-check', { headers: { Authorization: `Bearer ${accessToken}` } })).status, 401);
        assert.equal((await fetch(base + '/auth/refresh', { method: 'POST', headers: { Cookie: `refreshToken=${refreshToken}` } })).status, 401);
    });
    test('officer deactivation rejects malformed identifiers without truncating them', async () => {
        assert.equal((await req('/officers/4xyz', 'DELETE', {}, 'team_leader')).status, 400);
        assert.equal((await req('/officers/4.5', 'DELETE', {}, 'team_leader')).status, 400);
        assert.equal((await pool.query('SELECT is_active FROM users WHERE id=4')).rows[0].is_active, true);
    });
    test('administrator cannot create an active teamless officer or team leader', async () => {
        assert.equal((await req('/admin/users', 'POST', { email: 'teamless-officer@example.test', display_name: 'Teamless', role: 'officer', team_id: null }, 'admin')).status, 400);
        assert.equal((await req('/admin/users', 'POST', { email: 'teamless-leader@example.test', display_name: 'Teamless', role: 'team_leader' }, 'admin')).status, 400);
        assert.equal((await pool.query("SELECT id FROM users WHERE email LIKE 'teamless-%'")).rowCount, 0);
    });
    test('administrator role or team change rechecks assignments after waiting on the officer lock', async () => {
        await pool.query("INSERT INTO users(id,display_name,email,role,is_active,team_id) VALUES(5,'Race Officer','race-admin@example.test','officer',true,1)");
        const assignment = await pool.connect();
        let pending;
        try {
            await assignment.query('BEGIN');
            await assignment.query('SELECT id FROM users WHERE id=5 FOR SHARE');
            pending = req('/admin/users/5', 'PUT', { team_id: 2 }, 'admin');
            let waiting = false;
            for (let i = 0; i < 100; i++) {
                if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'")).rowCount) { waiting = true; break; }
                await new Promise(resolve => setTimeout(resolve, 10));
            }
            assert.equal(waiting, true);
            await assignment.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES('ADMIN-RACE','Race','P',5,1,'Active')");
            await assignment.query('COMMIT');
            assert.equal((await pending).status, 409);
            assert.equal((await pool.query('SELECT team_id FROM users WHERE id=5')).rows[0].team_id, 1);
        } finally {
            await assignment.query('ROLLBACK');
            assignment.release();
            if (pending) await pending;
        }
    });
    test('administrator profile update handles database connection failure', async () => {
        const originalConnect = pool.connect;
        pool.connect = async () => { throw new Error('synthetic connection failure'); };
        try {
            assert.equal((await req('/admin/users/2', 'PUT', { display_name: 'No write' }, 'admin')).status, 500);
        } finally {
            pool.connect = originalConnect;
        }
    });
}
