-- PG-5 team-leadership expansion. Safe to run repeatedly.
CREATE TABLE IF NOT EXISTS schema_migrations (
    revision TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS officer_classification VARCHAR(4);

DO $$ BEGIN
    ALTER TABLE users ADD CONSTRAINT users_officer_classification_check
        CHECK (officer_classification IS NULL OR officer_classification IN ('PG-2', 'PG-3', 'PG-4'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE triage_files
    ADD COLUMN IF NOT EXISTS value_classification VARCHAR(4),
    ADD COLUMN IF NOT EXISTS complexity VARCHAR(4),
    ADD COLUMN IF NOT EXISTS recommended_classification VARCHAR(4),
    ADD COLUMN IF NOT EXISTS assigned_officer_classification VARCHAR(4),
    ADD COLUMN IF NOT EXISTS assignment_override_rationale TEXT;

DO $$ BEGIN
    ALTER TABLE triage_files ADD CONSTRAINT triage_value_classification_check
        CHECK (value_classification IS NULL OR value_classification IN ('Low', 'High'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE triage_files ADD CONSTRAINT triage_complexity_check
        CHECK (complexity IS NULL OR complexity IN ('Low', 'High'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE triage_files ADD CONSTRAINT triage_recommended_classification_check
        CHECK (recommended_classification IS NULL OR recommended_classification IN ('PG-2', 'PG-3', 'PG-4'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE triage_files ADD CONSTRAINT triage_assigned_classification_check
        CHECK (assigned_officer_classification IS NULL OR assigned_officer_classification IN ('PG-2', 'PG-3', 'PG-4'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
    ALTER TABLE triage_files ADD CONSTRAINT triage_override_rationale_check
        CHECK (
            recommended_classification IS NULL OR
            assigned_officer_classification = recommended_classification OR
            NULLIF(BTRIM(assignment_override_rationale), '') IS NOT NULL
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS pg5_reviews (
    id SERIAL PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    gate VARCHAR(40) NOT NULL CHECK (gate IN (
        'strategy', 'pre-solicitation', 'addendum', 'evaluation approach', 'pre-award',
        'amendment', 'change order', 'extension of time', 'payment/holdback', 'close-out', 'other'
    )),
    status VARCHAR(30) NOT NULL DEFAULT 'submitted' CHECK (status IN (
        'submitted', 'reviewing', 'returned', 'resubmitted', 'cleared',
        'conditionally cleared', 'escalated'
    )),
    submitted_by INTEGER NOT NULL REFERENCES users(id),
    decided_by INTEGER REFERENCES users(id),
    submission_note TEXT,
    decision_note TEXT,
    submitted_at TIMESTAMP NOT NULL DEFAULT NOW(),
    decided_at TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_pg5_reviews_file ON pg5_reviews(file_id);
CREATE INDEX IF NOT EXISTS idx_pg5_reviews_status ON pg5_reviews(status, updated_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pg5_reviews_active_gate
    ON pg5_reviews(file_id, gate)
    WHERE status IN ('submitted','reviewing','returned','resubmitted');

CREATE TABLE IF NOT EXISTS weekly_checkins (
    id SERIAL PRIMARY KEY,
    officer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    week_start DATE NOT NULL,
    operational_summary TEXT NOT NULL,
    blockers TEXT,
    decisions TEXT,
    actions TEXT,
    created_by INTEGER NOT NULL REFERENCES users(id),
    updated_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (officer_id, week_start)
);
ALTER TABLE weekly_checkins ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id);
UPDATE weekly_checkins SET updated_by = created_by WHERE updated_by IS NULL;
ALTER TABLE weekly_checkins ALTER COLUMN updated_by SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_weekly_checkins_team_week ON weekly_checkins(team_id, week_start DESC);

CREATE TABLE IF NOT EXISTS business_owner_actions (
    id SERIAL PRIMARY KEY,
    file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    business_owner VARCHAR(300) NOT NULL,
    action_month DATE NOT NULL,
    action TEXT NOT NULL,
    due_date DATE,
    completed_at TIMESTAMP,
    created_by INTEGER NOT NULL REFERENCES users(id),
    updated_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
ALTER TABLE business_owner_actions ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id);
UPDATE business_owner_actions SET updated_by = created_by WHERE updated_by IS NULL;
ALTER TABLE business_owner_actions ALTER COLUMN updated_by SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_business_owner_actions_team_month ON business_owner_actions(team_id, action_month DESC);

CREATE TABLE IF NOT EXISTS performance_checkpoints (
    id SERIAL PRIMARY KEY,
    officer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2200),
    checkpoint_type VARCHAR(30) NOT NULL CHECK (checkpoint_type IN ('objective-setting', 'mid-year', 'year-end')),
    due_date DATE NOT NULL,
    completion_date DATE,
    hr_record_date DATE,
    followup_date DATE,
    created_by INTEGER NOT NULL REFERENCES users(id),
    updated_by INTEGER NOT NULL REFERENCES users(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (officer_id, year, checkpoint_type)
);
ALTER TABLE performance_checkpoints ADD COLUMN IF NOT EXISTS updated_by INTEGER REFERENCES users(id);
UPDATE performance_checkpoints SET updated_by = created_by WHERE updated_by IS NULL;
ALTER TABLE performance_checkpoints ALTER COLUMN updated_by SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_performance_checkpoints_team_due ON performance_checkpoints(team_id, due_date);
