const pool = require('../db/pool');
const { sendOverdueEmail, sendContractExpiryEmail } = require('./emailService');

async function createNotificationForCurrentOwner(db, {
  fileId,
  expectedOfficerId,
  expectedStepId,
  contractId = null,
  message,
  buildMessage,
  notificationKind,
  requireActive = false,
  afterInsert
}) {
  if (!['step', 'contract'].includes(notificationKind)) {
    throw new Error('Unsupported notification kind');
  }

  let client;
  let transactionStarted = false;
  try {
    client = await db.connect();
    await client.query('BEGIN');
    transactionStarted = true;

    const current = notificationKind === 'contract'
      ? await client.query(
        `SELECT f.id AS file_id, f.pr_number, f.title, f.officer_id, f.current_step_id,
                u.display_name AS officer_name, u.email, u.team_id,
                c.id AS contract_id, c.contract_number, c.contractor_name,
                COALESCE(c.amended_end_date, c.end_date) AS final_end_date
         FROM contracts c
         JOIN files f ON f.id = c.file_id
         JOIN users u ON u.id = f.officer_id
         WHERE c.id = $1
           AND f.id = $2
           AND f.officer_id = $3
           AND f.current_step_id IS NOT DISTINCT FROM $4
           AND COALESCE(c.amended_end_date, c.end_date)
               BETWEEN NOW() AND NOW() + INTERVAL '30 days'
         FOR UPDATE OF c, f`,
        [contractId, fileId, expectedOfficerId, expectedStepId]
      )
      : await client.query(
        `SELECT f.id AS file_id, f.officer_id, f.current_step_id,
                u.display_name AS officer_name, u.email, u.team_id
         FROM files f
         JOIN users u ON u.id = f.officer_id
         WHERE f.id = $1
           AND f.officer_id = $2
           AND f.current_step_id IS NOT DISTINCT FROM $3
           ${requireActive ? "AND f.status = 'Active'" : ''}
         FOR UPDATE OF f`,
        [fileId, expectedOfficerId, expectedStepId]
      );

    if (current.rowCount === 0) {
      await client.query('COMMIT');
      transactionStarted = false;
      return null;
    }

    const existing = notificationKind === 'step'
      ? await client.query(
        'SELECT id FROM notifications WHERE file_id = $1 AND step_id = $2',
        [fileId, expectedStepId]
      )
      : await client.query(
        'SELECT id FROM notifications WHERE contract_id = $1',
        [contractId]
      );

    if (existing.rowCount > 0) {
      await client.query('COMMIT');
      transactionStarted = false;
      return null;
    }

    const owner = current.rows[0];
    const notificationMessage = buildMessage ? buildMessage(owner) : message;
    const inserted = await client.query(
      `INSERT INTO notifications (file_id, officer_id, step_id, message, contract_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [fileId, owner.officer_id, expectedStepId, notificationMessage, contractId]
    );

    if (afterInsert) await afterInsert(owner, client);

    await client.query('COMMIT');
    transactionStarted = false;
    return { id: inserted.rows[0].id, owner, message: notificationMessage };
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (client) client.release();
  }
}

async function runSlaChecks(db) {
  console.log('[SLA] Checking for overdue steps...');

  const result = await db.query(`
    SELECT f.id AS file_id, f.pr_number, f.title, f.officer_id, f.current_step_id,
           f.step_started_at, ps.step_name, ps.sla_days
    FROM files f
    JOIN process_steps ps ON ps.id = f.current_step_id
    WHERE f.status = 'Active'
      AND ps.sla_days > 0
      AND (
        CASE
          WHEN EXTRACT(DOW FROM (f.step_started_at + (ps.sla_days || ' days')::interval)) = 6
            THEN f.step_started_at + (ps.sla_days + 2 || ' days')::interval
          WHEN EXTRACT(DOW FROM (f.step_started_at + (ps.sla_days || ' days')::interval)) = 0
            THEN f.step_started_at + (ps.sla_days + 1 || ' days')::interval
          ELSE f.step_started_at + (ps.sla_days || ' days')::interval
        END
      ) < NOW()
  `);

  console.log(`[SLA] Found ${result.rows.length} overdue file(s)`);

  for (const row of result.rows) {
    const daysOverdue = Math.floor(
      (Date.now() - new Date(row.step_started_at).getTime()) / (1000 * 60 * 60 * 24)
    ) - row.sla_days;

    const notification = await createNotificationForCurrentOwner(db, {
      fileId: row.file_id,
      expectedOfficerId: row.officer_id,
      expectedStepId: row.current_step_id,
      notificationKind: 'step',
      requireActive: true,
      buildMessage: owner => `⚠️ OVERDUE: File "${row.pr_number} - ${row.title}" is ${daysOverdue} day(s) overdue on step "${row.step_name}" (SLA: ${row.sla_days} days). Assigned to ${owner.officer_name}.`,
      afterInsert: (owner, client) => sendOverdueEmail(
        owner.email,
        owner.officer_name,
        row.pr_number,
        row.title,
        row.step_name,
        daysOverdue,
        client
      )
    });

    if (notification) {
      console.log(`[SLA] Notification created for file ${row.pr_number}: ${notification.message}`);
    }
  }

  console.log('[SLA] Checking for expiring contracts...');

  const contractResult = await db.query(`
    SELECT c.id AS contract_id, c.contract_number, c.contractor_name,
           COALESCE(c.amended_end_date, c.end_date) AS final_end_date,
           f.id AS file_id, f.pr_number, f.title, f.officer_id, f.current_step_id
    FROM contracts c
    JOIN files f ON f.id = c.file_id
    WHERE COALESCE(c.amended_end_date, c.end_date) BETWEEN NOW() AND NOW() + INTERVAL '30 days'
  `);

  console.log(`[SLA] Found ${contractResult.rows.length} expiring contract(s)`);

  for (const row of contractResult.rows) {
    const daysLeftFor = contract => Math.ceil((new Date(contract.final_end_date).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

    const notification = await createNotificationForCurrentOwner(db, {
      fileId: row.file_id,
      expectedOfficerId: row.officer_id,
      expectedStepId: row.current_step_id,
      contractId: row.contract_id,
      notificationKind: 'contract',
      buildMessage: contract => `⏳ Expiring Contract: Contract ${contract.contract_number || 'for file ' + contract.pr_number} expires in ${daysLeftFor(contract)} days.`,
      afterInsert: async (owner, client) => {
        const leaders = await client.query(
          "SELECT email, display_name FROM users WHERE role = 'team_leader' AND team_id = $1 AND is_active = TRUE",
          [owner.team_id]
        );
        for (const leader of leaders.rows) {
          await sendContractExpiryEmail(
            leader.email,
            leader.display_name,
            owner.pr_number,
            owner.title,
            owner.contract_number,
            owner.contractor_name,
            owner.final_end_date,
            daysLeftFor(owner),
            client
          );
        }
      }
    });

    if (notification) {
      console.log(`[SLA] Notification created for expiring contract: ${notification.message}`);
    }
  }
}

let activeSlaCheck = null;
function checkSLAs(db = pool) {
  if (!activeSlaCheck) {
    activeSlaCheck = runSlaChecks(db).finally(() => {
      activeSlaCheck = null;
    });
  }
  return activeSlaCheck;
}

module.exports = { checkSLAs, createNotificationForCurrentOwner };
