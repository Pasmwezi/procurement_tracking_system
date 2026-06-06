const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/vendors — list all vendors (optional ?status= filter)
router.get('/', async (req, res) => {
    try {
        const params = [];
        let where = '';
        if (req.query.status) {
            params.push(req.query.status);
            where = 'WHERE status = $1';
        }
        const result = await pool.query(
            `SELECT * FROM vendors ${where} ORDER BY name ASC`,
            params
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/vendors/:id — single vendor
router.get('/:id', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM vendors WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/vendors — create vendor (team_leader only)
router.post('/', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can create vendors' });
    }
    const { name, registration_number, contact_email, contact_phone, address, category, notes } = req.body;
    if (!name) return res.status(400).json({ error: 'Vendor name is required' });

    try {
        const result = await pool.query(
            `INSERT INTO vendors (name, registration_number, contact_email, contact_phone, address, category, notes)
             VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
            [name, registration_number || null, contact_email || null, contact_phone || null,
             address || null, category || null, notes || null]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Vendor name already exists' });
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/vendors/:id — update vendor (team_leader only)
router.put('/:id', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can update vendors' });
    }
    const { name, registration_number, contact_email, contact_phone, address, category, status, notes } = req.body;
    try {
        const result = await pool.query(
            `UPDATE vendors SET
                name = COALESCE($1, name),
                registration_number = COALESCE($2, registration_number),
                contact_email = COALESCE($3, contact_email),
                contact_phone = COALESCE($4, contact_phone),
                address = COALESCE($5, address),
                category = COALESCE($6, category),
                status = COALESCE($7, status),
                notes = COALESCE($8, notes)
             WHERE id = $9 RETURNING *`,
            [name, registration_number, contact_email, contact_phone, address, category, status, notes, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'Vendor name already exists' });
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/vendors/:id — delete vendor (team_leader only; soft-deactivate if referenced by bids)
router.delete('/:id', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can delete vendors' });
    }
    try {
        // Check if referenced by bids
        const refCheck = await pool.query('SELECT COUNT(*) FROM bids WHERE vendor_id = $1', [req.params.id]);
        if (parseInt(refCheck.rows[0].count) > 0) {
            // Soft-deactivate instead
            const result = await pool.query(
                "UPDATE vendors SET status = 'Inactive' WHERE id = $1 RETURNING *",
                [req.params.id]
            );
            if (result.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
            return res.json({ message: 'Vendor deactivated (has existing bids)', vendor: result.rows[0] });
        }
        const result = await pool.query('DELETE FROM vendors WHERE id = $1 RETURNING id', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Vendor not found' });
        res.json({ message: 'Vendor deleted' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
