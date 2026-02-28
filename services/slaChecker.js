const pool = require('../db/pool');
const { sendOverdueEmail } = require('./emailService');

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
}

module.exports = { checkSLAs };
