const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { sendAssignmentEmail } = require('../services/emailService');

// GET /api/files — list files with role-based scoping
// Team Leader: all files (can assign cross-team)
// Officer: only files assigned to them
router.get('/', async (req, res) => {
    try {
        let query = `
      SELECT f.*, u.display_name AS officer_name, u.email AS officer_email, u.team_id AS officer_team_id,
             t.name AS officer_team_name,
             ps.step_name AS current_step_name, ps.sla_days, ps.cum_days, ps.step_order,
             (SELECT COUNT(*) FROM process_steps WHERE process_name = f.process_name) AS total_steps
      FROM files f
      JOIN users u ON u.id = f.officer_id
      LEFT JOIN teams t ON t.id = u.team_id
      LEFT JOIN process_steps ps ON ps.id = f.current_step_id
    `;
        const params = [];
        const conditions = [];

        // free-text search across PR number + title
        if (req.query.search) {
            params.push(`%${req.query.search}%`);
            conditions.push(`(f.pr_number ILIKE $${params.length} OR f.title ILIKE $${params.length})`);
        }

        // Role-based scoping
        if (req.user.role === 'officer') {
            // Officers see only their own files
            params.push(req.user.id);
            conditions.push(`f.officer_id = $${params.length}`);
        } else if (req.user.role === 'team_leader' && req.query.team_id === 'me') {
            // Team Leaders see their team unless looking at all teams
            params.push(req.user.teamId);
            conditions.push(`u.team_id = $${params.length}`);
        }

        if (req.query.officer_id) {
            params.push(req.query.officer_id);
            conditions.push(`f.officer_id = $${params.length}`);
        }
        if (req.query.status) {
            params.push(req.query.status);
            conditions.push(`f.status = $${params.length}`);
        }
        if (req.query.process_name) {
            params.push(req.query.process_name);
            conditions.push(`f.process_name = $${params.length}`);
        }

        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY f.created_at DESC';

        const result = await pool.query(query, params);

        const files = result.rows.map(f => {
            let is_overdue = false;
            let step_due_date = null;
            if (f.status === 'Active' && f.step_started_at) {
                const deadline = new Date(f.step_started_at);
                deadline.setDate(deadline.getDate() + (f.sla_days || 0));
                step_due_date = deadline.toISOString();

                const now = new Date();
                is_overdue = f.sla_days > 0 && now > deadline;
            }
            return { ...f, is_overdue, step_due_date };
        });

        res.json(files);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/files/stats/summary — dashboard stats (role-scoped)
router.get('/stats/summary', async (req, res) => {
    try {
        // Build WHERE clause and JOIN based on role
        let scopeWhere = '';
        let scopeJoin = '';
        let scopeParams = [];

        if (req.user.role === 'officer') {
            scopeWhere = 'WHERE f.officer_id = $1';
            scopeParams = [req.user.id];
        } else if (req.user.role === 'team_leader' && req.query.team_id === 'me') {
            scopeJoin = 'JOIN users u ON u.id = f.officer_id';
            scopeWhere = 'WHERE u.team_id = $1';
            scopeParams = [req.user.teamId];
        }


        // Main counts
        const stats = await pool.query(`
      SELECT
        COUNT(*) AS total_files,
        COUNT(*) FILTER (WHERE f.status = 'Active') AS active_files,
        COUNT(*) FILTER (WHERE f.status = 'Completed') AS completed_files,
        COUNT(*) FILTER (WHERE f.status = 'Cancelled') AS cancelled_files
      FROM files f
      ${scopeJoin}
      ${scopeWhere}
    `, scopeParams);

        // Overdue count
        const overdue = await pool.query(`
      SELECT COUNT(*) AS overdue_count
      FROM files f
      JOIN process_steps ps ON ps.id = f.current_step_id
      ${scopeJoin}
      ${scopeWhere ? scopeWhere + " AND f.status = 'Active'" : "WHERE f.status = 'Active'"}
        AND (
          CASE 
            WHEN EXTRACT(DOW FROM (f.step_started_at + (ps.sla_days || ' days')::interval)) = 6 -- Saturday
              THEN f.step_started_at + (ps.sla_days + 2 || ' days')::interval
            WHEN EXTRACT(DOW FROM (f.step_started_at + (ps.sla_days || ' days')::interval)) = 0 -- Sunday
              THEN f.step_started_at + (ps.sla_days + 1 || ' days')::interval
            ELSE f.step_started_at + (ps.sla_days || ' days')::interval
          END
        ) < NOW()
    `, scopeParams);

        // By officer (for team leaders)
        let byOfficer = { rows: [] };
        if (req.user.role === 'team_leader') {
            let byOfficerWhere = "WHERE u.role = 'officer' AND u.is_active = TRUE";
            const boParams = [];
            if (req.query.team_id === 'me') {
                boParams.push(req.user.teamId);
                byOfficerWhere += ` AND u.team_id = $${boParams.length}`;
            }
            byOfficer = await pool.query(`
          SELECT u.id, u.display_name AS officer_name, u.team_id,
                 COUNT(f.id) AS file_count,
                 COUNT(f.id) FILTER (WHERE f.status = 'Active') AS active_count
          FROM users u
          LEFT JOIN files f ON f.officer_id = u.id
          ${byOfficerWhere}
          GROUP BY u.id, u.display_name, u.team_id
          ORDER BY file_count DESC
        `, boParams);
        }

        // By process
        const byProcess = await pool.query(`
      SELECT f.process_name, COUNT(*) AS file_count,
             COUNT(*) FILTER (WHERE f.status = 'Active') AS active_count
      FROM files f
      ${scopeJoin}
      ${scopeWhere}
      GROUP BY f.process_name
      ORDER BY file_count DESC
    `, scopeParams);

        // Upcoming SLA deadlines
        const upcoming = await pool.query(`
      SELECT f.id, f.pr_number, f.title, f.step_started_at, f.process_name,
             ps.step_name, ps.sla_days,
             uo.display_name AS officer_name
      FROM files f
      JOIN process_steps ps ON ps.id = f.current_step_id
      JOIN users uo ON uo.id = f.officer_id
      ${scopeWhere ? scopeWhere.replace('u.team_id', 'uo.team_id') + " AND f.status = 'Active'" : "WHERE f.status = 'Active'"}
        AND ps.sla_days > 0
      ORDER BY (
        CASE 
          WHEN EXTRACT(DOW FROM (f.step_started_at + (ps.sla_days || ' days')::interval)) = 6 -- Saturday
            THEN f.step_started_at + (ps.sla_days + 2 || ' days')::interval
          WHEN EXTRACT(DOW FROM (f.step_started_at + (ps.sla_days || ' days')::interval)) = 0 -- Sunday
            THEN f.step_started_at + (ps.sla_days + 1 || ' days')::interval
          ELSE f.step_started_at + (ps.sla_days || ' days')::interval
        END
      ) ASC
      LIMIT 10
    `, scopeParams);

        res.json({
            ...stats.rows[0],
            overdue_files: overdue.rows[0].overdue_count,
            by_officer: byOfficer.rows,
            by_process: byProcess.rows,
            upcoming_deadlines: upcoming.rows
        });
    } catch (err) {
        console.error('Stats summary error:', err);
        res.status(500).json({ error: err.message });
    }
});

// GET /api/files/:id — file detail with step history
router.get('/:id', async (req, res) => {
    try {
        const fileResult = await pool.query(`
      SELECT f.*, u.display_name AS officer_name, u.email AS officer_email,
             ps.step_name AS current_step_name, ps.sla_days, ps.cum_days, ps.step_order
      FROM files f
      JOIN users u ON u.id = f.officer_id
      LEFT JOIN process_steps ps ON ps.id = f.current_step_id
      WHERE f.id = $1
    `, [req.params.id]);

        if (fileResult.rows.length === 0) return res.status(404).json({ error: 'File not found' });

        const file = fileResult.rows[0];

        // Officers can only view their own files
        if (req.user.role === 'officer' && file.officer_id !== req.user.id) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Get all steps for this process
        const stepsResult = await pool.query(
            'SELECT * FROM process_steps WHERE process_name = $1 ORDER BY step_order',
            [file.process_name]
        );

        // Get step log
        const logResult = await pool.query(
            'SELECT * FROM file_step_log WHERE file_id = $1 ORDER BY started_at',
            [req.params.id]
        );

        // Calculate overdue
        if (file.status === 'Active' && file.sla_days > 0 && file.step_started_at) {
            const deadline = new Date(file.step_started_at);
            deadline.setDate(deadline.getDate() + file.sla_days);
            file.is_overdue = new Date() > deadline;
        } else {
            file.is_overdue = false;
        }

        res.json({
            ...file,
            steps: stepsResult.rows,
            step_log: logResult.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/files — create new file (team leaders only, supports backdating)
router.post('/', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can create files' });
    }

    const { pr_number, title, process_name, officer_id, assigned_date, current_step_order, estimated_value } = req.body;
    if (!pr_number || !title || !process_name || !officer_id) {
        return res.status(400).json({ error: 'pr_number, title, process_name, and officer_id are required' });
    }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const stepsResult = await client.query(
            'SELECT * FROM process_steps WHERE process_name = $1 ORDER BY step_order',
            [process_name]
        );
        if (stepsResult.rows.length === 0) throw new Error('Invalid process');

        const allSteps = stepsResult.rows;
        const startDate = assigned_date
            ? new Date(assigned_date.includes('T') ? assigned_date : `${assigned_date}T12:00:00`)
            : new Date();
        const targetOrder = current_step_order ? parseInt(current_step_order) : 1;
        const targetStep = allSteps.find(s => s.step_order === targetOrder) || allSteps[0];

        const stepStartedAt = targetOrder <= 1 ? startDate : new Date();

        const fileResult = await client.query(
            `INSERT INTO files (pr_number, title, process_name, officer_id, current_step_id, step_started_at, created_at, estimated_value)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [pr_number, title, process_name, officer_id, targetStep.id, stepStartedAt, startDate, estimated_value || null]
        );
        const file = fileResult.rows[0];

        // Auto-log completed steps for backdated files
        if (targetOrder > 1) {
            let runningDate = new Date(startDate);
            for (const step of allSteps) {
                if (step.step_order < targetOrder) {
                    const stepStart = new Date(runningDate);
                    const stepEnd = new Date(runningDate);
                    stepEnd.setDate(stepEnd.getDate() + (step.sla_days || 1));
                    runningDate = new Date(stepEnd);

                    await client.query(
                        'INSERT INTO file_step_log (file_id, step_id, started_at, completed_at, sla_met) VALUES ($1, $2, $3, $4, TRUE)',
                        [file.id, step.id, stepStart, stepEnd]
                    );
                } else if (step.step_order === targetOrder) {
                    await client.query(
                        'INSERT INTO file_step_log (file_id, step_id, started_at) VALUES ($1, $2, $3)',
                        [file.id, step.id, stepStartedAt]
                    );
                    break;
                }
            }
        } else {
            await client.query(
                'INSERT INTO file_step_log (file_id, step_id, started_at) VALUES ($1, $2, $3)',
                [file.id, allSteps[0].id, startDate]
            );
        }

        await client.query('COMMIT');

        const fullFile = await pool.query(`
      SELECT f.*, u.display_name AS officer_name, ps.step_name AS current_step_name
      FROM files f
      JOIN users u ON u.id = f.officer_id
      LEFT JOIN process_steps ps ON ps.id = f.current_step_id
      WHERE f.id = $1
    `, [file.id]);

        const createdFile = fullFile.rows[0];
        res.status(201).json(createdFile);

        // Send assignment email (non-blocking)
        try {
            const officerRow = await pool.query('SELECT email, display_name FROM users WHERE id = $1', [officer_id]);
            if (officerRow.rows.length > 0) {
                const officer = officerRow.rows[0];
                sendAssignmentEmail(officer.email, officer.display_name, pr_number, title, process_name);
            }
        } catch (emailErr) {
            console.error('[Email] Assignment email error:', emailErr.message);
        }
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') return res.status(409).json({ error: 'PR Number already exists' });
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// PUT /api/files/:id/steps/:logId/comment — add/update comment (team leaders only)
router.put('/:id/steps/:logId/comment', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can add comments' });
    }

    const { comment } = req.body;
    if (comment === undefined) return res.status(400).json({ error: 'comment is required' });
    try {
        const result = await pool.query(
            'UPDATE file_step_log SET comment = $1 WHERE id = $2 AND file_id = $3 RETURNING *',
            [comment, req.params.logId, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Step log not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/files/:id/advance — advance to next step (team leaders only)
router.put('/:id/advance', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can advance files' });
    }

    const { comment } = req.body || {};
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const fileResult = await client.query(
            'SELECT f.*, ps.step_order, ps.process_name FROM files f JOIN process_steps ps ON ps.id = f.current_step_id WHERE f.id = $1',
            [req.params.id]
        );
        if (fileResult.rows.length === 0) throw new Error('File not found');

        const file = fileResult.rows[0];
        if (file.status === 'Completed') throw new Error('File is already completed');

        const nextStep = await client.query(
            'SELECT * FROM process_steps WHERE process_name = $1 AND step_order = $2',
            [file.process_name, file.step_order + 1]
        );

        if (nextStep.rows.length === 0) throw new Error('No more steps');

        const next = nextStep.rows[0];
        const now = new Date();

        await client.query(
            `UPDATE file_step_log SET completed_at = $1,
       sla_met = (EXTRACT(EPOCH FROM ($1 - started_at)) / 86400) <= (SELECT sla_days FROM process_steps WHERE id = file_step_log.step_id),
       comment = COALESCE($4, comment)
       WHERE file_id = $2 AND step_id = $3 AND completed_at IS NULL`,
            [now, req.params.id, file.current_step_id, comment || null]
        );

        const isCompleted = next.step_name === 'Completed';

        await client.query(
            `UPDATE files SET current_step_id = $1, step_started_at = $2,
       status = $3, completed_at = $4 WHERE id = $5`,
            [next.id, now, isCompleted ? 'Completed' : 'Active', isCompleted ? now : null, req.params.id]
        );

        await client.query(
            'INSERT INTO file_step_log (file_id, step_id, started_at, completed_at) VALUES ($1, $2, $3, $4)',
            [req.params.id, next.id, now, isCompleted ? now : null]
        );

        await client.query('COMMIT');

        const updatedFile = await pool.query(`
      SELECT f.*, u.display_name AS officer_name, ps.step_name AS current_step_name, ps.sla_days, ps.step_order,
             (SELECT COUNT(*) FROM process_steps WHERE process_name = f.process_name) AS total_steps
      FROM files f
      JOIN users u ON u.id = f.officer_id
      LEFT JOIN process_steps ps ON ps.id = f.current_step_id
      WHERE f.id = $1
    `, [req.params.id]);

        res.json(updatedFile.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// PUT /api/files/:id/cancel — cancel a file (team leaders only)
router.put('/:id/cancel', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can cancel files' });
    }

    const { reason } = req.body;
    if (!reason) return res.status(400).json({ error: 'Cancellation reason is required' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const fileResult = await client.query(
            'SELECT * FROM files WHERE id = $1',
            [req.params.id]
        );
        if (fileResult.rows.length === 0) throw new Error('File not found');

        const file = fileResult.rows[0];
        if (file.status !== 'Active') throw new Error('Only active files can be cancelled');

        const now = new Date();

        // Mark current step as complete/cancelled with the reason
        await client.query(
            `UPDATE file_step_log SET completed_at = $1, comment = $2, sla_met = FALSE 
             WHERE file_id = $3 AND step_id = $4 AND completed_at IS NULL`,
            [now, `CANCELLED: ${reason}`, req.params.id, file.current_step_id]
        );

        // Update file status and store cancellation reason in dedicated column
        await client.query(
            'UPDATE files SET status = $1, completed_at = $2, cancellation_reason = $3 WHERE id = $4',
            ['Cancelled', now, reason, req.params.id]
        );

        await client.query('COMMIT');
        
        const updatedFile = await pool.query(
            'SELECT * FROM files WHERE id = $1',
            [req.params.id]
        );

        res.json(updatedFile.rows[0]);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// POST /api/files/:id/notes — save notes on a file (team leader + officer)
router.post('/:id/notes', async (req, res) => {
    const { notes } = req.body;
    if (notes === undefined) return res.status(400).json({ error: 'notes field is required' });

    try {
        // Officers can only update their own file's notes
        if (req.user.role === 'officer') {
            const check = await pool.query('SELECT officer_id FROM files WHERE id = $1', [req.params.id]);
            if (check.rows.length === 0) return res.status(404).json({ error: 'File not found' });
            if (check.rows[0].officer_id !== req.user.id) return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query(
            'UPDATE files SET notes = $1 WHERE id = $2 RETURNING id, notes',
            [notes, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/files/export — export files as Excel (team leaders only)
router.get('/export', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can export files' });
    }

    const XLSX = require('xlsx');
    try {
        let query = `
      SELECT f.pr_number, f.title, f.process_name, f.status,
             f.estimated_value, f.cancellation_reason, f.notes,
             u.display_name AS officer_name,
             ps.step_name AS current_step_name,
             f.created_at, f.completed_at
      FROM files f
      JOIN users u ON u.id = f.officer_id
      LEFT JOIN process_steps ps ON ps.id = f.current_step_id
    `;
        const params = [];
        const conditions = [];

        if (req.query.team_id === 'me' && req.user.teamId) {
            params.push(req.user.teamId);
            conditions.push(`u.team_id = $${params.length}`);
        }
        if (req.query.officer_id) { params.push(req.query.officer_id); conditions.push(`f.officer_id = $${params.length}`); }
        if (req.query.status) { params.push(req.query.status); conditions.push(`f.status = $${params.length}`); }
        if (req.query.process_name) { params.push(req.query.process_name); conditions.push(`f.process_name = $${params.length}`); }
        if (req.query.search) { params.push(`%${req.query.search}%`); conditions.push(`(f.pr_number ILIKE $${params.length} OR f.title ILIKE $${params.length})`); }

        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY f.created_at DESC';

        const result = await pool.query(query, params);

        const rows = result.rows.map(f => ({
            'PR Number':            f.pr_number,
            'Title':                f.title,
            'Process':              f.process_name.replace(/_/g, ' '),
            'Officer':              f.officer_name,
            'Current Step':         f.current_step_name || '',
            'Status':               f.status,
            'Estimated Value':      f.estimated_value != null ? parseFloat(f.estimated_value) : '',
            'Cancellation Reason':  f.cancellation_reason || '',
            'Notes':                f.notes || '',
            'Date Assigned':        f.created_at ? new Date(f.created_at).toISOString().split('T')[0] : '',
            'Date Completed':       f.completed_at ? new Date(f.completed_at).toISOString().split('T')[0] : '',
        }));

        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(rows);
        XLSX.utils.book_append_sheet(wb, ws, 'Files');
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', `attachment; filename="procurement_files_${new Date().toISOString().split('T')[0]}.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/files/import — bulk import files from Excel (team leaders only)
const multer = require('multer');
const XLSX = require('xlsx');
const uploadFiles = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

router.post('/import', uploadFiles.single('file'), async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can import files' });
    }
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Parse workbook
    let rows;
    try {
        const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
    } catch (e) {
        return res.status(400).json({ error: 'Could not parse Excel file: ' + e.message });
    }

    if (!rows || rows.length === 0) {
        return res.status(400).json({ error: 'Excel sheet is empty' });
    }

    // Normalise a column key
    const norm = str => String(str || '').trim().toLowerCase().replace(/\s+/g, '_');

    // Build per-row objects with normalised keys
    const parsed = rows.map((raw, i) => {
        const n = {};
        for (const [k, v] of Object.entries(raw)) n[norm(k)] = String(v || '').trim();
        return {
            rowNum: i + 2,
            pr_number:      n['pr_number'] || n['pr_no'] || n['pr'] || '',
            title:          n['title'] || n['file_title'] || n['description'] || '',
            process:        n['process'] || n['process_name'] || n['procurement_process'] || '',
            officer:        n['officer'] || n['officer_name'] || n['assigned_officer'] || '',
            assigned_date:  n['assigned_date'] || n['date_assigned'] || n['assignment_date'] || '',
            step_order:     n['current_step'] || n['step_order'] || n['starting_step'] || '',
        };
    });

    // Pre-fetch lookup caches
    const officersRes = await pool.query(
        "SELECT id, display_name FROM users WHERE role = 'officer' AND is_active = TRUE"
    );
    const officerMap = {};
    for (const o of officersRes.rows) officerMap[o.display_name.toLowerCase()] = o.id;

    const processesRes = await pool.query(
        'SELECT DISTINCT process_name FROM process_steps'
    );
    const processNames = new Set(processesRes.rows.map(p => p.process_name.toLowerCase()));

    const summary = { imported: 0, skipped: 0, total: parsed.length, details: { imported: [], skipped: [] } };

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        for (const row of parsed) {
            // Validate required fields
            if (!row.pr_number || !row.title || !row.process || !row.officer) {
                summary.skipped++;
                summary.details.skipped.push({
                    row: row.rowNum,
                    pr_number: row.pr_number || null,
                    reason: `Missing required field(s): ${[
                        !row.pr_number && 'PR Number',
                        !row.title && 'Title',
                        !row.process && 'Process',
                        !row.officer && 'Officer'
                    ].filter(Boolean).join(', ')}`
                });
                continue;
            }

            // Resolve officer
            const officerId = officerMap[row.officer.toLowerCase()];
            if (!officerId) {
                summary.skipped++;
                summary.details.skipped.push({ row: row.rowNum, pr_number: row.pr_number, reason: `Officer not found: "${row.officer}"` });
                continue;
            }

            // Validate process
            if (!processNames.has(row.process.toLowerCase())) {
                // Try a case-insensitive match
                const match = [...processNames].find(p => p === row.process.toLowerCase());
                if (!match) {
                    summary.skipped++;
                    summary.details.skipped.push({ row: row.rowNum, pr_number: row.pr_number, reason: `Process not found: "${row.process}"` });
                    continue;
                }
            }
            // Get the real cased process_name from DB
            const realProcess = processesRes.rows.find(p => p.process_name.toLowerCase() === row.process.toLowerCase()).process_name;

            // Check for duplicate PR number
            const dupCheck = await client.query('SELECT id FROM files WHERE pr_number = $1', [row.pr_number]);
            if (dupCheck.rows.length > 0) {
                summary.skipped++;
                summary.details.skipped.push({ row: row.rowNum, pr_number: row.pr_number, reason: 'Duplicate PR Number — already exists' });
                continue;
            }

            // Get process steps
            const stepsResult = await client.query(
                'SELECT * FROM process_steps WHERE process_name = $1 ORDER BY step_order',
                [realProcess]
            );
            if (stepsResult.rows.length === 0) {
                summary.skipped++;
                summary.details.skipped.push({ row: row.rowNum, pr_number: row.pr_number, reason: 'No steps defined for process' });
                continue;
            }

            const allSteps = stepsResult.rows;
            const startDate = row.assigned_date
                ? new Date(row.assigned_date.includes('T') ? row.assigned_date : `${row.assigned_date}T12:00:00`)
                : new Date();
            if (isNaN(startDate.getTime())) {
                summary.skipped++;
                summary.details.skipped.push({ row: row.rowNum, pr_number: row.pr_number, reason: `Invalid assigned date: "${row.assigned_date}"` });
                continue;
            }

            const targetOrder = row.step_order ? parseInt(row.step_order) || 1 : 1;
            const targetStep = allSteps.find(s => s.step_order === targetOrder) || allSteps[0];
            const stepStartedAt = targetOrder <= 1 ? startDate : new Date();

            // Insert file
            const fileResult = await client.query(
                `INSERT INTO files (pr_number, title, process_name, officer_id, current_step_id, step_started_at, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
                [row.pr_number, row.title, realProcess, officerId, targetStep.id, stepStartedAt, startDate]
            );
            const file = fileResult.rows[0];

            // Log steps (same logic as POST /)
            if (targetOrder > 1) {
                let runningDate = new Date(startDate);
                for (const step of allSteps) {
                    if (step.step_order < targetOrder) {
                        const s = new Date(runningDate);
                        const e = new Date(runningDate);
                        e.setDate(e.getDate() + (step.sla_days || 1));
                        runningDate = new Date(e);
                        await client.query(
                            'INSERT INTO file_step_log (file_id, step_id, started_at, completed_at, sla_met) VALUES ($1, $2, $3, $4, TRUE)',
                            [file.id, step.id, s, e]
                        );
                    } else if (step.step_order === targetOrder) {
                        await client.query(
                            'INSERT INTO file_step_log (file_id, step_id, started_at) VALUES ($1, $2, $3)',
                            [file.id, step.id, stepStartedAt]
                        );
                        break;
                    }
                }
            } else {
                await client.query(
                    'INSERT INTO file_step_log (file_id, step_id, started_at) VALUES ($1, $2, $3)',
                    [file.id, allSteps[0].id, startDate]
                );
            }

            summary.imported++;
            summary.details.imported.push({ row: row.rowNum, pr_number: row.pr_number, title: row.title });
        }

        await client.query('COMMIT');
        res.json(summary);
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// GET /api/files/:id/contracts — get all contracts for a file
router.get('/:id/contracts', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM contracts WHERE file_id = $1 ORDER BY created_at ASC',
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/files/:id/contracts — create a new contract (Team Leader only)
router.post('/:id/contracts', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can create contracts' });
    }

    const { contract_number, start_date, end_date, has_options, number_of_options, contractor_name } = req.body;
    if (!start_date || !end_date || !contract_number) {
        return res.status(400).json({ error: 'contract_number, start_date, and end_date are required' });
    }

    try {
        // Verify file is completed
        const fileRes = await pool.query('SELECT status FROM files WHERE id = $1', [req.params.id]);
        if (fileRes.rows.length === 0) return res.status(404).json({ error: 'File not found' });
        if (fileRes.rows[0].status !== 'Completed') {
            return res.status(400).json({ error: 'Contracts can only be added to completed files' });
        }

        const result = await pool.query(
            `INSERT INTO contracts (file_id, contract_number, start_date, end_date, has_options, number_of_options, contractor_name, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
            [req.params.id, contract_number, start_date, end_date, has_options || false, number_of_options || null, contractor_name || null, req.user.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/files/contracts/:contractId/amend — amend a contract's end date (Team Leader only)
router.put('/contracts/:contractId/amend', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can amend contracts' });
    }

    const { amended_end_date, exercise_option } = req.body;
    if (!amended_end_date) {
        return res.status(400).json({ error: 'amended_end_date is required' });
    }

    try {
        let query = 'UPDATE contracts SET amended_end_date = $1';
        let params = [amended_end_date];
        
        if (exercise_option) {
            query += ', number_of_options = GREATEST(0, COALESCE(number_of_options, 0) - 1)';
        }
        
        query += ' WHERE id = $2 RETURNING *';
        params.push(req.params.contractId);
        
        const result = await pool.query(query, params);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Contract not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/files/:id/basis-of-selection — save evaluation method config (team leaders only)
router.put('/:id/basis-of-selection', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can configure the basis of selection' });
    }

    const {
        basis_of_selection,
        minimum_points_threshold,
        technical_weight_percent,
        price_weight_percent,
        maximum_technical_points
    } = req.body;

    const validMethods = ['lowest_price', 'lowest_price_per_point', 'highest_combined_rating'];
    if (basis_of_selection && !validMethods.includes(basis_of_selection)) {
        return res.status(400).json({ error: `Invalid basis_of_selection. Must be one of: ${validMethods.join(', ')}` });
    }

    // Validate weights for highest_combined_rating
    if (basis_of_selection === 'highest_combined_rating') {
        if (technical_weight_percent == null || price_weight_percent == null) {
            return res.status(400).json({ error: 'technical_weight_percent and price_weight_percent are required for highest_combined_rating' });
        }
        const sum = parseFloat(technical_weight_percent) + parseFloat(price_weight_percent);
        if (Math.abs(sum - 100) > 0.01) {
            return res.status(400).json({ error: 'technical_weight_percent and price_weight_percent must sum to 100' });
        }
        if (maximum_technical_points == null || parseFloat(maximum_technical_points) <= 0) {
            return res.status(400).json({ error: 'maximum_technical_points is required and must be > 0 for highest_combined_rating' });
        }
    }

    // Validate threshold requirement for point-based methods
    if (['lowest_price_per_point', 'highest_combined_rating'].includes(basis_of_selection)) {
        if (minimum_points_threshold == null) {
            return res.status(400).json({ error: 'minimum_points_threshold is required for point-based selection methods' });
        }
    }

    try {
        const result = await pool.query(
            `UPDATE files SET
                basis_of_selection = $1,
                minimum_points_threshold = $2,
                technical_weight_percent = $3,
                price_weight_percent = $4,
                maximum_technical_points = $5
             WHERE id = $6
             RETURNING id, basis_of_selection, minimum_points_threshold,
                       technical_weight_percent, price_weight_percent, maximum_technical_points`,
            [
                basis_of_selection || null,
                minimum_points_threshold != null ? parseFloat(minimum_points_threshold) : null,
                technical_weight_percent != null ? parseFloat(technical_weight_percent) : null,
                price_weight_percent != null ? parseFloat(price_weight_percent) : null,
                maximum_technical_points != null ? parseFloat(maximum_technical_points) : null,
                req.params.id
            ]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'File not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

