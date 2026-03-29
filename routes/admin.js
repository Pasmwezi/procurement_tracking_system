const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const pool = require('../db/pool');
const { body, param, query } = require('express-validator');
const { validateRequest } = require('../middleware/validate');

// GET /api/admin/users — list all users with team info
router.get('/users', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT u.id, u.email, u.display_name, u.role, u.team_id, u.is_active,
                   u.password_changed, u.created_at,
                   t.name AS team_name,
                   (SELECT COUNT(*) FROM files f WHERE f.officer_id = u.id) AS file_count,
                   (SELECT COUNT(*) FROM files f WHERE f.officer_id = u.id AND f.status = 'Active') AS active_count
            FROM users u
            LEFT JOIN teams t ON t.id = u.team_id
            ORDER BY u.role, u.display_name
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/users — create a user
router.post('/users', [
    body('email').isEmail().withMessage('Valid email required'),
    body('display_name').notEmpty().withMessage('Display name required'),
    body('role').isIn(['team_leader', 'officer', 'admin']).withMessage('Role must be team_leader, officer, or admin'),
    body('team_id').optional({ nullable: true }).isInt().withMessage('Team ID must be integer'),
    body('password').optional().isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    validateRequest
], async (req, res) => {
    const { email, display_name, role, team_id, password } = req.body;

    try {
        let passwordHash = null;
        if (password) {
            passwordHash = await bcrypt.hash(password, 10);
        }

        const result = await pool.query(
            `INSERT INTO users (email, password_hash, display_name, role, team_id)
             VALUES ($1, $2, $3, $4, $5) RETURNING id, email, display_name, role, team_id, is_active, created_at`,
            [email.toLowerCase().trim(), passwordHash, display_name, role, team_id || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/admin/users/:id — update user profile
router.put('/users/:id', [
    param('id').isInt().withMessage('User ID must be an integer'),
    body('email').optional().isEmail().withMessage('Valid email required'),
    body('display_name').optional().notEmpty().withMessage('Display name cannot be empty'),
    body('role').optional().isIn(['team_leader', 'officer', 'admin']).withMessage('Invalid role'),
    body('team_id').optional({ nullable: true }).isInt().withMessage('Team ID must be integer'),
    body('is_active').optional().isBoolean().withMessage('is_active must be boolean'),
    validateRequest
], async (req, res) => {
    const { email, display_name, role, team_id, is_active } = req.body;
    const userId = parseInt(req.params.id);

    // Prevent editing own admin account's role
    if (userId === req.user.id && role && role !== 'admin') {
        return res.status(400).json({ error: 'Cannot change your own role' });
    }

    try {
        const fields = [];
        const values = [];
        let idx = 1;

        if (email !== undefined) { fields.push(`email = $${idx++}`); values.push(email.toLowerCase().trim()); }
        if (display_name !== undefined) { fields.push(`display_name = $${idx++}`); values.push(display_name); }
        if (role !== undefined) { fields.push(`role = $${idx++}`); values.push(role); }
        if (team_id !== undefined) { fields.push(`team_id = $${idx++}`); values.push(team_id || null); }
        if (is_active !== undefined) { fields.push(`is_active = $${idx++}`); values.push(is_active); }
        fields.push(`updated_at = NOW()`);

        if (fields.length <= 1) return res.status(400).json({ error: 'No fields to update' });

        values.push(userId);
        const result = await pool.query(
            `UPDATE users SET ${fields.join(', ')} WHERE id = $${idx} RETURNING id, email, display_name, role, team_id, is_active`,
            values
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/admin/users/:id/reset-password — set a new password for a user
router.put('/users/:id/reset-password', [
    param('id').isInt().withMessage('User ID must be an integer'),
    body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
    validateRequest
], async (req, res) => {
    const { password } = req.body;

    try {
        const hash = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'UPDATE users SET password_hash = $1, password_changed = FALSE, updated_at = NOW() WHERE id = $2 RETURNING id',
            [hash, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/users/:id — deactivate user (soft delete)
router.delete('/users/:id', [
    param('id').isInt().withMessage('User ID must be an integer'),
    validateRequest
], async (req, res) => {
    const userId = parseInt(req.params.id);
    if (userId === req.user.id) {
        return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    try {
        // Check for active files
        const filesCheck = await pool.query(
            "SELECT COUNT(*) FROM files WHERE officer_id = $1 AND status = 'Active'",
            [userId]
        );
        if (parseInt(filesCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot deactivate user with active files. Transfer files first.' });
        }

        const result = await pool.query(
            'UPDATE users SET is_active = FALSE, updated_at = NOW() WHERE id = $1 RETURNING id',
            [userId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- TEAM ROUTES ---

// GET /api/admin/teams — list all teams with member counts
router.get('/teams', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT t.*,
                (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.is_active = TRUE) AS member_count,
                (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.role = 'team_leader' AND u.is_active = TRUE) AS leader_count,
                (SELECT COUNT(*) FROM users u WHERE u.team_id = t.id AND u.role = 'officer' AND u.is_active = TRUE) AS officer_count
            FROM teams t
            ORDER BY t.name
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/teams — create team
router.post('/teams', [
    body('name').trim().notEmpty().withMessage('Team name is required'),
    validateRequest
], async (req, res) => {
    const { name } = req.body;

    try {
        const result = await pool.query(
            'INSERT INTO teams (name) VALUES ($1) RETURNING *',
            [name.trim()]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Team name already exists' });
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/admin/teams/:id — rename team
router.put('/teams/:id', [
    param('id').isInt().withMessage('Team ID must be an integer'),
    body('name').trim().notEmpty().withMessage('Team name is required'),
    validateRequest
], async (req, res) => {
    const { name } = req.body;

    try {
        const result = await pool.query(
            'UPDATE teams SET name = $1 WHERE id = $2 RETURNING *',
            [name.trim(), req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Team name already exists' });
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/teams/:id — delete team (only if no members)
router.delete('/teams/:id', [
    param('id').isInt().withMessage('Team ID must be an integer'),
    validateRequest
], async (req, res) => {
    try {
        const membersCheck = await pool.query(
            'SELECT COUNT(*) FROM users WHERE team_id = $1 AND is_active = TRUE',
            [req.params.id]
        );
        if (parseInt(membersCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete team with active members. Reassign members first.' });
        }

        const result = await pool.query('DELETE FROM teams WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Team not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- PROCESS ROUTES ---

// GET /api/admin/processes — list all processes with step count and total SLA
router.get('/processes', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT p.name,
                   COUNT(ps.id) AS step_count,
                   COALESCE(SUM(ps.sla_days), 0) AS total_sla_days
            FROM processes p
            LEFT JOIN process_steps ps ON p.name = ps.process_name
            GROUP BY p.name
            ORDER BY p.name
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/processes — create a new process
router.post('/processes', [
    body('name').trim().notEmpty().withMessage('Process name is required'),
    validateRequest
], async (req, res) => {
    const { name } = req.body;

    try {
        const result = await pool.query(
            'INSERT INTO processes (name) VALUES ($1) RETURNING *',
            [name.trim()]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Process name already exists' });
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/admin/processes/:name — delete a process (only if not used by files)
router.delete('/processes/:name', [
    param('name').trim().notEmpty().withMessage('Process name is required'),
    validateRequest
], async (req, res) => {
    try {
        const filesCheck = await pool.query(
            'SELECT COUNT(*) FROM files WHERE process_name = $1',
            [req.params.name]
        );
        if (parseInt(filesCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete process that has existing files.' });
        }

        const result = await pool.query('DELETE FROM processes WHERE name = $1 RETURNING name', [req.params.name]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Process not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/admin/processes/:name/steps — get process steps
router.get('/processes/:name/steps', [
    param('name').trim().notEmpty().withMessage('Process name is required'),
    validateRequest
], async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM process_steps WHERE process_name = $1 ORDER BY step_order',
            [req.params.name]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/admin/processes/:name/steps — bulk update steps
router.put('/processes/:name/steps', [
    param('name').trim().notEmpty().withMessage('Process name is required'),
    body('steps').isArray().withMessage('Steps must be an array'),
    validateRequest
], async (req, res) => {
    const processName = req.params.name;
    const { steps } = req.body; // array of { id, step_name, sla_days, step_order }

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        // Verify process exists
        const procCheck = await client.query('SELECT name FROM processes WHERE name = $1', [processName]);
        if (procCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Process not found' });
        }

        // Get existing steps to see which ones are being deleted
        const existingSteps = await client.query('SELECT id FROM process_steps WHERE process_name = $1', [processName]);
        const existingIds = existingSteps.rows.map(r => r.id);
        const incomingIds = steps.filter(s => s.id).map(s => parseInt(s.id));
        const idsToDelete = existingIds.filter(id => !incomingIds.includes(id));

        // Delete omitted steps
        if (idsToDelete.length > 0) {
            try {
                await client.query('DELETE FROM process_steps WHERE id = ANY($1)', [idsToDelete]);
            } catch (delErr) {
                // 23503 is foreign_key_violation
                if (delErr.code === '23503') {
                    await client.query('ROLLBACK');
                    return res.status(400).json({ error: 'Cannot delete steps that are referencing active or tracked files. Disable them or add new steps instead.' });
                }
                throw delErr;
            }
        }

        // Processing array sequentially to build cum_days
        let cumDays = 0;
        for (let i = 0; i < steps.length; i++) {
            const step = steps[i];
            const slaDays = parseInt(step.sla_days) || 0;
            cumDays += slaDays;

            // Assume step_order is implicit by array index if not provided
            const seqOrder = i + 1;

            if (step.id) {
                // Update
                await client.query(
                    'UPDATE process_steps SET step_name = $1, sla_days = $2, cum_days = $3, step_order = $4 WHERE id = $5 AND process_name = $6',
                    [step.step_name.trim(), slaDays, cumDays, seqOrder, parseInt(step.id), processName]
                );
            } else {
                // Insert
                await client.query(
                    'INSERT INTO process_steps (process_name, step_name, sla_days, cum_days, step_order) VALUES ($1, $2, $3, $4, $5)',
                    [processName, step.step_name.trim(), slaDays, cumDays, seqOrder]
                );
            }
        }

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// --- EMAIL SETTINGS ROUTES ---
const { getSmtpSettings, saveSmtpSettings, sendTestEmail, SMTP_KEYS } = require('../services/emailService');

// GET /api/admin/email-settings — return current SMTP config (password masked)
router.get('/email-settings', async (req, res) => {
    try {
        const settings = await getSmtpSettings();
        if (!settings) return res.json({});

        // Mask password
        if (settings.smtp_password) {
            settings.smtp_password = '••••••••';
        }
        res.json(settings);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/admin/email-settings — save SMTP config
router.put('/email-settings', [
    body().isObject().withMessage('Settings must be an object'),
    validateRequest
], async (req, res) => {
    try {
        const incoming = {};
        for (const key of SMTP_KEYS) {
            if (req.body[key] !== undefined) {
                // If password is the mask placeholder, skip updating it
                if (key === 'smtp_password' && req.body[key] === '••••••••') continue;
                incoming[key] = String(req.body[key]);
            }
        }
        await saveSmtpSettings(incoming);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/admin/email-settings/test — send a test email
router.post('/email-settings/test', [
    body('to').optional().isEmail().withMessage('Valid email address required'),
    validateRequest
], async (req, res) => {
    let toAddress = req.body.to;
    if (!toAddress) {
        // Look up email from DB since JWT doesn't include it
        try {
            const userRow = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
            toAddress = userRow.rows.length > 0 ? userRow.rows[0].email : null;
        } catch (e) { /* ignore */ }
    }
    if (!toAddress) return res.status(400).json({ error: 'No email address provided' });

    try {
        await sendTestEmail(toAddress);
        res.json({ success: true, message: `Test email sent to ${toAddress}` });
    } catch (err) {
        res.status(500).json({ error: `Failed to send test email: ${err.message}` });
    }
});

// GET /api/admin/audit-logs — fetch paginated audit logs
router.get('/audit-logs', [
    query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
    query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be an integer between 1 and 100'),
    validateRequest
], async (req, res) => {
    // Extra guard (though auth middleware in server.js should ideally protect the route prefix)
    if (!req.user || req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const offset = (page - 1) * limit;

    try {
        // Total count
        const countRes = await pool.query('SELECT COUNT(*) FROM audit_log');
        const total = parseInt(countRes.rows[0].count, 10);

        // Paginated rows
        const result = await pool.query(`
            SELECT a.id, a.action, a.entity_type, a.entity_id, 
                   a.old_value, a.new_value, a.ip_address, a.created_at,
                   u.display_name AS user_name, u.email AS user_email
            FROM audit_log a
            LEFT JOIN users u ON a.user_id = u.id
            ORDER BY a.created_at DESC
            LIMIT $1 OFFSET $2
        `, [limit, offset]);

        res.json({
            data: result.rows,
            total,
            page,
            limit
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
