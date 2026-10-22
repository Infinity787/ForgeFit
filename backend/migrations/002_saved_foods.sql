-- "My foods": custom foods a user saved (with their macros) to log again in one tap.
CREATE TABLE saved_foods (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
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
