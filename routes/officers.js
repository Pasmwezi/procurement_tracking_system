const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { param } = require('express-validator');
const { validateRequest } = require('../middleware/validate');
const { executeFileTransfers } = require('../services/fileTransfers');
const { setUserActive } = require('../services/userLifecycle');

// GET /api/officers — list officers (users with role='officer')
// Team Leaders see all officers (can assign cross-team)
// Officers see nothing (403 handled by requireRole in server.js, but GET allowed for file forms)
router.get('/', async (req, res) => {
    if (req.user.role === 'officer') return res.status(403).json({ error: 'Access denied' });
    try {
        let whereClause = "WHERE u.role = 'officer' AND u.is_active = TRUE";
        const params = [];

        if (req.user.role === 'team_leader') {
            params.push(req.user.teamId);
            whereClause += ` AND u.team_id = $${params.length}`;
        }

        const result = await pool.query(
            `SELECT u.id, u.email, u.display_name AS name, u.team_id, u.is_active,
                    t.name AS team_name,
                    (SELECT COUNT(*) FROM files f WHERE f.officer_id = u.id) AS file_count,
                    (SELECT COUNT(*) FROM files f WHERE f.officer_id = u.id AND f.status = 'Active') AS active_count,
                    (SELECT COUNT(*) FROM files f WHERE f.officer_id = u.id AND f.status = 'Completed') AS completed_count
             FROM users u
             LEFT JOIN teams t ON t.id = u.team_id
             ${whereClause}
             ORDER BY u.display_name`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/officers/:id/transfer-candidates — complete active-file list
router.get('/:id/transfer-candidates', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can transfer files' });
    }
    const officerId = Number(req.params.id);
    if (!Number.isInteger(officerId) || officerId <= 0) {
        return res.status(400).json({ error: 'Officer ID must be a positive integer' });
    }
    try {
        const officer = await pool.query(
            "SELECT id FROM users WHERE id = $1 AND role = 'officer' AND is_active = TRUE AND team_id = $2",
            [officerId, req.user.teamId]
        );
        if (officer.rowCount === 0) return res.status(404).json({ error: 'Active officer not found' });
        const files = await pool.query(
            `SELECT id, pr_number, title, process_name, status
             FROM files
             WHERE officer_id = $1 AND status = 'Active'
             ORDER BY created_at DESC, id DESC`,
            [officerId]
        );
        res.json(files.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/officers — create officer (team leaders only)
router.post('/', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can create officers' });
    }

    const { name, email } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'Name and email are required' });

    try {
        // Create officer as user with no password (admin sets it)
        const result = await pool.query(
            `INSERT INTO users (email, display_name, role, team_id)
             VALUES ($1, $2, 'officer', $3)
             RETURNING id, email, display_name AS name, team_id`,
            [email.toLowerCase().trim(), name, req.user.teamId || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Email already exists' });
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/officers/:id — only team leaders
router.delete('/:id', [
    param('id').isInt({ min: 1 }).withMessage('Officer ID must be a positive integer'),
    validateRequest
], async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can remove officers' });
    }

    try {
        await setUserActive(pool, {
            userId: Number(req.params.id),
            isActive: false,
            teamId: req.user.teamId,
            requiredRole: 'officer',
            blockAnyAssigned: true
        });
        res.json({ success: true });
    } catch (err) {
        const message = err.statusCode === 404 ? 'Officer not found in your team' : err.message;
        res.status(err.statusCode || 500).json({ error: message });
    }
});

// PUT /api/officers/:id/transfer — transfer files (team leaders only)
router.put('/:id/transfer', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can transfer files' });
    }

    try {
        const result = await executeFileTransfers(pool, {
            fromOfficerId: req.params.id,
            transfers: req.body.transfers,
            userId: req.user.id,
            teamId: req.user.teamId,
            ipAddress: req.ip
        });
        const grouped = {};
        for (const file of result.transferred) {
            if (!grouped[file.to_officer_id]) grouped[file.to_officer_id] = [];
            grouped[file.to_officer_id].push(file);
        }

        res.json({
            success: true,
            transferred_count: result.transferredCount,
            from_officer: result.fromOfficer,
            grouped_transfers: Object.entries(grouped).map(([toId, files]) => ({
                to_officer: result.targetsById.get(parseInt(toId)),
                files
            }))
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

module.exports = router;
