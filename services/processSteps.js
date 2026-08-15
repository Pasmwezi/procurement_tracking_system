class ProcessStepsValidationError extends Error {
    constructor(message, statusCode = 400) {
        super(message);
        this.name = 'ProcessStepsValidationError';
        this.statusCode = statusCode;
    }
}

function normalizeProcessSteps(steps) {
    if (!Array.isArray(steps) || steps.length === 0) {
        throw new ProcessStepsValidationError('At least one process step is required');
    }
    if (steps.length > 100) {
        throw new ProcessStepsValidationError('A process cannot contain more than 100 steps');
    }

    const existingIds = new Set();
    let cumulativeDays = 0;
    const normalized = steps.map((step, index) => {
        const stepName = typeof step?.step_name === 'string' ? step.step_name.trim() : '';
        if (!stepName) throw new ProcessStepsValidationError(`Step ${index + 1} must have a name`);
        if (stepName.length > 200) throw new ProcessStepsValidationError(`Step ${index + 1} name is too long`);

        let id = null;
        if (step.id !== undefined && step.id !== null && step.id !== '') {
            id = Number(step.id);
            if (!Number.isInteger(id) || id <= 0) {
                throw new ProcessStepsValidationError(`Step ${index + 1} ID must be a positive integer`);
            }
            if (existingIds.has(id)) throw new ProcessStepsValidationError(`Duplicate step ID ${id}`);
            existingIds.add(id);
        }

        const slaDays = Number(step.sla_days);
        if (!Number.isInteger(slaDays) || slaDays < 0 || slaDays > 3650) {
            throw new ProcessStepsValidationError(`Step ${index + 1} SLA must be a whole number from 0 to 3650 days`);
        }
        cumulativeDays += slaDays;

        return {
            id,
            stepName,
            slaDays,
            stepOrder: index + 1,
            cumulativeDays
        };
    });
    const completedIndexes = normalized
        .map((step, index) => /\bCompleted$/i.test(step.stepName) ? index : -1)
        .filter(index => index >= 0);
    if (completedIndexes.length !== 1) {
        throw new ProcessStepsValidationError('A process must contain exactly one terminal step whose name ends with Completed');
    }
    if (completedIndexes[0] !== normalized.length - 1) {
        throw new ProcessStepsValidationError('The step whose name ends with Completed must be the final step');
    }
    return normalized;
}

async function replaceProcessSteps(pool, { processName, steps, userId, ipAddress = null }) {
    const normalizedName = typeof processName === 'string' ? processName.trim() : '';
    if (!normalizedName) throw new ProcessStepsValidationError('Process name is required');
    const normalizedSteps = normalizeProcessSteps(steps);
    const client = await pool.connect();
    let transactionStarted = false;

    try {
        await client.query('BEGIN');
        transactionStarted = true;

        const processResult = await client.query(
            'SELECT name FROM processes WHERE name = $1 FOR UPDATE',
            [normalizedName]
        );
        if (processResult.rowCount === 0) {
            throw new ProcessStepsValidationError('Process not found', 404);
        }

        const existingResult = await client.query(
            'SELECT id, step_name, sla_days, cum_days, step_order FROM process_steps WHERE process_name = $1 ORDER BY step_order FOR UPDATE',
            [normalizedName]
        );
        const existingIds = new Set(existingResult.rows.map(row => row.id));
        for (const step of normalizedSteps) {
            if (step.id !== null && !existingIds.has(step.id)) {
                throw new ProcessStepsValidationError(`Step ID ${step.id} does not belong to this process`, 409);
            }
        }

        const incomingIds = new Set(normalizedSteps.filter(step => step.id !== null).map(step => step.id));
        const idsToDelete = [...existingIds].filter(id => !incomingIds.has(id));

        // Move existing rows out of the positive ordering range first so swaps
        // cannot violate UNIQUE(process_name, step_order) mid-transaction.
        await client.query(
            'UPDATE process_steps SET step_order = -id WHERE process_name = $1',
            [normalizedName]
        );

        if (idsToDelete.length > 0) {
            try {
                await client.query(
                    'DELETE FROM process_steps WHERE process_name = $1 AND id = ANY($2::int[])',
                    [normalizedName, idsToDelete]
                );
            } catch (error) {
                if (error.code === '23503') {
                    throw new ProcessStepsValidationError(
                        'Cannot delete a step referenced by a current file, notification, or file history. Keep the step and edit it instead.',
                        409
                    );
                }
                throw error;
            }
        }

        for (const step of normalizedSteps) {
            if (step.id !== null) {
                const updated = await client.query(
                    `UPDATE process_steps
                     SET step_name = $1, sla_days = $2, cum_days = $3, step_order = $4
                     WHERE id = $5 AND process_name = $6`,
                    [step.stepName, step.slaDays, step.cumulativeDays, step.stepOrder, step.id, normalizedName]
                );
                if (updated.rowCount !== 1) {
                    throw new ProcessStepsValidationError(`Step ID ${step.id} changed while it was being edited`, 409);
                }
            } else {
                await client.query(
                    `INSERT INTO process_steps (process_name, step_name, sla_days, cum_days, step_order)
                     VALUES ($1, $2, $3, $4, $5)`,
                    [normalizedName, step.stepName, step.slaDays, step.cumulativeDays, step.stepOrder]
                );
            }
        }

        const finalResult = await client.query(
            'SELECT id, process_name, step_name, sla_days, cum_days, step_order FROM process_steps WHERE process_name = $1 ORDER BY step_order',
            [normalizedName]
        );
        await client.query(
            `INSERT INTO audit_log
             (user_id, action, entity_type, entity_id, old_value, new_value, ip_address)
             VALUES ($1, 'process.steps_update', 'process', NULL, $2, $3, $4)`,
            [
                userId,
                JSON.stringify({ process_name: normalizedName, steps: existingResult.rows }),
                JSON.stringify({ process_name: normalizedName, steps: finalResult.rows }),
                ipAddress
            ]
        );

        await client.query('COMMIT');
        transactionStarted = false;
        return { success: true, steps: finalResult.rows };
    } catch (error) {
        if (transactionStarted) await client.query('ROLLBACK');
        if (error.code === '23503') {
            throw new ProcessStepsValidationError(
                'Cannot delete a step referenced by a current file, notification, or file history. Keep the step and edit it instead.',
                409
            );
        }
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { ProcessStepsValidationError, normalizeProcessSteps, replaceProcessSteps };
