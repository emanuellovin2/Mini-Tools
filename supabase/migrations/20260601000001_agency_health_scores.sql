-- #52 Agency operations dashboard: client_health_scores precomputed table + hourly cron.
-- Scores are keyed (agency_org_id, client_org_id) — one row per relationship.
-- Refreshed by the 'agency_health_refresh' pg_cron job + on-demand via jobs queue.

create table if not exists client_health_scores (
  id                       uuid primary key default gen_random_uuid(),
  agency_org_id            uuid not null references organizations(id) on delete cascade,
  client_org_id            uuid not null references organizations(id) on delete cascade,
  relationship_id          uuid not null references client_relationships(id) on delete cascade,

  -- Computed metrics
  score                    smallint not null check (score between 0 and 100),
  churn_risk               text not null check (churn_risk in ('low', 'medium', 'high')),
  active_deployments       int not null default 0,
  failed_deployments       int not null default 0,
  orphaned_deployments     int not null default 0,
  metric_events_7d         int not null default 0,
  last_activity_at         timestamptz,
  credits_remaining_cents  bigint not null default 0,
  days_since_accepted      int,

  computed_at              timestamptz not null default now(),
  created_at               timestamptz not null default now(),

  unique (agency_org_id, client_org_id)
);

create index if not exists client_health_scores_agency_idx
  on client_health_scores(agency_org_id, churn_risk, score);

-- RLS: agency reads its own scores; admin reads all.
alter table client_health_scores enable row level security;

create policy "agency reads own health scores"
  on client_health_scores for select
  using (
    agency_org_id = any(
      select org_id from org_members where user_id = auth.uid()
    )
  );

create policy "admin reads all health scores"
  on client_health_scores for select
  using (
    exists (
      select 1 from profiles where id = auth.uid() and role = 'admin'
    )
  );

-- Service role can insert/update scores (cron + jobs worker).
create policy "service role manages health scores"
  on client_health_scores for all
  using (true)
  with check (true);

-- ---------------------------------------------------------------------------
-- RPC: refresh_client_health_scores(p_agency_org_id)
-- Called hourly by pg_cron and on-demand from the jobs worker.
-- Upserts one score row per active/paused relationship for the given agency.
-- ---------------------------------------------------------------------------
create or replace function refresh_client_health_scores(p_agency_org_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_updated int := 0;
  v_rel record;
  v_active_deps int;
  v_failed_deps int;
  v_orphaned_deps int;
  v_metric_events int;
  v_last_activity timestamptz;
  v_credits bigint;
  v_days_accepted int;
  v_score smallint;
  v_risk text;
begin
  for v_rel in
    select cr.id as rel_id, cr.client_org_id, cr.accepted_at
    from client_relationships cr
    where cr.agency_org_id = p_agency_org_id
      and cr.status in ('active', 'paused')
  loop
    -- Deployment breakdown
    select
      count(*) filter (where status = 'active'),
      count(*) filter (where status = 'failed'),
      count(*) filter (where status = 'orphaned')
    into v_active_deps, v_failed_deps, v_orphaned_deps
    from solution_deployments
    where agency_org_id = p_agency_org_id
      and client_org_id = v_rel.client_org_id;

    -- Metric events in last 7 days (from deployment_metrics)
    select coalesce(sum(dm.raw_count::int), 0)
    into v_metric_events
    from deployment_metrics_rollup dm
    join solution_deployments sd on sd.id = dm.deployment_id
    where sd.agency_org_id = p_agency_org_id
      and sd.client_org_id = v_rel.client_org_id
      and dm.date >= current_date - interval '7 days';

    -- Last activity: most recent metric event date for this client
    select max(dm.date)::timestamptz
    into v_last_activity
    from deployment_metrics_rollup dm
    join solution_deployments sd on sd.id = dm.deployment_id
    where sd.agency_org_id = p_agency_org_id
      and sd.client_org_id = v_rel.client_org_id;

    -- Credits remaining (sum across client org wallets)
    select coalesce(sum(balance_cents), 0)
    into v_credits
    from credit_wallets
    where org_id = v_rel.client_org_id;

    -- Days since accepted
    v_days_accepted := case
      when v_rel.accepted_at is not null
        then extract(day from now() - v_rel.accepted_at)::int
      else null
    end;

    -- Score + risk via pure logic mirrored from lib/agency/churn-risk.ts
    declare
      v_days_since_activity int := case
        when v_last_activity is not null then extract(day from now() - v_last_activity)::int
        else null
      end;
    begin
      v_score := 100;
      if v_active_deps = 0 then v_score := v_score - 30; end if;
      if v_failed_deps > 0 then v_score := v_score - 20; end if;
      if v_metric_events = 0 and coalesce(v_days_accepted, 0) > 14 then v_score := v_score - 15; end if;
      if v_credits < 1000 then v_score := v_score - 10; end if;
      if v_days_since_activity is not null and v_days_since_activity > 3 then v_score := v_score - 10; end if;
      if v_orphaned_deps > 0 then v_score := v_score - 15; end if;
      v_score := greatest(v_score, 0);

      v_risk := case
        when (v_active_deps = 0 and coalesce(v_days_accepted, 0) > 7)
          or (v_failed_deps > 0 and coalesce(v_days_since_activity, 0) >= 7)
          or (v_metric_events = 0 and coalesce(v_days_accepted, 0) > 14) then 'high'
        when coalesce(v_days_since_activity, 0) > 3
          or v_credits < 1000
          or v_failed_deps > 0 then 'medium'
        else 'low'
      end;
    end;

    insert into client_health_scores (
      agency_org_id, client_org_id, relationship_id,
      score, churn_risk,
      active_deployments, failed_deployments, orphaned_deployments,
      metric_events_7d, last_activity_at, credits_remaining_cents, days_since_accepted,
      computed_at
    ) values (
      p_agency_org_id, v_rel.client_org_id, v_rel.rel_id,
      v_score, v_risk,
      v_active_deps, v_failed_deps, v_orphaned_deps,
      v_metric_events, v_last_activity, v_credits, v_days_accepted,
      now()
    )
    on conflict (agency_org_id, client_org_id) do update set
      relationship_id          = excluded.relationship_id,
      score                    = excluded.score,
      churn_risk               = excluded.churn_risk,
      active_deployments       = excluded.active_deployments,
      failed_deployments       = excluded.failed_deployments,
      orphaned_deployments     = excluded.orphaned_deployments,
      metric_events_7d         = excluded.metric_events_7d,
      last_activity_at         = excluded.last_activity_at,
      credits_remaining_cents  = excluded.credits_remaining_cents,
      days_since_accepted      = excluded.days_since_accepted,
      computed_at              = excluded.computed_at;

    v_updated := v_updated + 1;
  end loop;

  return v_updated;
end;
$$;

-- Hourly pg_cron: refresh all agency health scores.
-- Uses a CTE to fan out per agency, calling the RPC for each.
select cron.schedule(
  'agency-health-refresh-cron',
  '0 * * * *',
  $$
    select refresh_client_health_scores(org_id)
    from organizations
    where type = 'agency';
  $$
);
