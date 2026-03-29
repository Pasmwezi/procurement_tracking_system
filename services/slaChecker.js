const pool = require('../db/pool');
const { sendOverdueEmail, sendContractExpiryEmail } = require('./emailService');

async function checkSLAs() {
  console.log('[SLA] Checking for overdue steps...');

  // Find active files where the current step is overdue
  const result = await pool.query(`
    SELECT f.id AS file_id, f.pr_number, f.title, f.officer_id, f.current_step_id,
           f.step_started_at, ps.step_name, ps.sla_days, u.display_name AS officer_name, u.email
    FROM files f
    JOIN process_steps ps ON ps.id = f.current_step_id
    JOIN users u ON u.id = f.officer_id
    WHERE f.status = 'Active'
      AND ps.sla_days > 0
      AND (
        CASE 
          WHEN EXTRACT(DOW FROM (f.step_started_at + (ps.sla_days || ' days')::interval)) = 6 -- Saturday
            THEN f.step_started_at + (ps.sla_days + 2 || ' days')::interval
          WHEN EXTRACT(DOW FROM (f.step_started_at + (ps.sla_days || ' days')::interval)) = 0 -- Sunday
            THEN f.step_started_at + (ps.sla_days + 1 || ' days')::interval
          ELSE f.step_started_at + (ps.sla_days || ' days')::interval
        END
      ) < NOW()
  `);

  console.log(`[SLA] Found ${result.rows.length} overdue file(s)`);

  for (const row of result.rows) {
    // Check if we already notified for this file + step
    const existing = await pool.query(
      'SELECT id FROM notifications WHERE file_id = $1 AND step_id = $2',
      [row.file_id, row.current_step_id]
    );

    if (existing.rows.length === 0) {
      const daysOverdue = Math.floor(
        (Date.now() - new Date(row.step_started_at).getTime()) / (1000 * 60 * 60 * 24)
      ) - row.sla_days;

      const message = `⚠️ OVERDUE: File "${row.pr_number} - ${row.title}" is ${daysOverdue} day(s) overdue on step "${row.step_name}" (SLA: ${row.sla_days} days). Assigned to ${row.officer_name}.`;

      await pool.query(
        'INSERT INTO notifications (file_id, officer_id, step_id, message) VALUES ($1, $2, $3, $4)',
        [row.file_id, row.officer_id, row.current_step_id, message]
      );

      console.log(`[SLA] Notification created for file ${row.pr_number}: ${message}`);

      // Send email notification (non-blocking, won't crash if SMTP not configured)
      sendOverdueEmail(row.email, row.officer_name, row.pr_number, row.title, row.step_name, daysOverdue);
    }
  }

  console.log('[SLA] Checking for expiring contracts...');
  
  // Find contracts expiring in the next 30 days
  const contractResult = await pool.query(`
    SELECT c.id AS contract_id, c.contract_number, c.contractor_name, 
           COALESCE(c.amended_end_date, c.end_date) AS final_end_date,
           f.id AS file_id, f.pr_number, f.title, f.officer_id,
           u.display_name AS officer_name, u.team_id
    FROM contracts c
    JOIN files f ON f.id = c.file_id
    JOIN users u ON u.id = f.officer_id
    WHERE COALESCE(c.amended_end_date, c.end_date) BETWEEN NOW() AND NOW() + INTERVAL '30 days'
  `);

  console.log(`[SLA] Found ${contractResult.rows.length} expiring contract(s)`);

  for (const row of contractResult.rows) {
    // Check if we already notified for this contract expiry
    const existing = await pool.query(
      "SELECT id FROM notifications WHERE file_id = $1 AND message LIKE '%Expiring Contract%'",
      [row.file_id]
    );

    if (existing.rows.length === 0) {
      const daysLeft = Math.ceil((new Date(row.final_end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      const message = `⏳ Expiring Contract: Contract ${row.contract_number || 'for file ' + row.pr_number} expires in ${daysLeft} days.`;

      // Assign in-app notification to the officer
      await pool.query(
        'INSERT INTO notifications (file_id, officer_id, message) VALUES ($1, $2, $3)',
        [row.file_id, row.officer_id, message]
      );
      
      console.log(`[SLA] Notification created for expiring contract: ${message}`);

      // Fetch team leaders and send email
      const leaders = await pool.query(
        "SELECT email, display_name FROM users WHERE role = 'team_leader' AND team_id = $1 AND is_active = TRUE",
        [row.team_id]
      );
      
      for (const leader of leaders.rows) {
        sendContractExpiryEmail(
          leader.email, 
          leader.display_name, 
          row.pr_number, 
          row.title, 
          row.contract_number, 
          row.contractor_name, 
          row.final_end_date, 
          daysLeft
        );
      }
    }
  }
}

module.exports = { checkSLAs };
