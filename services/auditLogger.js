const pool = require('../db/pool');

/**
 * Log an action to the audit_log table.
 * 
 * @param {Object} params
 * @param {number} params.userId - the ID of the user performing the action
 * @param {string} params.action - string describing the action (e.g., 'file.create', 'file.assign')
 * @param {string} params.entityType - the type of entity (e.g., 'file', 'triage_file', 'contract')
 * @param {number} params.entityId - the ID of the entity
 * @param {Object} [params.oldValue] - previous state (optional)
 * @param {Object} [params.newValue] - new state (optional)
 * @param {string} [params.ipAddress] - IP address of the requester (optional)
 */
async function logAction({ userId, action, entityType, entityId, oldValue = null, newValue = null, ipAddress = null }) {
    try {
        await pool.query(`
            INSERT INTO audit_log 
            (user_id, action, entity_type, entity_id, old_value, new_value, ip_address)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
        `, [
            userId,
            action,
            entityType,
            entityId,
            oldValue ? JSON.stringify(oldValue) : null,
            newValue ? JSON.stringify(newValue) : null,
            ipAddress
        ]);
    } catch (err) {
        console.error('[Audit Logger] Failed to insert audit log:', err.message);
        // Do not throw; we typically don't want an audit log failure to break the main request
    }
}

module.exports = {
    logAction
};
