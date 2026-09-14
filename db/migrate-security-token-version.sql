ALTER TABLE users
ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION increment_user_token_version()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.password_hash IS DISTINCT FROM NEW.password_hash THEN
        NEW.token_version := OLD.token_version + 1;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_password_revokes_sessions ON users;
CREATE TRIGGER users_password_revokes_sessions
BEFORE UPDATE OF password_hash ON users
FOR EACH ROW EXECUTE FUNCTION increment_user_token_version();
