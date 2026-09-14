function numeric(value, minimum = 0, exclusive = false) {
    if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return false;
    const n = Number(value);
    return Number.isFinite(n) && (exclusive ? n > minimum : n >= minimum);
}
module.exports = { numeric };
