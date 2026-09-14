const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

function applyScope(req, conditions, params, userAlias = 'u', notificationAlias = 'n') {
    if (req.user.role === 'officer') {
        params.push(req.user.id);
        conditions.push(`${notificationAlias}.officer_id = $${params.length}`);
    } else if (req.user.role === 'team_leader') {
        params.push(req.user.teamId);
        conditions.push(`${userAlias}.team_id = $${params.length}`);
    }
}

// GET /api/notifications — role and team scoped
router.get('/', async (req, res) => {
    try {
        let sql = `
            SELECT n.*, u.display_name AS officer_name, f.pr_number, f.title AS file_title, ps.step_name
            FROM notifications n
            JOIN users u ON u.id = n.officer_id
            JOIN files f ON f.id = n.file_id
            JOIN process_steps ps ON ps.id = n.step_id`;
        const params = [];
        const conditions = [];
        applyScope(req, conditions, params);
        if (req.query.officer_id) {
            params.push(req.query.officer_id);
            conditions.push(`n.officer_id = $${params.length}`);
        }
        if (req.query.unread === 'true') conditions.push('n.is_read = false');
        if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
        sql += ' ORDER BY n.created_at DESC LIMIT 100';
        res.json((await pool.query(sql, params)).rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/notifications/count — unread count (role and team scoped)
router.get('/count', async (req, res) => {
    try {
        let sql = 'SELECT COUNT(*) FROM notifications n JOIN users u ON u.id = n.officer_id';
        const params = [];
        const conditions = ['n.is_read = false'];
        applyScope(req, conditions, params);
        sql += ' WHERE ' + conditions.join(' AND ');
        const result = await pool.query(sql, params);
        res.json({ count: parseInt(result.rows[0].count) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', async (req, res) => {
    try {
        const result = await pool.query(`
            UPDATE notifications n SET is_read = true
            WHERE n.id = $1 AND (
                $2::boolean OR n.officer_id = $3 OR
                ($4::boolean AND EXISTS (
                    SELECT 1 FROM users u WHERE u.id = n.officer_id AND u.team_id = $5
                ))
            ) RETURNING n.id`,
        [req.params.id, req.user.role === 'admin', req.user.id,
            req.user.role === 'team_leader', req.user.teamId || null]);
        if (!result.rowCount) return res.status(404).json({ error: 'Notification not found' });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/notifications/read-all (role and team scoped)
router.put('/read-all', async (req, res) => {
    try {
        let sql = 'UPDATE notifications n SET is_read = true WHERE n.is_read = false';
        const params = [];
        if (req.user.role === 'officer') {
            sql += ' AND n.officer_id = $1';
            params.push(req.user.id);
        } else if (req.user.role === 'team_leader') {
            sql += ' AND EXISTS (SELECT 1 FROM users u WHERE u.id = n.officer_id AND u.team_id = $1)';
            params.push(req.user.teamId);
        }
        await pool.query(sql, params);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
