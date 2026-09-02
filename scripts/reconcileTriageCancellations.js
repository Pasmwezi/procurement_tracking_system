const pool = require('../db/pool');
const { reconcileAssignedTriageCancellations } = require('../services/triageProgress');

async function main() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const updatedIds = await reconcileAssignedTriageCancellations(client);
        await client.query('COMMIT');
        console.log(JSON.stringify({ reconciled: updatedIds.length }));
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => {
    console.error(`Triage cancellation reconciliation failed: ${error.message}`);
    process.exit(1);
});
