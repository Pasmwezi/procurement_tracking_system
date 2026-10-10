const PG5_REVISION = 'v5-team-leadership';

const expectedColumns = {
    schema_migrations: {
        revision: ['text', 'NO'], applied_at: ['timestamp with time zone', 'NO']
    },
    users: { officer_classification: ['character varying', 'YES'] },
    triage_files: {
        value_classification: ['character varying', 'YES'], complexity: ['character varying', 'YES'],
        recommended_classification: ['character varying', 'YES'],
        assigned_officer_classification: ['character varying', 'YES'], assignment_override_rationale: ['text', 'YES']
    },
    pg5_reviews: {
        id: ['integer', 'NO'], file_id: ['integer', 'NO'], gate: ['character varying', 'NO'],
        status: ['character varying', 'NO'], submitted_by: ['integer', 'NO'], decided_by: ['integer', 'YES'],
        submission_note: ['text', 'YES'], decision_note: ['text', 'YES'],
        submitted_at: ['timestamp without time zone', 'NO'], decided_at: ['timestamp without time zone', 'YES'],
        updated_at: ['timestamp without time zone', 'NO']
    },
    weekly_checkins: {
        id: ['integer', 'NO'], officer_id: ['integer', 'NO'], team_id: ['integer', 'NO'],
        week_start: ['date', 'NO'], operational_summary: ['text', 'NO'], blockers: ['text', 'YES'],
        decisions: ['text', 'YES'], actions: ['text', 'YES'], created_by: ['integer', 'NO'],
        updated_by: ['integer', 'NO'], created_at: ['timestamp without time zone', 'NO'],
        updated_at: ['timestamp without time zone', 'NO']
    },
    business_owner_actions: {
        id: ['integer', 'NO'], file_id: ['integer', 'YES'], team_id: ['integer', 'NO'],
        business_owner: ['character varying', 'NO'], action_month: ['date', 'NO'], action: ['text', 'NO'],
        due_date: ['date', 'YES'], completed_at: ['timestamp without time zone', 'YES'],
        created_by: ['integer', 'NO'], updated_by: ['integer', 'NO'],
        created_at: ['timestamp without time zone', 'NO'], updated_at: ['timestamp without time zone', 'NO']
    },
    performance_checkpoints: {
        id: ['integer', 'NO'], officer_id: ['integer', 'NO'], team_id: ['integer', 'NO'],
        year: ['integer', 'NO'], checkpoint_type: ['character varying', 'NO'], due_date: ['date', 'NO'],
        completion_date: ['date', 'YES'], hr_record_date: ['date', 'YES'], followup_date: ['date', 'YES'],
        created_by: ['integer', 'NO'], updated_by: ['integer', 'NO'],
        created_at: ['timestamp without time zone', 'NO'], updated_at: ['timestamp without time zone', 'NO']
    }
};

const expectedDefaults = {
    'schema_migrations.applied_at': 'now()',
    'pg5_reviews.id': "nextval('pg5_reviews_id_seq'::regclass)",
    'pg5_reviews.status': "'submitted'::character varying",
    'pg5_reviews.submitted_at': 'now()',
    'pg5_reviews.updated_at': 'now()',
    'weekly_checkins.id': "nextval('weekly_checkins_id_seq'::regclass)",
    'weekly_checkins.created_at': 'now()',
    'weekly_checkins.updated_at': 'now()',
    'business_owner_actions.id': "nextval('business_owner_actions_id_seq'::regclass)",
    'business_owner_actions.created_at': 'now()',
    'business_owner_actions.updated_at': 'now()',
    'performance_checkpoints.id': "nextval('performance_checkpoints_id_seq'::regclass)",
    'performance_checkpoints.created_at': 'now()',
    'performance_checkpoints.updated_at': 'now()'
};

const expectedSerialSequences = {
    'pg5_reviews.id': 'public.pg5_reviews_id_seq',
    'weekly_checkins.id': 'public.weekly_checkins_id_seq',
    'business_owner_actions.id': 'public.business_owner_actions_id_seq',
    'performance_checkpoints.id': 'public.performance_checkpoints_id_seq'
};

