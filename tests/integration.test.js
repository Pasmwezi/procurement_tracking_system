const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { executeFileTransfers } = require('../services/fileTransfers');
const { replaceProcessSteps } = require('../services/processSteps');
const { syncTriageAwardStatus, reconcileAssignedTriageAwards } = require('../services/triageProgress');

const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
    test('database integration tests require TEST_DATABASE_URL', { skip: true }, () => {});
} else {
    const pool = new Pool({ connectionString });

    test.before(async () => {
        await pool.query(`
            DROP SCHEMA public CASCADE; CREATE SCHEMA public;
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                display_name TEXT NOT NULL,
                email TEXT NOT NULL,
                role TEXT NOT NULL,
                is_active BOOLEAN NOT NULL DEFAULT TRUE
            );
            CREATE TABLE processes (name TEXT PRIMARY KEY);
            CREATE TABLE process_steps (
                id SERIAL PRIMARY KEY,
                process_name TEXT NOT NULL REFERENCES processes(name) ON DELETE CASCADE,
                step_name TEXT NOT NULL,
                sla_days INTEGER NOT NULL,
                cum_days INTEGER NOT NULL,
                step_order INTEGER NOT NULL,
                UNIQUE (process_name, step_order)
            );
            CREATE TABLE files (
                id SERIAL PRIMARY KEY,
                pr_number TEXT NOT NULL,
                title TEXT NOT NULL,
                process_name TEXT REFERENCES processes(name),
                officer_id INTEGER NOT NULL REFERENCES users(id),
                current_step_id INTEGER REFERENCES process_steps(id),
                status TEXT NOT NULL DEFAULT 'Active'
            );
            CREATE TABLE notifications (
                id SERIAL PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                officer_id INTEGER NOT NULL REFERENCES users(id),
                step_id INTEGER REFERENCES process_steps(id),
                message TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE
            );
            CREATE TABLE file_step_log (
                id SERIAL PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                step_id INTEGER NOT NULL REFERENCES process_steps(id)
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
            CREATE TABLE triage_files (
                id SERIAL PRIMARY KEY,
                pr_number TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                business_owner TEXT NOT NULL,
                status TEXT NOT NULL,
                file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
                updated_at TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE triage_status_history (
                id SERIAL PRIMARY KEY,
                triage_file_id INTEGER NOT NULL REFERENCES triage_files(id) ON DELETE CASCADE,
                from_status TEXT,
                to_status TEXT NOT NULL,
                changed_by INTEGER,
                note TEXT,
                created_at TIMESTAMP DEFAULT NOW()
            );
        `);
    });

    test.after(async () => pool.end());

    test('executeFileTransfers atomically transfers active files, alerts, and audit history', async () => {
        await pool.query('TRUNCATE audit_log, notifications, file_step_log, files, process_steps, processes, users RESTART IDENTITY CASCADE');
        const users = await pool.query(`INSERT INTO users(display_name,email,role,is_active) VALUES
            ('Source','source@example.test','officer',TRUE),
            ('Target','target@example.test','officer',TRUE),
            ('Admin','admin@example.test','admin',TRUE)
            RETURNING id`);
        await pool.query("INSERT INTO processes(name) VALUES ('P')");
        const step = await pool.query("INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES ('P','Start',0,0,1) RETURNING id");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-1','One','P',$1,$2,'Active') RETURNING id", [users.rows[0].id, step.rows[0].id]);
        await pool.query("INSERT INTO notifications(file_id,officer_id,step_id,message,is_read) VALUES ($1,$2,$3,'Due soon',FALSE)", [file.rows[0].id, users.rows[0].id, step.rows[0].id]);

        const result = await executeFileTransfers(pool, {
            fromOfficerId: users.rows[0].id,
            transfers: [{ file_id: file.rows[0].id, to_officer_id: users.rows[1].id }],
            userId: 99,
            ipAddress: '127.0.0.1'
        });

        assert.equal(result.transferredCount, 1);
        assert.equal((await pool.query('SELECT officer_id FROM files WHERE id=$1', [file.rows[0].id])).rows[0].officer_id, users.rows[1].id);
        assert.equal((await pool.query('SELECT officer_id FROM notifications WHERE file_id=$1 AND is_read=FALSE', [file.rows[0].id])).rows[0].officer_id, users.rows[1].id);
        const audit = await pool.query("SELECT old_value, new_value FROM audit_log WHERE action='file.transfer'");
        assert.equal(audit.rowCount, 1);
        assert.equal(audit.rows[0].old_value.officer_id, users.rows[0].id);
        assert.equal(audit.rows[0].new_value.officer_id, users.rows[1].id);
    });

    test('executeFileTransfers rejects non-officer targets without partial updates', async () => {
        const source = await pool.query("SELECT id FROM users WHERE role='officer' ORDER BY id LIMIT 1");
        const admin = await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1");
        const file = await pool.query('SELECT id, officer_id FROM files LIMIT 1');
        await assert.rejects(() => executeFileTransfers(pool, {
            fromOfficerId: source.rows[0].id,
            transfers: [{ file_id: file.rows[0].id, to_officer_id: admin.rows[0].id }],
            userId: 99
        }), /active officer/i);
        assert.equal((await pool.query('SELECT officer_id FROM files WHERE id=$1', [file.rows[0].id])).rows[0].officer_id, file.rows[0].officer_id);
    });

    test('replaceProcessSteps safely reorders referenced steps and recalculates cumulative SLA', async () => {
        await pool.query('TRUNCATE audit_log, notifications, file_step_log, files, process_steps, processes RESTART IDENTITY CASCADE');
        await pool.query("INSERT INTO processes(name) VALUES ('Editable')");
        const inserted = await pool.query(`INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES
            ('Editable','First',2,2,1), ('Editable','Second',3,5,2), ('Editable','Completed',0,5,3) RETURNING id`);
        inserted.rows.sort((a, b) => a.id - b.id);
        const officer = await pool.query("SELECT id FROM users WHERE role='officer' LIMIT 1");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-2','Two','Editable',$1,$2,'Active') RETURNING id", [officer.rows[0].id, inserted.rows[0].id]);
        await pool.query('INSERT INTO file_step_log(file_id,step_id) VALUES ($1,$2),($1,$3)', [file.rows[0].id, inserted.rows[0].id, inserted.rows[1].id]);

        const result = await replaceProcessSteps(pool, {
            processName: 'Editable',
            steps: [
                { id: inserted.rows[1].id, step_name: 'Second revised', sla_days: 4 },
                { id: inserted.rows[0].id, step_name: 'First revised', sla_days: 1 },
                { id: inserted.rows[2].id, step_name: 'Completed', sla_days: 0 }
            ],
            userId: 99,
            ipAddress: '127.0.0.1'
        });

        assert.deepEqual(result.steps.map(s => [s.id, s.step_name, s.step_order, s.sla_days, s.cum_days]), [
            [inserted.rows[1].id, 'Second revised', 1, 4, 4],
            [inserted.rows[0].id, 'First revised', 2, 1, 5],
            [inserted.rows[2].id, 'Completed', 3, 0, 5]
        ]);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM audit_log WHERE action='process.steps_update'")).rows[0].count, 1);
    });

    test('replaceProcessSteps rejects deletion of a referenced step and rolls back all edits', async () => {
        const before = await pool.query("SELECT id, step_name, step_order FROM process_steps WHERE process_name='Editable' ORDER BY step_order");
        await assert.rejects(() => replaceProcessSteps(pool, {
            processName: 'Editable',
            steps: [
                { id: before.rows[0].id, step_name: 'Changed', sla_days: 2 },
                { id: before.rows[2].id, step_name: 'Completed', sla_days: 0 }
            ],
            userId: 99
        }), /referenced/i);
        const after = await pool.query("SELECT id, step_name, step_order FROM process_steps WHERE process_name='Editable' ORDER BY step_order");
        assert.deepEqual(after.rows, before.rows);
    });

    test('syncTriageAwardStatus atomically marks a linked Assigned triage file as Awarded', async () => {
        await pool.query('TRUNCATE triage_status_history, triage_files, audit_log, notifications, file_step_log, files, process_steps, processes RESTART IDENTITY CASCADE');
        await pool.query("INSERT INTO processes(name) VALUES ('Awardable')");
        const step = await pool.query("INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES ('Awardable','Contract Award',1,1,1) RETURNING id");
        const officer = await pool.query("SELECT id FROM users WHERE role='officer' LIMIT 1");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-AWARD','Award','Awardable',$1,$2,'Active') RETURNING id", [officer.rows[0].id, step.rows[0].id]);
        const triage = await pool.query("INSERT INTO triage_files(pr_number,title,business_owner,status,file_id) VALUES ('PR-AWARD','Award','Owner','Assigned',$1) RETURNING id", [file.rows[0].id]);

        const updatedIds = await syncTriageAwardStatus(pool, {
            fileId: file.rows[0].id,
            stepName: 'Contract Award',
            fileStatus: 'Active',
            userId: 99,
            ipAddress: '127.0.0.1'
        });

        assert.deepEqual(updatedIds, [triage.rows[0].id]);
        assert.equal((await pool.query('SELECT status FROM triage_files WHERE id=$1', [triage.rows[0].id])).rows[0].status, 'Awarded');
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM triage_status_history WHERE triage_file_id=$1 AND from_status='Assigned' AND to_status='Awarded'", [triage.rows[0].id])).rows[0].count, 1);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM audit_log WHERE entity_id=$1 AND action='triage.status_change'", [triage.rows[0].id])).rows[0].count, 1);
    });

    test('reconcileAssignedTriageAwards repairs assigned rows already at award or completion', async () => {
        await pool.query('TRUNCATE triage_status_history, triage_files, audit_log, notifications, file_step_log, files, process_steps, processes RESTART IDENTITY CASCADE');
        await pool.query("INSERT INTO processes(name) VALUES ('Competitive')");
        await pool.query("INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES ('Competitive','Evaluation',1,1,1), ('Competitive','Contract Award',1,2,2), ('Competitive','Completed',0,2,3)");
        const steps = await pool.query("SELECT step_name, id FROM process_steps WHERE process_name='Competitive'");
        const stepIds = Object.fromEntries(steps.rows.map(row => [row.step_name, row.id]));
        const officer = await pool.query("SELECT id FROM users WHERE role='officer' LIMIT 1");
        const awardFile = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-R1','Award stage','Competitive',$1,$2,'Active') RETURNING id", [officer.rows[0].id, stepIds['Contract Award']]);
        const completedFile = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-R2','Completed stage','Competitive',$1,$2,'Completed') RETURNING id", [officer.rows[0].id, stepIds.Completed]);
        const earlyFile = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-R3','Evaluation stage','Competitive',$1,$2,'Active') RETURNING id", [officer.rows[0].id, stepIds.Evaluation]);
        for (const [index, file] of [awardFile, completedFile, earlyFile].entries()) {
            await pool.query("INSERT INTO triage_files(pr_number,title,business_owner,status,file_id) VALUES ($1,$2,'Owner','Assigned',$3)", [`PR-R${index + 1}`, `Row ${index + 1}`, file.rows[0].id]);
        }

        const reconciled = await reconcileAssignedTriageAwards(pool, { note: 'Regression reconciliation' });

        assert.equal(reconciled.length, 2);
        assert.deepEqual((await pool.query('SELECT pr_number,status FROM triage_files ORDER BY pr_number')).rows, [
            { pr_number: 'PR-R1', status: 'Awarded' },
            { pr_number: 'PR-R2', status: 'Awarded' },
            { pr_number: 'PR-R3', status: 'Assigned' }
        ]);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM triage_status_history WHERE to_status='Awarded'")).rows[0].count, 2);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM audit_log WHERE action='triage.status_change'")).rows[0].count, 2);
    });
}
