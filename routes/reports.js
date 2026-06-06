const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// GET /api/reports/dashboard
router.get('/dashboard', async (req, res) => {
    try {
        const result = {};

        // 1. Total Spend (Sum of winning bids; fallback to file estimated_value if no bids)
        const spendResult = await pool.query(`
            SELECT 
                SUM(COALESCE(b.bid_amount, f.estimated_value, 0)) AS total
            FROM 
                files f
            LEFT JOIN 
                bids b ON b.file_id = f.id AND b.is_winner = TRUE
            WHERE 
                f.status = 'Completed'
        `);
        result.totalSpend = parseFloat(spendResult.rows[0].total) || 0;

        // 2. Files by process type
        const processStats = await pool.query(`
            SELECT process_name, COUNT(*) as count
            FROM files
            GROUP BY process_name
            ORDER BY count DESC
        `);
        result.byProcess = processStats.rows;

        // 3. Monthly Intake Trend (Last 12 months)
        const intakeTrend = await pool.query(`
            SELECT 
                TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month, 
                COUNT(*) as count
            FROM triage_files
            WHERE created_at >= NOW() - INTERVAL '12 months'
            GROUP BY month
            ORDER BY month ASC
        `);
        result.intakeTrend = intakeTrend.rows;

        // 4. SLA compliance rate
        const sla = await pool.query(`
            SELECT 
                COUNT(*) as total_steps,
                SUM(CASE WHEN sla_met = TRUE THEN 1 ELSE 0 END) as met_steps
            FROM file_step_log
            WHERE completed_at IS NOT NULL
        `);
        const tot = parseInt(sla.rows[0].total_steps) || 0;
        const met = parseInt(sla.rows[0].met_steps) || 0;
        result.slaCompliance = tot > 0 ? Math.round((met / tot) * 100) : 0;

        // 5. Top vendors by contract value
        const topVendors = await pool.query(`
            SELECT 
                v.name as vendor_name, 
                COUNT(b.id) as contract_count, 
                SUM(b.bid_amount) as total_value
            FROM vendors v
            JOIN bids b ON b.vendor_id = v.id
            WHERE b.is_winner = TRUE
            GROUP BY v.name
            ORDER BY total_value DESC NULLS LAST
            LIMIT 5
        `);
        result.topVendors = topVendors.rows;

        // 6. Contract expiry calendar (next 90 days)
        const expiries = await pool.query(`
            SELECT 
                c.id, 
                c.contract_number, 
                f.pr_number, 
                f.title as file_title, 
                c.contractor_name, 
                COALESCE(c.amended_end_date, c.end_date) as final_end_date
            FROM contracts c
            JOIN files f ON f.id = c.file_id
            WHERE COALESCE(c.amended_end_date, c.end_date) >= CURRENT_DATE
              AND COALESCE(c.amended_end_date, c.end_date) <= CURRENT_DATE + INTERVAL '90 days'
            ORDER BY final_end_date ASC
        `);
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
        const rawData = await pool.query(`
            SELECT 
                u.display_name as officer_name,
                f.process_name,
                ps.step_name,
                f.pr_number,
                l.started_at,
                l.completed_at,
                ps.sla_days,
                l.sla_met
            FROM file_step_log l
            JOIN process_steps ps ON ps.id = l.step_id
            JOIN files f ON f.id = l.file_id
            JOIN users u ON u.id = f.officer_id
            WHERE l.completed_at IS NOT NULL
            ORDER BY u.display_name ASC, f.process_name ASC, l.completed_at ASC
        `);
        
        res.json(rawData.rows);
    } catch (err) {
        console.error('SLA Report Error:', err);
        res.status(500).json({ error: 'Failed to generate SLA report' });
    }
});

module.exports = router;
