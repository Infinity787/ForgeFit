-- ForgeFit schema for Supabase.
--
-- Accounts live in Supabase Auth (auth.users). Everything ForgeFit stores is
-- in the private `app` schema, which the Data API never exposes; only the
-- `api` Edge Function (connecting as the database owner) reads and writes it,
-- and it scopes every query to the signed-in user. Row Level Security is also
-- enabled on every table with no policies, so even a misconfigured grant
-- couldn't expose a row to the `anon` or `authenticated` roles.
--
-- Every user-owned table references auth.users ON DELETE CASCADE: deleting an
-- account deletes all of its data. Client-generated ids (client_id) make
-- offline-created and re-sent records idempotent via UNIQUE (user_id, client_id).

CREATE SCHEMA IF NOT EXISTS app;
REVOKE ALL ON SCHEMA app FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN REVOKE ALL ON SCHEMA app FROM anon; END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN REVOKE ALL ON SCHEMA app FROM authenticated; END IF;
END $$;

-- ---------------------------------------------------------------- account
CREATE TABLE app.accounts (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  username    TEXT NOT NULL UNIQUE CHECK (username ~ '^[a-z0-9_]{3,20}$'),
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  onboarded   BOOLEAN NOT NULL DEFAULT FALSE,
  split_type  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_accounts_email ON app.accounts (lower(email));

-- Keep the account's email in step with Supabase Auth (e.g. after an email change).
CREATE OR REPLACE FUNCTION app.sync_account_email() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE app.accounts SET email = NEW.email, updated_at = now() WHERE id = NEW.id AND email IS DISTINCT FROM NEW.email;
  RETURN NEW;
END $$;
CREATE TRIGGER forgefit_sync_account_email
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION app.sync_account_email();

-- ---------------------------------------------------------------- profile & targets
CREATE TABLE app.profiles (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  sex         TEXT CHECK (sex IN ('male', 'female')),
  age         INTEGER CHECK (age BETWEEN 10 AND 120),
  height_cm   NUMERIC(5,1) CHECK (height_cm BETWEEN 50 AND 300),
  weight_kg   NUMERIC(5,1) CHECK (weight_kg BETWEEN 20 AND 400),
  activity    TEXT,
  goal        TEXT CHECK (goal IN ('cut', 'maintain', 'bulk')),
  diet        TEXT CHECK (diet IN ('veg', 'nonveg')),
  experience  TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app.targets (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  calories    INTEGER NOT NULL,
  protein     INTEGER NOT NULL,
  carbs       INTEGER NOT NULL,
  fat         INTEGER NOT NULL,
  bmr         INTEGER,
  tdee        INTEGER,
  steps       INTEGER,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- training
CREATE TABLE app.custom_exercises (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  muscle      TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'Custom',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);

CREATE TABLE app.routine_days (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE app.routine_day_exercises (
  routine_day_id  BIGINT NOT NULL REFERENCES app.routine_days(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  exercise_ref    TEXT NOT NULL,
  PRIMARY KEY (routine_day_id, position)
);

CREATE TABLE app.workout_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  date        DATE NOT NULL,
  day_name    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);
CREATE INDEX idx_workout_logs_user_date ON app.workout_logs (user_id, date);

CREATE TABLE app.workout_exercises (
  id            BIGSERIAL PRIMARY KEY,
  workout_id    BIGINT NOT NULL REFERENCES app.workout_logs(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  exercise_ref  TEXT NOT NULL,
  UNIQUE (workout_id, position)
);

CREATE TABLE app.workout_sets (
  id                    BIGSERIAL PRIMARY KEY,
  workout_exercise_id   BIGINT NOT NULL REFERENCES app.workout_exercises(id) ON DELETE CASCADE,
  position              INTEGER NOT NULL,
  set_type              TEXT NOT NULL CHECK (set_type IN ('normal', 'dropset', 'unilateral')),
  reps                  INTEGER,
  weight                NUMERIC(7,2),
  left_reps             INTEGER,
  left_weight           NUMERIC(7,2),
  right_reps            INTEGER,
  right_weight          NUMERIC(7,2),
  drops                 JSONB,
  UNIQUE (workout_exercise_id, position)
);

-- ---------------------------------------------------------------- nutrition
CREATE TABLE app.meal_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  date        DATE NOT NULL,
  meal        TEXT NOT NULL,
  food_ref    TEXT,
  name        TEXT NOT NULL,
  servings    NUMERIC(8,3) NOT NULL DEFAULT 1,
  qty_unit    TEXT,
  qty_amount  NUMERIC(10,2),
  calories    NUMERIC(8,1) NOT NULL,
  protein     NUMERIC(7,1) NOT NULL,
  carbs       NUMERIC(7,1) NOT NULL,
  fat         NUMERIC(7,1) NOT NULL,
  source      TEXT NOT NULL DEFAULT 'manual',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);
CREATE INDEX idx_meal_logs_user_date ON app.meal_logs (user_id, date);

CREATE TABLE app.saved_foods (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  serving     TEXT,
  calories    NUMERIC(8,1) NOT NULL,
  protein     NUMERIC(7,1) NOT NULL,
  carbs       NUMERIC(7,1) NOT NULL,
  fat         NUMERIC(7,1) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);

CREATE TABLE app.step_logs (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  steps       INTEGER NOT NULL CHECK (steps >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);

CREATE TABLE app.diet_plans (
  user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app.diet_plan_items (
  user_id     UUID NOT NULL REFERENCES app.diet_plans(user_id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL,
  position    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

CREATE TABLE app.diet_plan_checks (
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  item_id     TEXT NOT NULL,
  checked     BOOLEAN NOT NULL,
  PRIMARY KEY (user_id, date, item_id)
);

-- ---------------------------------------------------------------- coach
CREATE TABLE app.coach_messages (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  who         TEXT NOT NULL CHECK (who IN ('user', 'coach')),
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);
CREATE INDEX idx_coach_messages_user_seq ON app.coach_messages (user_id, seq);

-- ---------------------------------------------------------------- bookkeeping
CREATE TABLE app.data_imports (
  id           BIGSERIAL PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  source       TEXT NOT NULL,
  counts       JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

-- Fixed-window counters for rate limits (AI calls per user, username logins).
CREATE TABLE app.rate_limits (
  key           TEXT NOT NULL,
  window_start  TIMESTAMPTZ NOT NULL,
  count         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

-- ---------------------------------------------------------------- lock everything down
DO $$
DECLARE t record;
BEGIN
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'app' LOOP
    EXECUTE format('ALTER TABLE app.%I ENABLE ROW LEVEL SECURITY', t.tablename);
    EXECUTE format('REVOKE ALL ON app.%I FROM PUBLIC', t.tablename);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN EXECUTE format('REVOKE ALL ON app.%I FROM anon', t.tablename); END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN EXECUTE format('REVOKE ALL ON app.%I FROM authenticated', t.tablename); END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION app.sync_account_email() FROM PUBLIC;