const expectedConstraints = {
    users_officer_classification_check: ['c', "CHECK (((officer_classification IS NULL) OR ((officer_classification)::text = ANY ((ARRAY['PG-2'::character varying, 'PG-3'::character varying, 'PG-4'::character varying])::text[]))))"],
    triage_value_classification_check: ['c', "CHECK (((value_classification IS NULL) OR ((value_classification)::text = ANY ((ARRAY['Low'::character varying, 'High'::character varying])::text[]))))"],
    triage_complexity_check: ['c', "CHECK (((complexity IS NULL) OR ((complexity)::text = ANY ((ARRAY['Low'::character varying, 'High'::character varying])::text[]))))"],
    triage_recommended_classification_check: ['c', "CHECK (((recommended_classification IS NULL) OR ((recommended_classification)::text = ANY ((ARRAY['PG-2'::character varying, 'PG-3'::character varying, 'PG-4'::character varying])::text[]))))"],
    triage_assigned_classification_check: ['c', "CHECK (((assigned_officer_classification IS NULL) OR ((assigned_officer_classification)::text = ANY ((ARRAY['PG-2'::character varying, 'PG-3'::character varying, 'PG-4'::character varying])::text[]))))"],
    triage_override_rationale_check: ['c', "CHECK (((recommended_classification IS NULL) OR ((assigned_officer_classification)::text = (recommended_classification)::text) OR (NULLIF(btrim(assignment_override_rationale), ''::text) IS NOT NULL)))"],
    pg5_reviews_pkey: ['p', 'PRIMARY KEY (id)'],
    pg5_reviews_file_id_fkey: ['f', 'FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE'],
    pg5_reviews_submitted_by_fkey: ['f', 'FOREIGN KEY (submitted_by) REFERENCES users(id)'],
    pg5_reviews_decided_by_fkey: ['f', 'FOREIGN KEY (decided_by) REFERENCES users(id)'],
    pg5_reviews_gate_check: ['c', "CHECK (((gate)::text = ANY ((ARRAY['strategy'::character varying, 'pre-solicitation'::character varying, 'addendum'::character varying, 'evaluation approach'::character varying, 'pre-award'::character varying, 'amendment'::character varying, 'change order'::character varying, 'extension of time'::character varying, 'payment/holdback'::character varying, 'close-out'::character varying, 'other'::character varying])::text[])))"],
    pg5_reviews_status_check: ['c', "CHECK (((status)::text = ANY ((ARRAY['submitted'::character varying, 'reviewing'::character varying, 'returned'::character varying, 'resubmitted'::character varying, 'cleared'::character varying, 'conditionally cleared'::character varying, 'escalated'::character varying])::text[])))"],
    weekly_checkins_pkey: ['p', 'PRIMARY KEY (id)'],
    weekly_checkins_officer_id_fkey: ['f', 'FOREIGN KEY (officer_id) REFERENCES users(id) ON DELETE CASCADE'],
    weekly_checkins_team_id_fkey: ['f', 'FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE'],
    weekly_checkins_created_by_fkey: ['f', 'FOREIGN KEY (created_by) REFERENCES users(id)'],
    weekly_checkins_updated_by_fkey: ['f', 'FOREIGN KEY (updated_by) REFERENCES users(id)'],
    weekly_checkins_officer_id_week_start_key: ['u', 'UNIQUE (officer_id, week_start)'],
    business_owner_actions_pkey: ['p', 'PRIMARY KEY (id)'],
    business_owner_actions_file_id_fkey: ['f', 'FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE SET NULL'],
    business_owner_actions_team_id_fkey: ['f', 'FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE'],
    business_owner_actions_created_by_fkey: ['f', 'FOREIGN KEY (created_by) REFERENCES users(id)'],
    business_owner_actions_updated_by_fkey: ['f', 'FOREIGN KEY (updated_by) REFERENCES users(id)'],
    performance_checkpoints_pkey: ['p', 'PRIMARY KEY (id)'],
    performance_checkpoints_officer_id_fkey: ['f', 'FOREIGN KEY (officer_id) REFERENCES users(id) ON DELETE CASCADE'],
    performance_checkpoints_team_id_fkey: ['f', 'FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE'],
    performance_checkpoints_created_by_fkey: ['f', 'FOREIGN KEY (created_by) REFERENCES users(id)'],
    performance_checkpoints_updated_by_fkey: ['f', 'FOREIGN KEY (updated_by) REFERENCES users(id)'],
    performance_checkpoints_year_check: ['c', 'CHECK (((year >= 2000) AND (year <= 2200)))'],
    performance_checkpoints_checkpoint_type_check: ['c', "CHECK (((checkpoint_type)::text = ANY ((ARRAY['objective-setting'::character varying, 'mid-year'::character varying, 'year-end'::character varying])::text[])))"],
    performance_checkpoints_officer_id_year_checkpoint_type_key: ['u', 'UNIQUE (officer_id, year, checkpoint_type)']
};

const expectedIndexes = {
    idx_pg5_reviews_file: ['pg5_reviews', '(file_id)'],
    idx_pg5_reviews_status: ['pg5_reviews', '(status, updated_at DESC)'],
    uq_pg5_reviews_active_gate: ['pg5_reviews', 'UNIQUE', '(file_id, gate)', 'submitted', 'reviewing', 'returned', 'resubmitted'],
    idx_weekly_checkins_team_week: ['weekly_checkins', '(team_id, week_start DESC)'],
    idx_business_owner_actions_team_month: ['business_owner_actions', '(team_id, action_month DESC)'],
    idx_performance_checkpoints_team_due: ['performance_checkpoints', '(team_id, due_date)']
};

