const jwt = require('jsonwebtoken');
const pool = require('../db/pool');
const JWT_SECRET = require('../config/jwtSecret');

async function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.purpose !== 'access') return res.status(401).json({ error: 'Invalid token purpose' });

        // Always fetch fresh user data to ensure role and team_id are up-to-date
        // and to handle older tokens that didn't include teamId
        const userRes = await pool.query('SELECT id, role, team_id, is_active, token_version FROM users WHERE id = $1', [decoded.id]);

        if (userRes.rows.length === 0 || !userRes.rows[0].is_active) {
            return res.status(401).json({ error: 'Account inactive or deleted' });
        }

        const user = userRes.rows[0];
        if (!Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion !== user.token_version) {
            return res.status(401).json({ error: 'Session revoked' });
        }
        req.user = {
            id: user.id,
            role: user.role,
            teamId: user.team_id
        };

        next();
    } catch (err) {
        if (err.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
        }
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

// Higher-order middleware: restrict to specific roles
function requireRole(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Insufficient permissions' });
        }
        if (req.user.role === 'team_leader' && !req.user.teamId) {
            return res.status(403).json({ error: 'Team assignment required' });
        }
        next();
    };
}

module.exports = { requireAuth, requireRole };
