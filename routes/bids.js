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
    const { file_id, submission_date,
            bid_amount, technical_score, financial_score,
            disqualified, disqualification_reason, notes } = req.body;
    let { vendor_id, vendor_name_free } = req.body;

    if (!file_id) return res.status(400).json({ error: 'file_id is required' });
    if (!vendor_id && !vendor_name_free) {
        return res.status(400).json({ error: 'Either vendor_id or vendor_name_free is required' });
    }

    try {
        if (!(await canAccessFile(req.user, file_id))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Auto-register vendor if submitted via free text
        if (!vendor_id && vendor_name_free) {
            const vendorCheck = await pool.query('SELECT id, status FROM vendors WHERE name = $1', [vendor_name_free]);
            if (vendorCheck.rows.length > 0) {
                if (vendorCheck.rows[0].status === 'Blacklisted') {
                    return res.status(400).json({ error: 'Cannot add bid from a blacklisted vendor' });
                }
                vendor_id = vendorCheck.rows[0].id;
                vendor_name_free = null;
            } else {
                const newVendor = await pool.query(
                    'INSERT INTO vendors (name, status, notes) VALUES ($1, $2, $3) RETURNING id',
                    [vendor_name_free, 'Active', 'Automatically registered from bid entry']
                );
                vendor_id = newVendor.rows[0].id;
                vendor_name_free = null;
            }
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

        const { submission_date,
                bid_amount, technical_score, financial_score,
                disqualified, disqualification_reason, notes } = req.body;
        let { vendor_id, vendor_name_free } = req.body;

        // Auto-register vendor if submitted via free text
        if (!vendor_id && vendor_name_free) {
            const vendorCheck = await pool.query('SELECT id, status FROM vendors WHERE name = $1', [vendor_name_free]);
            if (vendorCheck.rows.length > 0) {
                if (vendorCheck.rows[0].status === 'Blacklisted') {
                    return res.status(400).json({ error: 'Cannot update bid to a blacklisted vendor' });
                }
                vendor_id = vendorCheck.rows[0].id;
                vendor_name_free = null; // Map directly into registry
            } else {
                const newVendor = await pool.query(
                    'INSERT INTO vendors (name, status, notes) VALUES ($1, $2, $3) RETURNING id',
                    [vendor_name_free, 'Active', 'Automatically registered from bid entry']
                );
                vendor_id = newVendor.rows[0].id;
                vendor_name_free = null;
            }
        }

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

// GET /api/bids/evaluate/:file_id — evaluate bids and recommend winner
router.get('/evaluate/:file_id', async (req, res) => {
    const { file_id } = req.params;

    try {
        if (!(await canAccessFile(req.user, file_id))) {
            return res.status(403).json({ error: 'Access denied' });
        }

        // Fetch file configuration
        const fileResult = await pool.query(
            `SELECT basis_of_selection, minimum_points_threshold,
                    technical_weight_percent, price_weight_percent, maximum_technical_points
             FROM files WHERE id = $1`,
            [file_id]
        );
        if (fileResult.rows.length === 0) return res.status(404).json({ error: 'File not found' });

        const cfg = fileResult.rows[0];

        if (!cfg.basis_of_selection) {
            return res.status(400).json({ error: 'Basis of selection has not been configured for this file' });
        }

        // Fetch all bids
        const bidsResult = await pool.query(
            `SELECT b.*, v.name AS vendor_name, v.status AS vendor_status
             FROM bids b
             LEFT JOIN vendors v ON v.id = b.vendor_id
             WHERE b.file_id = $1
             ORDER BY b.created_at ASC`,
            [file_id]
        );
        const allBids = bidsResult.rows;

        const method = cfg.basis_of_selection;

        // ---------------------------------------------------------------
        // Step 1: Determine which bids are "responsive"
        // A bid is responsive if:
        //   - Not disqualified
        //   - For point-based methods: technical_score >= minimum_points_threshold (if set)
        // ---------------------------------------------------------------
        const minThreshold = cfg.minimum_points_threshold != null ? parseFloat(cfg.minimum_points_threshold) : null;

        const evaluatedBids = allBids.map(b => {
            const bid_amount = b.bid_amount != null ? parseFloat(b.bid_amount) : null;
            const technical_score = b.technical_score != null ? parseFloat(b.technical_score) : null;

            let responsive = !b.disqualified;
            let non_responsive_reason = b.disqualified ? (b.disqualification_reason || 'Disqualified') : null;

            // Point-threshold check for point-based methods
            if (responsive && ['lowest_price_per_point', 'highest_combined_rating'].includes(method)) {
                if (minThreshold != null && (technical_score == null || technical_score < minThreshold)) {
                    responsive = false;
                    non_responsive_reason = `Technical score (${technical_score ?? 'N/A'}) is below minimum threshold (${minThreshold})`;
                }
            }

            // Price must be present for any evaluation
            if (responsive && bid_amount == null) {
                responsive = false;
                non_responsive_reason = 'Missing bid amount';
            }

            return { ...b, bid_amount, technical_score, responsive, non_responsive_reason };
        });

        const responsiveBids = evaluatedBids.filter(b => b.responsive);

        if (responsiveBids.length === 0) {
            return res.json({
                method,
                config: cfg,
                all_bids: evaluatedBids,
                responsive_bids: [],
                recommended_winner: null,
                message: 'No responsive bids found.'
            });
        }

        // ---------------------------------------------------------------
        // Method A: Lowest Price
        // ---------------------------------------------------------------
        if (method === 'lowest_price') {
            const sorted = [...responsiveBids].sort((a, b) => a.bid_amount - b.bid_amount);
            const ranked = sorted.map((b, i) => ({ ...b, rank: i + 1, metric: b.bid_amount, metric_label: 'Evaluated Price' }));

            return res.json({
                method,
                config: cfg,
                all_bids: evaluatedBids,
                responsive_bids: ranked,
                recommended_winner: ranked[0],
                message: 'Selection: responsive bid with the lowest evaluated price.'
            });
        }

        // ---------------------------------------------------------------
        // Method B: Lowest Price Per Point
        // ---------------------------------------------------------------
        if (method === 'lowest_price_per_point') {
            // Require that ALL responsive bids have a technical_score
            const missing = responsiveBids.filter(b => b.technical_score == null || b.technical_score === 0);
            if (missing.length > 0) {
                return res.status(400).json({
                    error: 'Cannot evaluate: one or more responsive bids are missing a technical score or have a score of 0 (division by zero). Price per point cannot be calculated.',
                    missing_bids: missing.map(b => ({ id: b.id, vendor: b.vendor_name || b.vendor_name_free }))
                });
            }

            const scored = responsiveBids.map(b => ({
                ...b,
                metric: b.bid_amount / b.technical_score,
                metric_label: 'Price per Point (lower is better)'
            }));
            const sorted = [...scored].sort((a, b) => a.metric - b.metric);
            const ranked = sorted.map((b, i) => ({ ...b, rank: i + 1 }));

            return res.json({
                method,
                config: cfg,
                all_bids: evaluatedBids,
                responsive_bids: ranked,
                recommended_winner: ranked[0],
                message: 'Selection: responsive offer with the lowest evaluated price per point. Neither the highest points nor lowest price must be accepted — the lowest price/point ratio determines the winner.'
            });
        }

        // ---------------------------------------------------------------
        // Method C: Highest Combined Rating
        // ---------------------------------------------------------------
        if (method === 'highest_combined_rating') {
            const techWeight = parseFloat(cfg.technical_weight_percent);
            const priceWeight = parseFloat(cfg.price_weight_percent);
            const maxPoints = parseFloat(cfg.maximum_technical_points);

            // Find lowest evaluated price among responsive bids
            const lowestPrice = Math.min(...responsiveBids.map(b => b.bid_amount));

            const scored = responsiveBids.map(b => {
                // Technical merit score: (points obtained / max points) * technical_weight_%
                const tech_merit_score = (b.technical_score / maxPoints) * techWeight;
                // Pricing score: (lowest price / this bid's price) * price_weight_%
                const pricing_score = (lowestPrice / b.bid_amount) * priceWeight;
                const combined_rating = tech_merit_score + pricing_score;

                return {
                    ...b,
                    tech_merit_score: Math.round(tech_merit_score * 10000) / 10000,
                    pricing_score: Math.round(pricing_score * 10000) / 10000,
                    combined_rating: Math.round(combined_rating * 10000) / 10000,
                    metric: combined_rating,
                    metric_label: 'Combined Rating (higher is better)'
                };
            });

            const sorted = [...scored].sort((a, b) => b.metric - a.metric); // descending
            const ranked = sorted.map((b, i) => ({ ...b, rank: i + 1 }));

            return res.json({
                method,
                config: cfg,
                all_bids: evaluatedBids,
                responsive_bids: ranked,
                recommended_winner: ranked[0],
                message: `Selection: highest combined rating (${techWeight}% technical + ${priceWeight}% price). Neither the highest technical score nor lowest price must be accepted.`
            });
        }

        return res.status(400).json({ error: 'Unknown basis of selection method' });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;

