const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/officers — list officers (users with role='officer')
// Team Leaders see all officers (can assign cross-team)
// Officers see nothing (403 handled by requireRole in server.js, but GET allowed for file forms)
router.get('/', async (req, res) => {
    try {
        let whereClause = "WHERE u.role = 'officer' AND u.is_active = TRUE";
        const params = [];

        if (req.user.role === 'team_leader' && req.query.team_id === 'me') {
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
router.delete('/:id', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can remove officers' });
    }

    try {
        const filesCheck = await pool.query('SELECT COUNT(*) FROM files WHERE officer_id = $1', [req.params.id]);
        if (parseInt(filesCheck.rows[0].count) > 0) {
            return res.status(400).json({ error: 'Cannot delete officer with assigned files' });
        }
        await pool.query("UPDATE users SET is_active = FALSE WHERE id = $1 AND role = 'officer'", [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/officers/:id/transfer — transfer files (team leaders only)
router.put('/:id/transfer', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can transfer files' });
    }

    const fromId = parseInt(req.params.id);
    const { transfers } = req.body;

    if (!transfers || !Array.isArray(transfers) || transfers.length === 0) {
        return res.status(400).json({ error: 'At least one file transfer is required' });
    }

    try {
        const fromOfficer = await pool.query(
            "SELECT id, email, display_name AS name FROM users WHERE id = $1 AND role = 'officer'",
            [fromId]
        );
        if (fromOfficer.rows.length === 0) return res.status(404).json({ error: 'Source officer not found' });

        const results = [];
        for (const t of transfers) {
            if (!t.file_id || !t.to_officer_id) continue;
            if (parseInt(t.to_officer_id) === fromId) continue;

            const updated = await pool.query(
                `UPDATE files SET officer_id = $1
                 WHERE id = $2 AND officer_id = $3 AND status = 'Active'
                 RETURNING id, pr_number, title, process_name`,
                [t.to_officer_id, t.file_id, fromId]
            );
            if (updated.rows.length > 0) {
                results.push({ ...updated.rows[0], to_officer_id: parseInt(t.to_officer_id) });
            }
        }

        const targetIds = [...new Set(results.map(r => r.to_officer_id))];
        const targetOfficers = {};
        for (const tid of targetIds) {
            const oRes = await pool.query(
                'SELECT id, email, display_name AS name FROM users WHERE id = $1',
                [tid]
            );
            if (oRes.rows.length > 0) targetOfficers[tid] = oRes.rows[0];
        }

        const grouped = {};
        for (const r of results) {
            if (!grouped[r.to_officer_id]) grouped[r.to_officer_id] = [];
            grouped[r.to_officer_id].push(r);
        }

        res.json({
            success: true,
            transferred_count: results.length,
            from_officer: fromOfficer.rows[0],
            grouped_transfers: Object.entries(grouped).map(([toId, files]) => ({
                to_officer: targetOfficers[parseInt(toId)],
                files
            }))
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