function fail(details) {
    throw new Error(`PG-5 schema validation failed: ${details.join('; ')}`);
}

function expectedConstraintTable(name) {
    if (name.startsWith('users_')) return 'users';
    if (name.startsWith('triage_')) return 'triage_files';
    if (name.startsWith('pg5_reviews_')) return 'pg5_reviews';
    if (name.startsWith('weekly_checkins_')) return 'weekly_checkins';
    if (name.startsWith('business_owner_actions_')) return 'business_owner_actions';
    if (name.startsWith('performance_checkpoints_')) return 'performance_checkpoints';
    throw new Error(`No expected table configured for constraint ${name}`);
}

async function validatePg5Schema(db, { requireRevision = false } = {}) {
    const tableNames = Object.keys(expectedColumns);
    const columns = await db.query(
        `SELECT table_name, column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema='public' AND table_name = ANY($1::text[])`,
        [tableNames]
    );
    const actualColumns = new Map(columns.rows.map(row => [`${row.table_name}.${row.column_name}`, row]));
    const errors = [];
    for (const [table, definitions] of Object.entries(expectedColumns)) {
        for (const [column, [type, nullable]] of Object.entries(definitions)) {
            const actual = actualColumns.get(`${table}.${column}`);
            if (!actual) errors.push(`missing ${table}.${column}`);
            else if (actual.data_type !== type || actual.is_nullable !== nullable) {
                errors.push(`invalid ${table}.${column}`);
            }
            const expectedDefault = expectedDefaults[`${table}.${column}`];
            if (actual && expectedDefault !== undefined && actual.column_default !== expectedDefault) {
                errors.push(`invalid default ${table}.${column}`);
            }
        }
    }

    for (const [key, expectedSequence] of Object.entries(expectedSerialSequences)) {
        const [table, column] = key.split('.');
        const sequence = await db.query(
            'SELECT pg_get_serial_sequence($1, $2) AS sequence_name',
            [`public.${table}`, column]
        );
        if (sequence.rows[0]?.sequence_name !== expectedSequence) {
            errors.push(`invalid sequence ownership ${key}`);
        }
    }

    const constraints = await db.query(
        `SELECT t.relname AS table_name, c.conname, c.contype,
                pg_get_constraintdef(c.oid) AS definition
         FROM pg_constraint c
         JOIN pg_namespace n ON n.oid=c.connamespace
         JOIN pg_class t ON t.oid=c.conrelid
         WHERE n.nspname='public' AND c.conname = ANY($1::text[])`,
        [Object.keys(expectedConstraints)]
    );
    const actualConstraints = new Map(
        constraints.rows.map(row => [`${row.table_name}.${row.conname}`, row])
    );
    const normalize = value => value.replace(/\s+/g, ' ').trim();
    for (const [name, [type, expectedDefinition]] of Object.entries(expectedConstraints)) {
        const table = expectedConstraintTable(name);
        const actual = actualConstraints.get(`${table}.${name}`);
        if (!actual) errors.push(`missing constraint ${name}`);
        else if (actual.contype !== type || normalize(actual.definition) !== normalize(expectedDefinition)) {
            errors.push(`invalid constraint ${name}`);
        }
    }

    const indexes = await db.query(
        `SELECT tablename, indexname, indexdef FROM pg_indexes
         WHERE schemaname='public' AND indexname = ANY($1::text[])`,
        [Object.keys(expectedIndexes)]
    );
    const actualIndexes = new Map(indexes.rows.map(row => [row.indexname, row]));
    for (const [name, [table, ...tokens]] of Object.entries(expectedIndexes)) {
        const actual = actualIndexes.get(name);
        if (!actual) errors.push(`missing index ${name}`);
        else if (actual.tablename !== table || tokens.some(token => !actual.indexdef.includes(token))) {
            errors.push(`invalid index ${name}`);
        }
    }

    if (requireRevision) {
        const revision = await db.query('SELECT 1 FROM schema_migrations WHERE revision=$1', [PG5_REVISION]);
        if (!revision.rowCount) errors.push(`missing revision ${PG5_REVISION}`);
    }
    if (errors.length) fail(errors);
    return true;
}

async function recordSchemaRevision(db) {
    await db.query(
        `INSERT INTO schema_migrations(revision) VALUES($1)
         ON CONFLICT (revision) DO NOTHING`,
        [PG5_REVISION]
    );
}

module.exports = { PG5_REVISION, validatePg5Schema, recordSchemaRevision };
