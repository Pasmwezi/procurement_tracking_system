function isAwardMilestone(stepName, fileStatus) {
    if (fileStatus === 'Completed') return true;
    return typeof stepName === 'string' && /\baward(?:ed)?\b/i.test(stepName);
}

async function syncTriageAwardStatus(client, {
    fileId,
    stepName,
    fileStatus,
    userId = null,
    ipAddress = null,
    note = null
}) {
    if (!isAwardMilestone(stepName, fileStatus)) return [];

    const updated = await client.query(
        `UPDATE triage_files
         SET status = 'Awarded', updated_at = NOW()
         WHERE file_id = $1 AND status = 'Assigned'
         RETURNING id`,
        [fileId]
    );

    for (const row of updated.rows) {
        await client.query(
            `INSERT INTO triage_status_history
             (triage_file_id, from_status, to_status, changed_by, note)
             VALUES ($1, 'Assigned', 'Awarded', $2, $3)`,
            [row.id, userId, note || `Automatically synchronized at workflow step: ${stepName || 'Completed'}`]
        );
        await client.query(
            `INSERT INTO audit_log
             (user_id, action, entity_type, entity_id, old_value, new_value, ip_address)
             VALUES ($1, 'triage.status_change', 'triage_file', $2, $3, $4, $5)`,
            [
                userId,
                row.id,
                JSON.stringify({ status: 'Assigned' }),
                JSON.stringify({ status: 'Awarded', source: 'file_progress', file_id: fileId, step_name: stepName }),
                ipAddress
            ]
        );
    }

    return updated.rows.map(row => row.id);
}

async function reconcileAssignedTriageAwards(client, {
    userId = null,
    ipAddress = null,
    note = 'Reconciled from linked file progression'
} = {}) {
    const candidates = await client.query(
        `SELECT tf.file_id, f.status AS file_status, ps.step_name
         FROM triage_files tf
         JOIN files f ON f.id = tf.file_id
         LEFT JOIN process_steps ps ON ps.id = f.current_step_id
         WHERE tf.status = 'Assigned'
           AND (f.status = 'Completed' OR ps.step_name ~* '(^|[^[:alnum:]_])award(ed)?([^[:alnum:]_]|$)')
         FOR UPDATE OF tf`
    );

    const updatedIds = [];
    for (const candidate of candidates.rows) {
        const ids = await syncTriageAwardStatus(client, {
            fileId: candidate.file_id,
            stepName: candidate.step_name,
            fileStatus: candidate.file_status,
            userId,
            ipAddress,
            note
        });
        updatedIds.push(...ids);
    }
    return updatedIds;
}

module.exports = { isAwardMilestone, syncTriageAwardStatus, reconcileAssignedTriageAwards };
