const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const JWT_SECRET = process.env.JWT_SECRET || 'file-tracker-secret-key-change-in-production';

async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);

        // Always fetch fresh user data to ensure role and team_id are up-to-date
        // and to handle older tokens that didn't include teamId
        const userRes = await pool.query('SELECT id, role, team_id, is_active FROM users WHERE id = $1', [decoded.id]);

        if (userRes.rows.length === 0 || !userRes.rows[0].is_active) {
            return res.status(401).json({ error: 'Account inactive or deleted' });
        }

        const user = userRes.rows[0];
        req.user = {
            id: user.id,
            role: user.role,
            teamId: user.team_id
        };

        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Higher-order middleware: restrict to specific roles
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        next();
    };
}

module.exports = { requireAuth, requireRole };
