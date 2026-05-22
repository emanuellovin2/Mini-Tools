-- Add affiliate to user_role in its own migration so the value is committed
-- before the schema migration (#3) references it in policies and functions.
ALTER TYPE public.user_role ADD VALUE IF NOT EXISTS 'affiliate';
