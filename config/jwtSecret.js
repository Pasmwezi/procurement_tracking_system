const crypto = require('crypto');

function loadJwtSecret() {
    const configured = process.env.JWT_SECRET;
    if (configured && configured.length >= 32) return configured;
    if (process.env.NODE_ENV === 'production') {
        throw new Error('JWT_SECRET must be set to at least 32 characters in production');
    }
    return crypto.randomBytes(32).toString('hex');
}

module.exports = loadJwtSecret();
