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

    const { pr_number, title, process_name, officer_id, assigned_date, current_step_order } = req.body;
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
            `INSERT INTO files (pr_number, title, process_name, officer_id, current_step_id, step_started_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
            [pr_number, title, process_name, officer_id, targetStep.id, stepStartedAt, startDate]
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

        // Update file status
        await client.query(
            'UPDATE files SET status = $1, completed_at = $2 WHERE id = $3',
            ['Cancelled', now, req.params.id]
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

module.exports = router;
