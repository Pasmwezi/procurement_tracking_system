/**
 * asyncWrap — wraps an async route handler and forwards any rejected promise
 * to Express's next(err) error pipeline instead of causing an unhandled
 * promise rejection crash.
 *
 * Usage:
 *   router.get('/path', asyncWrap(async (req, res) => { ... }));
 */
const asyncWrap = fn => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

module.exports = asyncWrap;
