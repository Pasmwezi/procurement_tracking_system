const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/notifications — role-scoped
// Team Leader: all notifications (cross-team visible)
// Officer: only their own notifications
router.get('/', async (req, res) => {
    try {
        let query = `
      SELECT n.*, u.display_name AS officer_name, f.pr_number, f.title AS file_title,
             ps.step_name
      FROM notifications n
      JOIN users u ON u.id = n.officer_id
      JOIN files f ON f.id = n.file_id
      JOIN process_steps ps ON ps.id = n.step_id
    `;
        const params = [];
        const conditions = [];

        // Role-based scoping
        if (req.user.role === 'officer') {
            params.push(req.user.id);
            conditions.push(`n.officer_id = $${params.length}`);
        }

        if (req.query.officer_id) {
            params.push(req.query.officer_id);
            conditions.push(`n.officer_id = $${params.length}`);
        }

        if (req.query.unread === 'true') {
            conditions.push('n.is_read = false');
        }

        if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ');
        query += ' ORDER BY n.created_at DESC LIMIT 100';

        const result = await pool.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/notifications/count — unread count (role-scoped)
router.get('/count', async (req, res) => {
    try {
        let query = 'SELECT COUNT(*) FROM notifications WHERE is_read = false';
        const params = [];
        if (req.user.role === 'officer') {
            query += ' AND officer_id = $1';
            params.push(req.user.id);
        }
        const result = await pool.query(query, params);
        res.json({ count: parseInt(result.rows[0].count) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/notifications/:id/read
router.put('/:id/read', async (req, res) => {
    try {
        await pool.query('UPDATE notifications SET is_read = true WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/notifications/read-all (role-scoped)
router.put('/read-all', async (req, res) => {
    try {
        let query = 'UPDATE notifications SET is_read = true WHERE is_read = false';
        const params = [];
        if (req.user.role === 'officer') {
            query += ' AND officer_id = $1';
            params.push(req.user.id);
        }
        await pool.query(query, params);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
