const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');
const { executeFileTransfers } = require('../services/fileTransfers');
const { replaceProcessSteps } = require('../services/processSteps');
const {
    lockActiveFileForAdvancement,
    updateActiveFileProgress
} = require('../services/fileLifecycle');
const {
    syncTriageAwardStatus,
    reconcileAssignedTriageAwards,
    syncTriageCancellationStatus,
    reconcileAssignedTriageCancellations
} = require('../services/triageProgress');
const connectionString = process.env.TEST_DATABASE_URL;

if (!connectionString) {
    test('database integration tests require TEST_DATABASE_URL', { skip: true }, () => {});
} else {
    process.env.DATABASE_URL ||= connectionString;
    const { checkSLAs, createNotificationForCurrentOwner } = require('../services/slaChecker');
    const pool = new Pool({ connectionString });

    test.before(async () => {
        await pool.query(`
            DROP SCHEMA public CASCADE; CREATE SCHEMA public;
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                display_name TEXT NOT NULL,
                email TEXT NOT NULL,
                role TEXT NOT NULL,
                is_active BOOLEAN NOT NULL DEFAULT TRUE,
                team_id INTEGER
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
                status TEXT NOT NULL DEFAULT 'Active',
                step_started_at TIMESTAMP,
                completed_at TIMESTAMP
            );
            CREATE TABLE contracts (
                id SERIAL PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                contract_number TEXT,
                contractor_name TEXT,
                end_date DATE NOT NULL,
                amended_end_date DATE
            );
            CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE notifications (
                id SERIAL PRIMARY KEY,
                file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                officer_id INTEGER NOT NULL REFERENCES users(id),
                step_id INTEGER REFERENCES process_steps(id),
                message TEXT NOT NULL,
                contract_id INTEGER REFERENCES contracts(id) ON DELETE CASCADE,
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
        const users = await pool.query(`INSERT INTO users(display_name,email,role,is_active,team_id) VALUES
            ('Source','source@example.test','officer',TRUE,1),
            ('Target','target@example.test','officer',TRUE,1),
            ('Outsider','outsider@example.test','officer',TRUE,2),
            ('Admin','admin@example.test','admin',TRUE,NULL)
            RETURNING id`);
        await pool.query("INSERT INTO processes(name) VALUES ('P')");
        const step = await pool.query("INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES ('P','Start',0,0,1) RETURNING id");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-1','One','P',$1,$2,'Active') RETURNING id", [users.rows[0].id, step.rows[0].id]);
        await pool.query("INSERT INTO notifications(file_id,officer_id,step_id,message,is_read) VALUES ($1,$2,$3,'Due soon',FALSE)", [file.rows[0].id, users.rows[0].id, step.rows[0].id]);

        const result = await executeFileTransfers(pool, {
            fromOfficerId: users.rows[0].id,
            transfers: [{ file_id: file.rows[0].id, to_officer_id: users.rows[1].id }],
            userId: 99,
            teamId: 1,
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
            userId: 99,
            teamId: 1
        }), /active officer/i);
        assert.equal((await pool.query('SELECT officer_id FROM files WHERE id=$1', [file.rows[0].id])).rows[0].officer_id, file.rows[0].officer_id);
    });

    test('executeFileTransfers rejects cross-team targets without partial updates', async () => {
        const source = await pool.query("SELECT id FROM users WHERE email='source@example.test'");
        const outsider = await pool.query("SELECT id FROM users WHERE email='outsider@example.test'");
        const file = await pool.query("SELECT id, officer_id FROM files WHERE pr_number='PR-1'");
        await assert.rejects(() => executeFileTransfers(pool, {
            fromOfficerId: source.rows[0].id,
            transfers: [{ file_id: file.rows[0].id, to_officer_id: outsider.rows[0].id }],
            userId: 99,
            teamId: 1
        }), /active officer/i);
        assert.equal((await pool.query('SELECT officer_id FROM files WHERE id=$1', [file.rows[0].id])).rows[0].officer_id, file.rows[0].officer_id);
    });

    test('executeFileTransfers permits an explicitly global administrator transfer across teams', async () => {
        const source = await pool.query("SELECT id FROM users WHERE email='source@example.test'");
        const outsider = await pool.query("SELECT id FROM users WHERE email='outsider@example.test'");
        const file = await pool.query("SELECT id FROM files WHERE pr_number='PR-1'");
        await pool.query('UPDATE files SET officer_id=$1 WHERE id=$2', [source.rows[0].id, file.rows[0].id]);
        await pool.query('UPDATE notifications SET officer_id=$1 WHERE file_id=$2', [source.rows[0].id, file.rows[0].id]);

        const result = await executeFileTransfers(pool, {
            fromOfficerId: source.rows[0].id,
            transfers: [{ file_id: file.rows[0].id, to_officer_id: outsider.rows[0].id }],
            userId: 99,
            teamId: null,
            allowCrossTeam: true,
            ipAddress: '127.0.0.1'
        });

        assert.equal(result.transferredCount, 1);
        assert.equal((await pool.query('SELECT officer_id FROM files WHERE id=$1', [file.rows[0].id])).rows[0].officer_id, outsider.rows[0].id);
        assert.equal((await pool.query('SELECT officer_id FROM notifications WHERE file_id=$1 AND is_read=FALSE', [file.rows[0].id])).rows[0].officer_id, outsider.rows[0].id);
        const audit = await pool.query("SELECT old_value, new_value FROM audit_log WHERE action='file.transfer' ORDER BY id DESC LIMIT 1");
        assert.equal(audit.rows[0].old_value.officer_id, source.rows[0].id);
        assert.equal(audit.rows[0].new_value.officer_id, outsider.rows[0].id);
    });

    test('SLA notification creation revalidates ownership after a concurrent assignment change', async () => {
        const source = await pool.query("SELECT id FROM users WHERE email='source@example.test'");
        const outsider = await pool.query("SELECT id FROM users WHERE email='outsider@example.test'");
        const step = await pool.query("SELECT id FROM process_steps WHERE process_name='P' LIMIT 1");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-RACE-NOTIFY','Race notification','P',$1,$2,'Active') RETURNING id", [source.rows[0].id, step.rows[0].id]);
        const assignment = await pool.connect();
        let pending;
        try {
            await assignment.query('BEGIN');
            await assignment.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [file.rows[0].id]);
            pending = createNotificationForCurrentOwner(pool, {
                fileId: file.rows[0].id,
                expectedOfficerId: source.rows[0].id,
                expectedStepId: step.rows[0].id,
                message: 'Race-safe notification',
                notificationKind: 'step',
                requireActive: true
            });
            await assignment.query('UPDATE files SET officer_id=$1 WHERE id=$2', [outsider.rows[0].id, file.rows[0].id]);
            await assignment.query('COMMIT');
            assert.equal(await pending, null);
            assert.equal((await pool.query('SELECT id FROM notifications WHERE file_id=$1', [file.rows[0].id])).rowCount, 0);
        } finally {
            await assignment.query('ROLLBACK');
            assignment.release();
            if (pending) await pending;
        }
    });

    test('contract notification creation revalidates a concurrent amendment', async () => {
        const officer = await pool.query("SELECT id FROM users WHERE email='source@example.test'");
        const step = await pool.query("SELECT id FROM process_steps WHERE process_name='P' LIMIT 1");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-CONTRACT-RACE','Contract race','P',$1,$2,'Completed') RETURNING id", [officer.rows[0].id, step.rows[0].id]);
        const contract = await pool.query("INSERT INTO contracts(file_id,contract_number,end_date) VALUES($1,'C-RACE',CURRENT_DATE + 10) RETURNING id", [file.rows[0].id]);
        const amendment = await pool.connect();
        let pending;
        try {
            await amendment.query('BEGIN');
            await amendment.query('SELECT id FROM contracts WHERE id=$1 FOR UPDATE', [contract.rows[0].id]);
            pending = createNotificationForCurrentOwner(pool, {
                fileId: file.rows[0].id,
                expectedOfficerId: officer.rows[0].id,
                expectedStepId: step.rows[0].id,
                contractId: contract.rows[0].id,
                message: 'Expiring contract',
                notificationKind: 'contract'
            });
            await amendment.query('UPDATE contracts SET amended_end_date=CURRENT_DATE + 60 WHERE id=$1', [contract.rows[0].id]);
            await amendment.query('COMMIT');
            assert.equal(await pending, null);
            assert.equal((await pool.query('SELECT id FROM notifications WHERE contract_id=$1', [contract.rows[0].id])).rowCount, 0);
        } finally {
            await amendment.query('ROLLBACK');
            amendment.release();
            if (pending) await pending;
        }
    });

    test('each expiring contract on one file has an independent notification key', async () => {
        const officer = await pool.query("SELECT id FROM users WHERE email='source@example.test'");
        const step = await pool.query("SELECT id FROM process_steps WHERE process_name='P' LIMIT 1");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-MULTI-CONTRACT','Multiple contracts','P',$1,$2,'Completed') RETURNING id", [officer.rows[0].id, step.rows[0].id]);
        const contracts = await pool.query("INSERT INTO contracts(file_id,contract_number,end_date) VALUES($1,'C-ONE',CURRENT_DATE + 10),($1,'C-TWO',CURRENT_DATE + 20) RETURNING id", [file.rows[0].id]);
        for (const contract of contracts.rows) {
            const created = await createNotificationForCurrentOwner(pool, {
                fileId: file.rows[0].id,
                expectedOfficerId: officer.rows[0].id,
                expectedStepId: step.rows[0].id,
                contractId: contract.id,
                message: `Expiring contract ${contract.id}`,
                notificationKind: 'contract'
            });
            assert.ok(created);
        }
        assert.equal((await pool.query('SELECT DISTINCT contract_id FROM notifications WHERE file_id=$1', [file.rows[0].id])).rowCount, 2);
    });

    test('concurrent SLA checks share one in-flight execution', async () => {
        const first = checkSLAs(pool);
        const second = checkSLAs(pool);
        assert.equal(first, second);
        await first;
    });

    test('assignment row lock prevents concurrent officer deactivation', async () => {
        const officer = await pool.query("INSERT INTO users(display_name,email,role,is_active,team_id) VALUES('Race','race@example.test','officer',TRUE,1) RETURNING id");
        await pool.query("INSERT INTO processes(name) VALUES('RaceProcess') ON CONFLICT DO NOTHING");
        const step = await pool.query("INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES('RaceProcess','Start',0,0,1) RETURNING id");
        const assignment = await pool.connect();
        const deactivation = await pool.connect();
        try {
            await assignment.query('BEGIN');
            await assignment.query("SELECT id FROM users WHERE id=$1 AND role='officer' AND is_active=TRUE FOR SHARE", [officer.rows[0].id]);
            await deactivation.query('BEGIN');
            let deactivationLocked = false;
            const waiting = deactivation.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [officer.rows[0].id]).then(() => { deactivationLocked = true; });
            await new Promise(resolve => setTimeout(resolve, 50));
            assert.equal(deactivationLocked, false);
            await assignment.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES('RACE-ASSIGN','Race','RaceProcess',$1,$2,'Active')", [officer.rows[0].id, step.rows[0].id]);
            await assignment.query('COMMIT');
            await waiting;
            const assigned = await deactivation.query('SELECT 1 FROM files WHERE officer_id=$1 LIMIT 1', [officer.rows[0].id]);
            assert.equal(assigned.rowCount, 1);
            await deactivation.query('ROLLBACK');
            assert.equal((await pool.query('SELECT is_active FROM users WHERE id=$1', [officer.rows[0].id])).rows[0].is_active, true);
        } finally {
            assignment.release();
            deactivation.release();
        }
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

    test('syncTriageCancellationStatus marks only linked Assigned triage rows as Cancelled', async () => {
        await pool.query('TRUNCATE triage_status_history, triage_files, audit_log, notifications, file_step_log, files, process_steps, processes RESTART IDENTITY CASCADE');
        await pool.query("INSERT INTO processes(name) VALUES ('Cancellable')");
        const step = await pool.query("INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES ('Cancellable','Evaluation',1,1,1) RETURNING id");
        const officer = await pool.query("SELECT id FROM users WHERE role='officer' LIMIT 1");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-CANCEL','Cancel','Cancellable',$1,$2,'Cancelled') RETURNING id", [officer.rows[0].id, step.rows[0].id]);
        const assigned = await pool.query("INSERT INTO triage_files(pr_number,title,business_owner,status,file_id) VALUES ('PR-CANCEL','Cancel','Owner','Assigned',$1) RETURNING id", [file.rows[0].id]);
        await pool.query("INSERT INTO triage_files(pr_number,title,business_owner,status,file_id) VALUES ('PR-CANCEL-AWARDED','Awarded stays awarded','Owner','Awarded',$1)", [file.rows[0].id]);

        const ignoredIds = await syncTriageCancellationStatus(pool, {
            fileId: file.rows[0].id,
            fileStatus: 'Active',
            userId: 99
        });
        assert.deepEqual(ignoredIds, []);
        assert.equal((await pool.query('SELECT status FROM triage_files WHERE id=$1', [assigned.rows[0].id])).rows[0].status, 'Assigned');

        const updatedIds = await syncTriageCancellationStatus(pool, {
            fileId: file.rows[0].id,
            fileStatus: 'Cancelled',
            userId: 99,
            ipAddress: '127.0.0.1',
            note: 'File cancelled: procurement withdrawn'
        });

        assert.deepEqual(updatedIds, [assigned.rows[0].id]);
        assert.deepEqual((await pool.query('SELECT pr_number,status FROM triage_files ORDER BY pr_number')).rows, [
            { pr_number: 'PR-CANCEL', status: 'Cancelled' },
            { pr_number: 'PR-CANCEL-AWARDED', status: 'Awarded' }
        ]);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM triage_status_history WHERE triage_file_id=$1 AND from_status='Assigned' AND to_status='Cancelled'", [assigned.rows[0].id])).rows[0].count, 1);
        const audit = await pool.query("SELECT old_value,new_value FROM audit_log WHERE entity_id=$1 AND action='triage.status_change'", [assigned.rows[0].id]);
        assert.equal(audit.rowCount, 1);
        assert.equal(audit.rows[0].old_value.status, 'Assigned');
        assert.equal(audit.rows[0].new_value.status, 'Cancelled');
        assert.equal(audit.rows[0].new_value.source, 'file_cancellation');
    });

    test('reconcileAssignedTriageCancellations repairs historical rows idempotently', async () => {
        await pool.query('TRUNCATE triage_status_history, triage_files, audit_log, notifications, file_step_log, files, process_steps, processes RESTART IDENTITY CASCADE');
        await pool.query("INSERT INTO processes(name) VALUES ('Cancellation Reconciliation')");
        const step = await pool.query("INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES ('Cancellation Reconciliation','Evaluation',1,1,1) RETURNING id");
        const officer = await pool.query("SELECT id FROM users WHERE role='officer' LIMIT 1");
        const cancelledFile = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-CR1','Cancelled','Cancellation Reconciliation',$1,$2,'Cancelled') RETURNING id", [officer.rows[0].id, step.rows[0].id]);
        const activeFile = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-CR2','Active','Cancellation Reconciliation',$1,$2,'Active') RETURNING id", [officer.rows[0].id, step.rows[0].id]);
        await pool.query("INSERT INTO triage_files(pr_number,title,business_owner,status,file_id) VALUES ('PR-CR1','Cancelled','Owner','Assigned',$1), ('PR-CR2','Active','Owner','Assigned',$2)", [cancelledFile.rows[0].id, activeFile.rows[0].id]);

        const first = await reconcileAssignedTriageCancellations(pool, { note: 'Cancellation reconciliation regression' });
        const second = await reconcileAssignedTriageCancellations(pool, { note: 'Cancellation reconciliation regression' });

        assert.equal(first.length, 1);
        assert.equal(second.length, 0);
        assert.deepEqual((await pool.query('SELECT pr_number,status FROM triage_files ORDER BY pr_number')).rows, [
            { pr_number: 'PR-CR1', status: 'Cancelled' },
            { pr_number: 'PR-CR2', status: 'Assigned' }
        ]);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM triage_status_history WHERE to_status='Cancelled'")).rows[0].count, 1);
        assert.equal((await pool.query("SELECT COUNT(*)::int AS count FROM audit_log WHERE action='triage.status_change'")).rows[0].count, 1);
    });

    test('cancelled files cannot be advanced sequentially', async () => {
        await pool.query('TRUNCATE triage_status_history, triage_files, audit_log, notifications, file_step_log, files, process_steps, processes RESTART IDENTITY CASCADE');
        await pool.query("INSERT INTO processes(name) VALUES ('Lifecycle')");
        const step = await pool.query("INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES ('Lifecycle','Evaluation',1,1,1) RETURNING id");
        const officer = await pool.query("SELECT id FROM users WHERE role='officer' LIMIT 1");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-LIFECYCLE-1','Cancelled lifecycle','Lifecycle',$1,$2,'Cancelled') RETURNING id", [officer.rows[0].id, step.rows[0].id]);

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await assert.rejects(
                () => lockActiveFileForAdvancement(client, file.rows[0].id),
                /only active files can be advanced/i
            );
            await client.query('ROLLBACK');
        } finally {
            client.release();
        }
        assert.equal((await pool.query('SELECT status FROM files WHERE id=$1', [file.rows[0].id])).rows[0].status, 'Cancelled');
    });

    test('cancellation winning a row-lock race prevents file resurrection', async () => {
        await pool.query('TRUNCATE triage_status_history, triage_files, audit_log, notifications, file_step_log, files, process_steps, processes RESTART IDENTITY CASCADE');
        await pool.query("INSERT INTO processes(name) VALUES ('Lifecycle')");
        const steps = await pool.query("INSERT INTO process_steps(process_name,step_name,sla_days,cum_days,step_order) VALUES ('Lifecycle','Evaluation',1,1,1),('Lifecycle','Contract Award',1,2,2) RETURNING id,step_order");
        const officer = await pool.query("SELECT id FROM users WHERE role='officer' LIMIT 1");
        const file = await pool.query("INSERT INTO files(pr_number,title,process_name,officer_id,current_step_id,status) VALUES ('PR-LIFECYCLE-2','Race lifecycle','Lifecycle',$1,$2,'Active') RETURNING id", [officer.rows[0].id, steps.rows.find(row => row.step_order === 1).id]);

        const cancelling = await pool.connect();
        const advancing = await pool.connect();
        try {
            await cancelling.query('BEGIN');
            await cancelling.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [file.rows[0].id]);
            await cancelling.query("UPDATE files SET status='Cancelled' WHERE id=$1", [file.rows[0].id]);

            await advancing.query('BEGIN');
            const blockedAdvance = lockActiveFileForAdvancement(advancing, file.rows[0].id);
            await new Promise(resolve => setTimeout(resolve, 50));
            await cancelling.query('COMMIT');

            await assert.rejects(blockedAdvance, /only active files can be advanced/i);
            await advancing.query('ROLLBACK');
        } finally {
            cancelling.release();
            advancing.release();
        }

        assert.equal((await pool.query('SELECT status FROM files WHERE id=$1', [file.rows[0].id])).rows[0].status, 'Cancelled');
    });

    test('progress updates are conditional on an active file', async () => {
        const file = await pool.query("SELECT id FROM files WHERE pr_number='PR-LIFECYCLE-2'");
        await assert.rejects(() => updateActiveFileProgress(pool, {
            fileId: file.rows[0].id,
            currentStepId: 1,
            startedAt: new Date(),
            status: 'Active',
            completedAt: null
        }), /file is no longer active/i);
    });
}
