async function setUserActive(pool, { userId, isActive, teamId = null, requiredRole = null, blockAnyAssigned = false }) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const params = [userId];
        let scope = '';
        if (teamId !== null && teamId !== undefined) {
            params.push(teamId);
            scope = ` AND team_id = $${params.length}`;
        }
        if (requiredRole) {
            params.push(requiredRole);
            scope += ` AND role = $${params.length}`;
        }
        const user = await client.query(
            `SELECT id, role, team_id FROM users WHERE id = $1${scope} FOR UPDATE`,
            params
        );
        if (!user.rowCount) {
            const error = new Error('User not found');
            error.statusCode = 404;
            throw error;
        }

        if (isActive && user.rows[0].role !== 'admin' && !user.rows[0].team_id) {
            const error = new Error('Officers and team leaders require a team assignment before activation');
            error.statusCode = 409;
            throw error;
        }

        if (!isActive) {
            const files = await client.query(
                `SELECT 1 FROM files WHERE officer_id = $1${blockAnyAssigned ? '' : " AND status = 'Active'"} LIMIT 1`,
                [userId]
            );
            if (files.rowCount) {
                const error = new Error('Cannot deactivate user with active files. Transfer files first.');
                error.statusCode = blockAnyAssigned ? 409 : 400;
                throw error;
            }
        }

        const result = await client.query(
            `UPDATE users
             SET is_active = $1,
                 token_version = token_version + CASE WHEN $1 = FALSE THEN 1 ELSE 0 END,
                 updated_at = NOW()
             WHERE id = $2
             RETURNING id, is_active, token_version`,
            [isActive, userId]
        );
        await client.query('COMMIT');
        return result.rows[0];
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
    }
}

module.exports = { setUserActive };
