-- =============================================
-- v3.0 Migration: Triage Feature for Team Leaders
-- Run this ONCE against an existing v2 database
-- =============================================

BEGIN;

-- 1. Triage files table
CREATE TABLE IF NOT EXISTS triage_files (
    id SERIAL PRIMARY KEY,
    pr_number VARCHAR(100) NOT NULL UNIQUE,
    title VARCHAR(500) NOT NULL,
    team_id INTEGER REFERENCES teams(id) ON DELETE SET NULL,
    estimated_value DECIMAL(15,2),
    business_owner VARCHAR(300) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'Triaged'
        CHECK (status IN ('Triaged', 'Missing Document(s)', 'Assigned', 'Awarded', 'Cancelled')),
    file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    doc_deadline TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- 2. Missing documents table
CREATE TABLE IF NOT EXISTS triage_missing_docs (
    id SERIAL PRIMARY KEY,
    triage_file_id INTEGER NOT NULL REFERENCES triage_files(id) ON DELETE CASCADE,
    document_name VARCHAR(300) NOT NULL,
    provided BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW()
);

-- 3. Indexes
CREATE INDEX IF NOT EXISTS idx_triage_files_status ON triage_files(status);
CREATE INDEX IF NOT EXISTS idx_triage_files_team ON triage_files(team_id);
CREATE INDEX IF NOT EXISTS idx_triage_files_created_by ON triage_files(created_by);
CREATE INDEX IF NOT EXISTS idx_triage_missing_docs_file ON triage_missing_docs(triage_file_id);

COMMIT;
