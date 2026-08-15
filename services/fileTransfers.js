class TransferValidationError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'TransferValidationError';
        this.statusCode = statusCode;
    }
}

function positiveInteger(value, label) {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new TransferValidationError(`${label} must be a positive integer`);
    }
    return parsed;
}

function normalizeTransfers(fromOfficerId, transfers) {
    const sourceId = positiveInteger(fromOfficerId, 'Source officer ID');
    if (!Array.isArray(transfers) || transfers.length === 0) {
        throw new TransferValidationError('At least one file transfer is required');
    }
    if (transfers.length > 100) {
        throw new TransferValidationError('No more than 100 files can be transferred at once');
    }

    const seenFileIds = new Set();
    return transfers.map((transfer) => {
        const fileId = positiveInteger(transfer && transfer.file_id, 'File ID');
        const toOfficerId = positiveInteger(transfer && transfer.to_officer_id, 'Target officer ID');
        if (toOfficerId === sourceId) {
            throw new TransferValidationError('Target officer must be different from the source officer');
        }
        if (seenFileIds.has(fileId)) {
            throw new TransferValidationError(`File ${fileId} was included more than once`);
        }
        seenFileIds.add(fileId);
        return { fileId, toOfficerId };
    });
}

async function executeFileTransfers(pool, { fromOfficerId, transfers, userId, ipAddress = null }) {
    const sourceId = positiveInteger(fromOfficerId, 'Source officer ID');
    const normalized = normalizeTransfers(sourceId, transfers);
    const fileIds = normalized.map(item => item.fileId);
    const targetIds = [...new Set(normalized.map(item => item.toOfficerId))];
    const client = await pool.connect();
    let transactionStarted = false;

    try {
        await client.query('BEGIN');
        transactionStarted = true;

        const sourceResult = await client.query(
            "SELECT id, email, display_name AS name FROM users WHERE id = $1 AND role = 'officer' AND is_active = TRUE FOR SHARE",
            [sourceId]
        );
        if (sourceResult.rowCount === 0) {
            throw new TransferValidationError('Source officer was not found or is inactive', 404);
        }

        const targetResult = await client.query(
            "SELECT id, email, display_name AS name FROM users WHERE id = ANY($1::int[]) AND role = 'officer' AND is_active = TRUE FOR SHARE",
            [targetIds]
        );
        const targetsById = new Map(targetResult.rows.map(row => [row.id, row]));
        if (targetsById.size !== targetIds.length) {
            throw new TransferValidationError('Every transfer target must be an active officer');
        }

        const fileResult = await client.query(
            `SELECT id, pr_number, title, process_name, officer_id, status
             FROM files WHERE id = ANY($1::int[]) FOR UPDATE`,
            [fileIds]
        );
        const filesById = new Map(fileResult.rows.map(row => [row.id, row]));
        for (const transfer of normalized) {
            const file = filesById.get(transfer.fileId);
            if (!file) throw new TransferValidationError(`File ${transfer.fileId} was not found`, 404);
            if (file.officer_id !== sourceId) {
                throw new TransferValidationError(`File ${transfer.fileId} is no longer assigned to the source officer`, 409);
            }
            if (file.status !== 'Active') {
                throw new TransferValidationError(`File ${transfer.fileId} is not active`, 409);
            }
        }

        const transferred = [];
        for (const transfer of normalized) {
            const previous = filesById.get(transfer.fileId);
            const updated = await client.query(
                `UPDATE files SET officer_id = $1
                 WHERE id = $2 AND officer_id = $3 AND status = 'Active'
                 RETURNING id, pr_number, title, process_name`,
                [transfer.toOfficerId, transfer.fileId, sourceId]
            );
            if (updated.rowCount !== 1) {
                throw new TransferValidationError(`File ${transfer.fileId} changed during transfer; no files were transferred`, 409);
            }

            await client.query(
                'UPDATE notifications SET officer_id = $1 WHERE file_id = $2 AND officer_id = $3 AND is_read = FALSE',
                [transfer.toOfficerId, transfer.fileId, sourceId]
            );
            await client.query(
                `INSERT INTO audit_log
                 (user_id, action, entity_type, entity_id, old_value, new_value, ip_address)
                 VALUES ($1, 'file.transfer', 'file', $2, $3, $4, $5)`,
                [
                    userId,
                    transfer.fileId,
                    JSON.stringify({ officer_id: sourceId, officer_name: sourceResult.rows[0].name }),
                    JSON.stringify({ officer_id: transfer.toOfficerId, officer_name: targetsById.get(transfer.toOfficerId).name }),
                    ipAddress
                ]
            );
            transferred.push({ ...previous, ...updated.rows[0], to_officer_id: transfer.toOfficerId });
        }

        await client.query('COMMIT');
        transactionStarted = false;
        return {
            transferredCount: transferred.length,
            fromOfficer: sourceResult.rows[0],
            targetsById,
            transferred
        };
    } catch (error) {
        if (transactionStarted) await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { TransferValidationError, normalizeTransfers, executeFileTransfers };
