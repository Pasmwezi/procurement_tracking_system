const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// Helper: verify user can access a PO (officer on related file or team_leader)
async function canAccessPO(user, poId) {
    if (user.role === 'team_leader') return true;
    const check = await pool.query(
        `SELECT f.officer_id FROM purchase_orders po
         JOIN contracts c ON c.id = po.contract_id
         JOIN files f ON f.id = c.file_id
         WHERE po.id = $1`,
        [poId]
    );
    if (check.rows.length === 0) return false;
    return check.rows[0].officer_id === user.id;
}

// ===== Purchase Orders =====

// GET /api/purchase-orders?contract_id= — list POs for a contract
router.get('/', async (req, res) => {
    const { contract_id } = req.query;
    if (!contract_id) return res.status(400).json({ error: 'contract_id query param is required' });
    try {
        const result = await pool.query(
            `SELECT po.*, u.display_name AS created_by_name,
                    (SELECT COUNT(*) FROM goods_receipts gr WHERE gr.po_id = po.id) AS receipt_count,
                    (SELECT COUNT(*) FROM invoices inv WHERE inv.po_id = po.id) AS invoice_count
             FROM purchase_orders po
             LEFT JOIN users u ON u.id = po.created_by
             WHERE po.contract_id = $1
             ORDER BY po.created_at ASC`,
            [contract_id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/purchase-orders — create PO (officer or team_leader)
router.post('/', async (req, res) => {
    const { contract_id, po_number, po_date, amount, description } = req.body;
    if (!contract_id || !po_number || !po_date || !amount) {
        return res.status(400).json({ error: 'contract_id, po_number, po_date, and amount are required' });
    }
    try {
        // Verify the contract belongs to a file this user can access
        if (req.user.role === 'officer') {
            const check = await pool.query(
                `SELECT f.officer_id FROM contracts c JOIN files f ON f.id = c.file_id WHERE c.id = $1`,
                [contract_id]
            );
            if (check.rows.length === 0 || check.rows[0].officer_id !== req.user.id) {
                return res.status(403).json({ error: 'Access denied' });
            }
        }
        const result = await pool.query(
            `INSERT INTO purchase_orders (contract_id, po_number, po_date, amount, description, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [contract_id, po_number, po_date, amount, description || null, req.user.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'PO number already exists' });
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/purchase-orders/:id — update PO status/details (officer on own or team_leader)
router.put('/:id', async (req, res) => {
    try {
        if (!(await canAccessPO(req.user, req.params.id))) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { po_number, po_date, amount, description, status } = req.body;
        const result = await pool.query(
            `UPDATE purchase_orders SET
                po_number = COALESCE($1, po_number),
                po_date = COALESCE($2, po_date),
                amount = COALESCE($3, amount),
                description = COALESCE($4, description),
                status = COALESCE($5, status)
             WHERE id = $6 RETURNING *`,
            [po_number, po_date, amount, description, status, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'PO not found' });
        res.json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') return res.status(409).json({ error: 'PO number already exists' });
        res.status(500).json({ error: err.message });
    }
});

// ===== Goods Receipts =====

// GET /api/purchase-orders/:id/receipts
router.get('/:id/receipts', async (req, res) => {
    try {
        if (!(await canAccessPO(req.user, req.params.id))) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query(
            `SELECT gr.*, u.display_name AS created_by_name
             FROM goods_receipts gr
             LEFT JOIN users u ON u.id = gr.created_by
             WHERE gr.po_id = $1 ORDER BY gr.receipt_date ASC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/purchase-orders/:id/receipts — add goods receipt
router.post('/:id/receipts', async (req, res) => {
    try {
        if (!(await canAccessPO(req.user, req.params.id))) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { receipt_date, received_quantity, received_by_name, notes } = req.body;
        if (!receipt_date) return res.status(400).json({ error: 'receipt_date is required' });

        const result = await pool.query(
            `INSERT INTO goods_receipts (po_id, receipt_date, received_quantity, received_by_name, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
            [req.params.id, receipt_date, received_quantity || null, received_by_name || null, notes || null, req.user.id]
        );
        // Auto-update PO status to Received if not already Closed/Cancelled
        await pool.query(
            `UPDATE purchase_orders SET status = 'Received'
             WHERE id = $1 AND status = 'Open'`,
            [req.params.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== Invoices =====

// GET /api/purchase-orders/:id/invoices
router.get('/:id/invoices', async (req, res) => {
    try {
        if (!(await canAccessPO(req.user, req.params.id))) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const result = await pool.query(
            `SELECT inv.*, u.display_name AS created_by_name
             FROM invoices inv
             LEFT JOIN users u ON u.id = inv.created_by
             WHERE inv.po_id = $1 ORDER BY inv.invoice_date ASC`,
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/purchase-orders/:id/invoices — add invoice
router.post('/:id/invoices', async (req, res) => {
    try {
        if (!(await canAccessPO(req.user, req.params.id))) {
            return res.status(403).json({ error: 'Access denied' });
        }
        const { contract_id, invoice_number, invoice_date, amount, due_date, notes } = req.body;
        if (!invoice_number || !invoice_date || !amount) {
            return res.status(400).json({ error: 'invoice_number, invoice_date, and amount are required' });
        }
        // Resolve contract_id from PO if not provided
        let resolvedContractId = contract_id;
        if (!resolvedContractId) {
            const poRes = await pool.query('SELECT contract_id FROM purchase_orders WHERE id = $1', [req.params.id]);
            if (poRes.rows.length > 0) resolvedContractId = poRes.rows[0].contract_id;
        }
        const result = await pool.query(
            `INSERT INTO invoices (contract_id, po_id, invoice_number, invoice_date, amount, due_date, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
            [resolvedContractId || null, req.params.id, invoice_number, invoice_date, amount, due_date || null, notes || null, req.user.id]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// PUT /api/invoices/:invoiceId/status — approve, reject, or mark paid (team_leader only)
router.put('/invoices/:invoiceId/status', async (req, res) => {
    if (req.user.role !== 'team_leader') {
        return res.status(403).json({ error: 'Only team leaders can update invoice status' });
    }
    const { status } = req.body;
    if (!['Approved', 'Rejected', 'Paid', 'Pending'].includes(status)) {
        return res.status(400).json({ error: 'Invalid status. Must be one of: Pending, Approved, Rejected, Paid' });
    }
    try {
        const paid_date = status === 'Paid' ? new Date().toISOString().split('T')[0] : null;
        const result = await pool.query(
            `UPDATE invoices SET status = $1, paid_date = COALESCE($2, paid_date)
             WHERE id = $3 RETURNING *`,
            [status, paid_date, req.params.invoiceId]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Invoice not found' });
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
