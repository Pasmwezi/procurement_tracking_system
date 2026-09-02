async function lockActiveFileForAdvancement(client, fileId) {
    const result = await client.query(
        `SELECT f.*, ps.step_order, ps.process_name
         FROM files f
         JOIN process_steps ps ON ps.id = f.current_step_id
         WHERE f.id = $1
         FOR UPDATE OF f`,
        [fileId]
    );

    if (result.rows.length === 0) throw new Error('File not found');
    if (result.rows[0].status !== 'Active') {
        throw new Error('Only active files can be advanced');
    }
    return result.rows[0];
}

async function updateActiveFileProgress(client, {
    fileId,
    currentStepId,
    startedAt,
    status,
    completedAt
}) {
    const result = await client.query(
        `UPDATE files
         SET current_step_id = $1,
             step_started_at = $2,
             status = $3,
             completed_at = $4
         WHERE id = $5 AND status = 'Active'
         RETURNING id`,
        [currentStepId, startedAt, status, completedAt, fileId]
    );

    if (result.rowCount !== 1) throw new Error('File is no longer active');
    return result.rows[0];
}

module.exports = {
    lockActiveFileForAdvancement,
    updateActiveFileProgress
};
