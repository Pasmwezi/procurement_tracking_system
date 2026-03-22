const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Helper: verify officer owns the file (or is team_leader)
async function canAccessFile(user, fileId) {
    if (user.role === 'team_leader') return true;
    const check = await pool.query('SELECT officer_id FROM files WHERE id = $1', [fileId]);
    if (check.rows.length === 0) return false;
    return check.rows[0].officer_id === user.id;
}

// GET /api/bids?file_id= — list bids for a file
router.get('/', async (req, res) => {
    const { file_id } = req.query;
    if (!file_id) return res.status(400).json({ error: 'file_id query param is required' });

    try {
        if (!(await canAccessFile(req.user, file_id))) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query(
            `SELECT b.*, v.name AS vendor_name, v.status AS vendor_status,
                    u.display_name AS created_by_name
             FROM bids b
             LEFT JOIN vendors v ON v.id = b.vendor_id
             LEFT JOIN users u ON u.id = b.created_by
             WHERE b.file_id = $1
             ORDER BY b.created_at ASC`,
            [file_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/bids — create a bid (officer on own file, or team_leader)
router.post('/', async (req, res) => {
    const { file_id, vendor_id, vendor_name_free, submission_date,
            bid_amount, technical_score, financial_score,
            disqualified, disqualification_reason, notes } = req.body;

    if (!file_id) return res.status(400).json({ error: 'file_id is required' });
    if (!vendor_id && !vendor_name_free) {
        return res.status(400).json({ error: 'Either vendor_id or vendor_name_free is required' });
    }

    try {
        if (!(await canAccessFile(req.user, file_id))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Prevent selecting a blacklisted vendor
        if (vendor_id) {
            const vendorCheck = await pool.query('SELECT status FROM vendors WHERE id = $1', [vendor_id]);
            if (vendorCheck.rows.length > 0 && vendorCheck.rows[0].status === 'Blacklisted') {
                return res.status(400).json({ error: 'Cannot add bid from a blacklisted vendor' });
            }
        }

        const result = await pool.query(
            `INSERT INTO bids (file_id, vendor_id, vendor_name_free, submission_date,
                bid_amount, technical_score, financial_score,
                disqualified, disqualification_reason, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
            [file_id, vendor_id || null, vendor_name_free || null,
             submission_date || null, bid_amount || null,
             technical_score || null, financial_score || null,
             disqualified || false, disqualification_reason || null,
             notes || null, req.user.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/bids/:id — update a bid (officer on own file, or team_leader)
router.put('/:id', async (req, res) => {
    try {
        const existing = await pool.query('SELECT * FROM bids WHERE id = $1', [req.params.id]);
        if (existing.rows.length === 0) return res.status(404).json({ error: 'Bid not found' });
        const bid = existing.rows[0];

        if (!(await canAccessFile(req.user, bid.file_id))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        const { vendor_id, vendor_name_free, submission_date,
                bid_amount, technical_score, financial_score,
                disqualified, disqualification_reason, notes } = req.body;

        const result = await pool.query(
            `UPDATE bids SET
                vendor_id = COALESCE($1, vendor_id),
                vendor_name_free = COALESCE($2, vendor_name_free),
                submission_date = COALESCE($3, submission_date),
                bid_amount = COALESCE($4, bid_amount),
                technical_score = COALESCE($5, technical_score),
                financial_score = COALESCE($6, financial_score),
                disqualified = COALESCE($7, disqualified),
                disqualification_reason = COALESCE($8, disqualification_reason),
                notes = COALESCE($9, notes)
             WHERE id = $10 RETURNING *`,
            [vendor_id, vendor_name_free, submission_date, bid_amount,
             technical_score, financial_score,
             disqualified !== undefined ? disqualified : null,
             disqualification_reason, notes, req.params.id]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/bids/:id/winner — mark bid as winner + copy vendor onto contract (team_leader only)
router.put('/:id/winner', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can mark a winning bid' });
    }
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const bidRes = await client.query(
            `SELECT b.*, v.name AS vendor_name FROM bids b
             LEFT JOIN vendors v ON v.id = b.vendor_id
             WHERE b.id = $1`,
            [req.params.id]
        );
        if (bidRes.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Bid not found' });
        }
        const bid = bidRes.rows[0];
        const winnerName = bid.vendor_name || bid.vendor_name_free;

        // Clear any previous winner for this file
        await client.query('UPDATE bids SET is_winner = FALSE WHERE file_id = $1', [bid.file_id]);

        // Mark this bid as winner
        await client.query('UPDATE bids SET is_winner = TRUE WHERE id = $1', [req.params.id]);

        // Update contractor_name on the most recent contract for this file
        if (winnerName) {
            await client.query(
                `UPDATE contracts SET contractor_name = $1
                 WHERE file_id = $2 AND id = (SELECT MAX(id) FROM contracts WHERE file_id = $2)`,
                [winnerName, bid.file_id]
            );
        }

        await client.query('COMMIT');
        res.json({ message: 'Winning bid set', contractor_name: winnerName });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

// DELETE /api/bids/:id — delete bid (team_leader only)
router.delete('/:id', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can delete bids' });
    }
    try {
        const result = await pool.query('DELETE FROM bids WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Bid not found' });
        res.json({ message: 'Bid deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
