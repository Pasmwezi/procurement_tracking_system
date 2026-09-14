const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

function teamScope(req) {
    return req.user.role === 'team_leader' ? req.user.teamId : null;
}

// GET /api/reports/dashboard
router.get('/dashboard', async (req, res) => {
    try {
        const result = {};
        const teamId = teamScope(req);
        const spendResult = await pool.query(`
            SELECT SUM(COALESCE(b.bid_amount, f.estimated_value, 0)) AS total
            FROM files f
            JOIN users u ON u.id = f.officer_id
            LEFT JOIN bids b ON b.file_id = f.id AND b.is_winner = TRUE
            WHERE f.status = 'Completed' AND ($1::integer IS NULL OR u.team_id = $1)
        `, [teamId]);
        result.totalSpend = parseFloat(spendResult.rows[0].total) || 0;

        const processStats = await pool.query(`
            SELECT f.process_name, COUNT(*) AS count
            FROM files f JOIN users u ON u.id = f.officer_id
            WHERE ($1::integer IS NULL OR u.team_id = $1)
            GROUP BY f.process_name ORDER BY count DESC
        `, [teamId]);
        result.byProcess = processStats.rows;

        const intakeTrend = await pool.query(`
            SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, COUNT(*) AS count
            FROM triage_files
            WHERE created_at >= NOW() - INTERVAL '12 months'
              AND ($1::integer IS NULL OR team_id = $1)
            GROUP BY month ORDER BY month ASC
        `, [teamId]);
        result.intakeTrend = intakeTrend.rows;

        const sla = await pool.query(`
            SELECT COUNT(*) AS total_steps,
                   SUM(CASE WHEN l.sla_met = TRUE THEN 1 ELSE 0 END) AS met_steps
            FROM file_step_log l
            JOIN files f ON f.id = l.file_id
            JOIN users u ON u.id = f.officer_id
            WHERE l.completed_at IS NOT NULL AND ($1::integer IS NULL OR u.team_id = $1)
        `, [teamId]);
        const totalSteps = parseInt(sla.rows[0].total_steps) || 0;
        const metSteps = parseInt(sla.rows[0].met_steps) || 0;
        result.slaCompliance = totalSteps > 0 ? Math.round((metSteps / totalSteps) * 100) : 0;

        const topVendors = await pool.query(`
            SELECT v.name AS vendor_name, COUNT(b.id) AS contract_count, SUM(b.bid_amount) AS total_value
            FROM vendors v
            JOIN bids b ON b.vendor_id = v.id
            JOIN files f ON f.id = b.file_id
            JOIN users u ON u.id = f.officer_id
            WHERE b.is_winner = TRUE AND ($1::integer IS NULL OR u.team_id = $1)
            GROUP BY v.name ORDER BY total_value DESC NULLS LAST LIMIT 5
        `, [teamId]);
        result.topVendors = topVendors.rows;

        const expiries = await pool.query(`
            SELECT c.id, c.contract_number, f.pr_number, f.title AS file_title,
                   c.contractor_name, COALESCE(c.amended_end_date, c.end_date) AS final_end_date
            FROM contracts c
            JOIN files f ON f.id = c.file_id
            JOIN users u ON u.id = f.officer_id
            WHERE COALESCE(c.amended_end_date, c.end_date) >= CURRENT_DATE
              AND COALESCE(c.amended_end_date, c.end_date) <= CURRENT_DATE + INTERVAL '90 days'
              AND ($1::integer IS NULL OR u.team_id = $1)
            ORDER BY final_end_date ASC
        `, [teamId]);
        result.expiringContracts = expiries.rows;

        res.json(result);
    } catch (err) {
        console.error('Reports Dashboard Error:', err);
        res.status(500).json({ error: 'Failed to generate dashboard reports' });
    }
});

// GET /api/reports/sla
router.get('/sla', async (req, res) => {
    try {
        const teamId = teamScope(req);
        const rawData = await pool.query(`
            SELECT u.display_name AS officer_name, f.process_name, ps.step_name, f.pr_number,
                   l.started_at, l.completed_at, ps.sla_days, l.sla_met
            FROM file_step_log l
            JOIN process_steps ps ON ps.id = l.step_id
            JOIN files f ON f.id = l.file_id
            JOIN users u ON u.id = f.officer_id
            WHERE l.completed_at IS NOT NULL
              AND ($1::integer IS NULL OR u.team_id = $1)
            ORDER BY u.display_name ASC, f.process_name ASC, l.completed_at ASC
        `, [teamId]);
        res.json(rawData.rows);
    } catch (err) {
        console.error('SLA Report Error:', err);
        res.status(500).json({ error: 'Failed to generate SLA report' });
    }
});

module.exports = router;
