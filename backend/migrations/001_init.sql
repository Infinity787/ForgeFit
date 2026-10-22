-- ForgeFit schema v1 (PostgreSQL).
-- Every user-owned table carries user_id with ON DELETE CASCADE, so deleting
-- an account removes all of its data. Client-generated ids (client_id) let the
-- app create records offline and make re-sent/re-imported records idempotent
-- via UNIQUE (user_id, client_id).

-- ---------------------------------------------------------------- auth
CREATE TABLE users (
  id              BIGSERIAL PRIMARY KEY,
  username        TEXT NOT NULL UNIQUE,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  onboarded       BOOLEAN NOT NULL DEFAULT FALSE,
  split_type      TEXT,
  -- Bumped on password change/reset; session JWTs carry it, so older
  -- sessions stop working immediately.
  session_epoch   INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE otp_codes (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT NOT NULL,
  code        TEXT NOT NULL,
  purpose     TEXT NOT NULL CHECK (purpose IN ('signup', 'reset', 'email_change')),
  user_id     BIGINT REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  consumed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_otp_email_purpose ON otp_codes (email, purpose);

CREATE TABLE used_tokens (
  jti         TEXT PRIMARY KEY,
  used_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------- profile & targets
CREATE TABLE profiles (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
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

CREATE TABLE targets (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
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
CREATE TABLE custom_exercises (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  muscle      TEXT NOT NULL,
  type        TEXT NOT NULL DEFAULT 'Custom',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);

-- One row per training day in the user's split, in display order.
CREATE TABLE routine_days (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

-- Exercises planned for a routine day. exercise_ref is either a built-in
-- library id ("ex12") or a custom exercise client_id ("custom_...").
CREATE TABLE routine_day_exercises (
  routine_day_id  BIGINT NOT NULL REFERENCES routine_days(id) ON DELETE CASCADE,
  position        INTEGER NOT NULL,
  exercise_ref    TEXT NOT NULL,
  PRIMARY KEY (routine_day_id, position)
);

CREATE TABLE workout_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  date        DATE NOT NULL,
  day_name    TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);
CREATE INDEX idx_workout_logs_user_date ON workout_logs (user_id, date);

CREATE TABLE workout_exercises (
  id            BIGSERIAL PRIMARY KEY,
  workout_id    BIGINT NOT NULL REFERENCES workout_logs(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL,
  exercise_ref  TEXT NOT NULL,
  UNIQUE (workout_id, position)
);

-- set_type 'normal' uses reps/weight; 'unilateral' uses left_*/right_*
-- (either side may be null); 'dropset' stores its drops as [{reps, weight}].
CREATE TABLE workout_sets (
  id                    BIGSERIAL PRIMARY KEY,
  workout_exercise_id   BIGINT NOT NULL REFERENCES workout_exercises(id) ON DELETE CASCADE,
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
CREATE TABLE meal_logs (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
CREATE INDEX idx_meal_logs_user_date ON meal_logs (user_id, date);

CREATE TABLE step_logs (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  steps       INTEGER NOT NULL CHECK (steps >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, date)
);

CREATE TABLE diet_plans (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE diet_plan_items (
  user_id     BIGINT NOT NULL REFERENCES diet_plans(user_id) ON DELETE CASCADE,
  item_id     TEXT NOT NULL,
  position    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  PRIMARY KEY (user_id, item_id)
);

-- Daily check-offs are kept even if the plan is replaced (history).
CREATE TABLE diet_plan_checks (
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  item_id     TEXT NOT NULL,
  checked     BOOLEAN NOT NULL,
  PRIMARY KEY (user_id, date, item_id)
);

-- ---------------------------------------------------------------- coach
CREATE TABLE coach_messages (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id   TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  who         TEXT NOT NULL CHECK (who IN ('user', 'coach')),
  text        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, client_id)
);
CREATE INDEX idx_coach_messages_user_seq ON coach_messages (user_id, seq);

-- ---------------------------------------------------------------- legacy import ledger
-- One row per successfully applied device import; the fingerprint is a hash
-- of the imported payload so the same local data can't be imported twice.
CREATE TABLE data_imports (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint  TEXT NOT NULL,
  source       TEXT NOT NULL,
  counts       JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);
