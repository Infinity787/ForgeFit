-- Supabase's "automatic RLS" helper is an event-trigger function; nobody needs
-- to call it over the API, so don't let the anon/authenticated roles execute it.
DO $$ BEGIN
  IF to_regprocedure('public.rls_auto_enable()') IS NOT NULL THEN
    REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;
  END IF;
END $$;
