const pool = require('../db/pool');

async function canAccessFile(user, fileId, db = pool) {
    if (user.role === 'admin') return true;
    const result = await db.query(
        `SELECT f.officer_id, u.team_id
         FROM files f JOIN users u ON u.id = f.officer_id
         WHERE f.id = $1`,
        [fileId]
    );
    if (!result.rows.length) return false;
    if (user.role === 'officer') return result.rows[0].officer_id === user.id;
    if (user.role === 'team_leader') return Boolean(user.teamId) && result.rows[0].team_id === user.teamId;
    return false;
}

async function canAccessContract(user, contractId, db = pool) {
    const result = await db.query('SELECT file_id FROM contracts WHERE id = $1', [contractId]);
    return result.rows.length > 0 && canAccessFile(user, result.rows[0].file_id, db);
}

module.exports = { canAccessFile, canAccessContract };
