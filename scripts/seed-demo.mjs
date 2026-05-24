/**
 * DEMO SEED SCRIPT — creates 3 vendors, 3 apps, 10 resellers, 10 affiliates, 143 buyers.
 * Run: node scripts/seed-demo.mjs
 * Cleanup: node scripts/seed-demo.mjs --cleanup
 * All accounts: password Demo1234!
 */

import { execSync } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SUPABASE_URL = 'http://127.0.0.1:54321';
const SRK =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const PASSWORD = 'Demo1234!';
const DB = 'supabase_db_Mini-Tools';

// ── helpers ──────────────────────────────────────────────────────────────────

// Cache of email→id from auth.users (populated lazily on first email_exists collision)
let _authUserCache = null;
async function getAuthUserCache() {
  if (_authUserCache) return _authUserCache;
  _authUserCache = {};
  let page = 1;
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000&page=${page}`,
      { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } }
    );
    const d = await r.json();
    const users = d.users ?? [];
    for (const u of users) _authUserCache[u.email] = u.id;
    if (users.length < 1000) break;
    page++;
  }
  return _authUserCache;
}

async function createUser(email, intendedRole) {
  const body = { email, password: PASSWORD, email_confirm: true };
  if (intendedRole) body.user_metadata = { intended_role: intendedRole };
  const res = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SRK, Authorization: `Bearer ${SRK}` },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) {
    if (data.msg?.includes('already registered') || data.error_code === 'email_exists') {
      const cache = await getAuthUserCache();
      if (cache[email]) return cache[email];
    }
    throw new Error(`createUser(${email}): ${JSON.stringify(data)}`);
  }
  return data.id;
}

async function deleteUser(id) {
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: SRK, Authorization: `Bearer ${SRK}` },
  });
}

function listDemoUsers() {
  const res = fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000`,
    { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } }
  );
  return res;
}

function psql(sql) {
  const tmpLocal = join(tmpdir(), 'seed-demo.sql');
  writeFileSync(tmpLocal, sql, 'utf8');
  execSync(`docker cp ${tmpLocal} ${DB}:/tmp/seed-demo.sql`);
  try {
    const out = execSync(
      `docker exec ${DB} psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f /tmp/seed-demo.sql`,
      { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }
    );
    return out;
  } catch (err) {
    console.error('\n❌ SQL ERROR:\n', err.stdout || '', '\n', err.stderr || '');
    throw err;
  } finally {
    try { unlinkSync(tmpLocal); } catch (_) {}
  }
}

function esc(s) {
  return s.replace(/'/g, "''");
}

function sid(prefix, n) {
  return `${prefix}_demo_${String(n).padStart(6, '0')}`;
}

// fixed deterministic UUIDs for easy reference
function fixedUUID(namespace, n) {
  const hex = String(n).padStart(12, '0');
  const ns = namespace.slice(0, 8).padEnd(8, '0');
  return `${ns}-0000-0000-0000-${hex}`;
}

// ── cleanup mode ─────────────────────────────────────────────────────────────

async function cleanup() {
  console.log('🧹 Cleaning up demo data…');

  // Collect IDs of all demo emails in auth.users
  let page = 1;
  const demoIds = [];
  while (true) {
    const r = await fetch(
      `${SUPABASE_URL}/auth/v1/admin/users?per_page=1000&page=${page}`,
      { headers: { apikey: SRK, Authorization: `Bearer ${SRK}` } }
    );
    const d = await r.json();
    const users = d.users ?? [];
    for (const u of users) {
      if (/@demo\.com$/.test(u.email)) demoIds.push(u.id);
    }
    if (users.length < 1000) break;
    page++;
  }

  if (demoIds.length === 0) {
    console.log('No demo users found.');
    return;
  }

  // Delete all relational data first via SQL (FK constraints need ordering)
  const idList = demoIds.map(id => `'${id}'`).join(',');
  psql(`
BEGIN;
-- revenue & billing
DELETE FROM public.vendor_revenue_events WHERE vendor_id IN (${idList}) OR vendor_id IN (SELECT id FROM public.profiles WHERE id IN (${idList}));
DELETE FROM public.vendor_billing WHERE vendor_id IN (${idList});
-- audit
DELETE FROM public.audit_log WHERE actor_id IN (${idList});
-- subscriptions
DELETE FROM public.subscriptions
  WHERE buyer_id IN (${idList})
     OR affiliate_id IN (${idList})
     OR reseller_id IN (${idList});
-- reseller
DELETE FROM public.reseller_subscriptions WHERE reseller_id IN (${idList});
DELETE FROM public.reseller_offers WHERE reseller_id IN (${idList});
-- affiliate
DELETE FROM public.affiliate_attributions WHERE affiliate_id IN (${idList});
DELETE FROM public.affiliate_links WHERE affiliate_id IN (${idList});
-- apps
DELETE FROM public.apps WHERE vendor_id IN (${idList});
COMMIT;
`);

  // Delete auth users
  console.log(`  Deleting ${demoIds.length} auth users…`);
  for (const id of demoIds) {
    await deleteUser(id);
  }
  console.log('✅ Demo data removed.');
}

// ── main seed ─────────────────────────────────────────────────────────────────

async function seed() {
  console.log('🌱 Seeding demo data…\n');

  // ── 1. Create auth users ──────────────────────────────────────────────────
  console.log('👤 Creating users…');

  console.log('  admin…');
  const adminId = await createUser('admin@demo.com');

  console.log('  vendors (3)…');
  const vendorIds = [];
  for (let i = 1; i <= 3; i++) {
    vendorIds.push(await createUser(`vendor${i}@demo.com`, 'vendor'));
  }

  console.log('  resellers (10)…');
  const resellerIds = [];
  for (let i = 1; i <= 10; i++) {
    resellerIds.push(await createUser(`reseller${i}@demo.com`, 'reseller'));
  }

  console.log('  affiliates (10)…');
  const affiliateIds = [];
  for (let i = 1; i <= 10; i++) {
    affiliateIds.push(await createUser(`affiliate${i}@demo.com`, 'affiliate'));
  }

  console.log('  buyers (143)…');
  const buyerIds = [];
  for (let i = 1; i <= 143; i++) {
    if (i % 30 === 0) process.stdout.write(`    ${i}/143\n`);
    buyerIds.push(await createUser(`buyer${i}@demo.com`));
  }
  console.log('  ✓ 167 users created\n');

  // ── 2. Resolve fixed IDs ──────────────────────────────────────────────────
  const [v1, v2, v3] = vendorIds;

  const APP_IDS = [
    fixedUUID('aaa00001', 1),
    fixedUUID('aaa00002', 2),
    fixedUUID('aaa00003', 3),
  ];

  const OFFER_IDS = Array.from({ length: 10 }, (_, i) =>
    fixedUUID('bbb00000', i + 1)
  );

  // ── 3. Build SQL ──────────────────────────────────────────────────────────
  console.log('🔨 Building SQL…');
  const lines = [];
  const q = s => lines.push(s);

  q('BEGIN;');
  q('SET session_replication_role = replica;'); // disables per-row triggers + deferred FK checks
  q('ALTER TABLE public.profiles DISABLE TRIGGER guard_vendor_cut_override_trigger;');

  // ── Admin role fix
  q(`UPDATE public.profiles SET role='admin', display_name='Admin Demo'
     WHERE id='${adminId}';`);

  // ── Vendor profiles
  const vendorMeta = [
    { id: v1, name: 'TaskFlow Corp',    openness: 'open_to_wl',          cut: null },
    { id: v2, name: 'InvoiceNinja Inc', openness: 'open_to_resellers',   cut: null },
    { id: v3, name: 'AnalyticsHub LLC', openness: 'open_to_resellers',   cut: 700  },
  ];
  for (const v of vendorMeta) {
    q(`UPDATE public.profiles SET
         display_name='${esc(v.name)}',
         charges_enabled=true,
         payouts_enabled=true,
         stripe_account_id='acct_demo_${v.id.slice(0,8)}',
         reseller_openness='${v.openness}'
       WHERE id='${v.id}';`);
    // vendor_cut_bps_override is protected by guard_vendor_cut_override trigger.
    // We bypass it by directly calling the underlying update in a separate statement:
    if (v.cut !== null) {
      q(`UPDATE public.profiles SET vendor_cut_bps_override=${v.cut} WHERE id='${v.id}';`);
    }
  }

  // ── Reseller profiles
  const resellerMeta = [
    { slug: 'softshop',   name: 'SoftShop Store',       color: '#2563EB' },
    { slug: 'invoicepro', name: 'InvoicePro Hub',        color: '#059669' },
    { slug: 'analytix',   name: 'Analytix Solutions',    color: '#7C3AED' },
    { slug: 'devtools',   name: 'DevTools Market',       color: '#D97706' },
    { slug: 'billmate',   name: 'BillMate Shop',         color: '#DC2626' },
    { slug: 'datavis',    name: 'DataVis Agency',        color: '#4F46E5' },
    { slug: 'taskmaster', name: 'TaskMaster Store',      color: '#0891B2' },
    { slug: 'payeasy',    name: 'PayEasy Portal',        color: '#BE185D' },
    { slug: 'insights',   name: 'Insights Hub',          color: '#65A30D' },
    { slug: 'appbundle',  name: 'AppBundle Store',       color: '#EA580C' },
  ];
  for (let i = 0; i < resellerIds.length; i++) {
    const m = resellerMeta[i];
    q(`UPDATE public.profiles SET
         display_name='${esc(m.name)}',
         slug='${m.slug}',
         stripe_account_id='acct_demo_res${i + 1}',
         charges_enabled=true,
         payouts_enabled=true
       WHERE id='${resellerIds[i]}';`);
  }

  // Reseller6 (datavis) gets global mini-branding (Tier 1 + Tier 2)
  q(`UPDATE public.profiles SET
       wl_global_logo_url='https://placehold.co/120x40/4F46E5/white?text=DataVis',
       wl_global_brand_color='#4F46E5',
       wl_global_display_name='DataVis Analytics'
     WHERE id='${resellerIds[5]}';`);

  // ── Affiliate profiles
  const affiliateMeta = [
    { slug: 'techreviewer',  name: 'Alex Rivera',     bio: 'Tech reviewer covering SaaS productivity tools. 50k+ YouTube subscribers.' },
    { slug: 'saasgeek',      name: 'Sam Chen',        bio: 'SaaS Geek — honest reviews and comparisons for B2B software buyers.' },
    { slug: 'productivehq',  name: 'Jordan Blake',    bio: 'Productivity blogger helping teams work smarter with the right tools.' },
    { slug: 'cloudadviser',  name: 'Casey Morgan',    bio: 'Cloud software consultant and advisor. 8 years in SaaS distribution.' },
    { slug: 'softwareguru',  name: 'Taylor Kim',      bio: 'Software guru writing about small-business billing and finance tools.' },
    { slug: 'appreviews',    name: 'Quinn Adams',     bio: 'Independent app reviewer on a mission to find the best business apps.' },
    { slug: 'startuptips',   name: 'Riley Cooper',    bio: 'Startup advisor and blogger focused on analytics and growth tools.' },
    { slug: 'devmarketer',   name: 'Drew Wilson',     bio: 'Developer-turned-marketer sharing data-driven growth strategies.' },
    { slug: 'saasblog',      name: 'Jamie Fox',       bio: 'SaaS blog covering analytics platforms for scaling B2B businesses.' },
    { slug: 'toolreviewer',  name: 'Avery Lee',       bio: 'Business tool reviewer trusted by 25k+ newsletter subscribers.' },
  ];
  for (let i = 0; i < affiliateIds.length; i++) {
    const m = affiliateMeta[i];
    q(`UPDATE public.profiles SET
         display_name='${esc(m.name)}',
         slug='${m.slug}',
         stripe_account_id='acct_demo_aff${i + 1}',
         charges_enabled=true,
         payouts_enabled=true,
         affiliate_bio='${esc(m.bio)}'
       WHERE id='${affiliateIds[i]}';`);
  }

  // ── Buyer display names
  const FIRST = ['Emma','Liam','Olivia','Noah','Ava','William','Sophia','James','Isabella','Oliver',
    'Mia','Benjamin','Charlotte','Elijah','Amelia','Lucas','Harper','Mason','Evelyn','Logan',
    'Abigail','Alexander','Emily','Ethan','Elizabeth','Jacob','Mila','Michael','Ella','Daniel',
    'Avery','Henry','Sofia','Jackson','Camila','Sebastian','Aria','Aiden','Scarlett','Matthew',
    'Victoria','Samuel','Madison','David','Luna','Joseph','Grace','Carter','Chloe','Owen'];
  const LAST = ['Smith','Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Wilson','Taylor',
    'Anderson','Thomas','Jackson','White','Harris','Martin','Thompson','Young','Allen','King',
    'Wright','Scott','Torres','Nguyen','Hill','Flores','Green','Adams','Nelson','Baker',
    'Hall','Rivera','Campbell','Mitchell','Carter','Roberts','Gomez','Phillips','Evans','Turner',
    'Diaz','Parker','Cruz','Edwards','Collins','Reyes','Stewart','Morris','Sanchez','Rogers'];
  for (let i = 0; i < buyerIds.length; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`;
    q(`UPDATE public.profiles SET display_name='${esc(name)}' WHERE id='${buyerIds[i]}';`);
  }

  // ── Apps
  const apps = [
    {
      id: APP_IDS[0], vendorId: v1,
      name: 'TaskFlow Pro',
      desc: 'Powerful project management SaaS for teams of all sizes. Kanban boards, Gantt charts, time tracking, and deep integrations with 50+ tools.',
      category: 'Productivity',
      price: 4900, floor: 4000, commission: 4000,
      screenshots: [
        'https://placehold.co/1280x800/4f46e5/ffffff?text=TaskFlow+Pro+%E2%80%94+Kanban+Board',
        'https://placehold.co/1280x800/4f46e5/ffffff?text=TaskFlow+Pro+%E2%80%94+Gantt+Timeline',
        'https://placehold.co/1280x800/4f46e5/ffffff?text=TaskFlow+Pro+%E2%80%94+Team+Reports',
        'https://placehold.co/1280x800/4f46e5/ffffff?text=TaskFlow+Pro+%E2%80%94+Integrations',
      ],
    },
    {
      id: APP_IDS[1], vendorId: v2,
      name: 'InvoiceNinja',
      desc: 'Professional invoicing, expense tracking, and billing automation for freelancers and small businesses. Send invoices in seconds, get paid faster.',
      category: 'Finance',
      price: 2900, floor: 2400, commission: 3000,
      screenshots: [
        'https://placehold.co/1280x800/059669/ffffff?text=InvoiceNinja+%E2%80%94+Dashboard',
        'https://placehold.co/1280x800/059669/ffffff?text=InvoiceNinja+%E2%80%94+Invoice+Editor',
        'https://placehold.co/1280x800/059669/ffffff?text=InvoiceNinja+%E2%80%94+Expense+Tracker',
        'https://placehold.co/1280x800/059669/ffffff?text=InvoiceNinja+%E2%80%94+Payment+Reports',
        'https://placehold.co/1280x800/059669/ffffff?text=InvoiceNinja+%E2%80%94+Client+Portal',
      ],
    },
    {
      id: APP_IDS[2], vendorId: v3,
      name: 'AnalyticsHub',
      desc: 'Real-time analytics, interactive dashboards, and data visualization for SaaS businesses. Funnels, cohort analysis, LTV, churn prediction, and more.',
      category: 'Analytics',
      price: 7900, floor: 6500, commission: 5000,
      screenshots: [
        'https://placehold.co/1280x800/7c3aed/ffffff?text=AnalyticsHub+%E2%80%94+Overview',
        'https://placehold.co/1280x800/7c3aed/ffffff?text=AnalyticsHub+%E2%80%94+Funnel+Analysis',
        'https://placehold.co/1280x800/7c3aed/ffffff?text=AnalyticsHub+%E2%80%94+Cohort+Retention',
        'https://placehold.co/1280x800/7c3aed/ffffff?text=AnalyticsHub+%E2%80%94+LTV+Calculator',
        'https://placehold.co/1280x800/7c3aed/ffffff?text=AnalyticsHub+%E2%80%94+Churn+Alerts',
        'https://placehold.co/1280x800/7c3aed/ffffff?text=AnalyticsHub+%E2%80%94+Data+Export',
      ],
    },
  ];
  for (const app of apps) {
    const screenshotsArray = app.screenshots.map(u => `'${u}'`).join(',');
    q(`INSERT INTO public.apps
         (id, vendor_id, name, description, category, price_cents, min_price_cents,
          affiliate_commission_bps, status, stripe_product_id, stripe_price_id,
          first_verified_at, screenshot_urls)
       VALUES (
         '${app.id}','${app.vendorId}','${esc(app.name)}','${esc(app.desc)}',
         '${app.category}',${app.price},${app.floor},${app.commission},
         'approved',
         'prod_demo_${app.id.slice(0,8)}',
         'price_demo_${app.id.slice(0,8)}',
         '2026-02-01T10:00:00Z',
         ARRAY[${screenshotsArray}]
       )
       ON CONFLICT (id) DO UPDATE SET screenshot_urls = EXCLUDED.screenshot_urls;`);
  }

  // ── Reseller platform subscriptions ($19/mo billing)
  for (let i = 0; i < resellerIds.length; i++) {
    const created = new Date('2026-02-01');
    created.setDate(created.getDate() + i * 4);
    q(`INSERT INTO public.reseller_subscriptions
         (reseller_id, stripe_subscription_id, status, current_period_end, created_at)
       VALUES (
         '${resellerIds[i]}',
         '${sid('sub', 9000 + i)}',
         'active',
         '2026-06-24T00:00:00Z',
         '${created.toISOString()}'
       )
       ON CONFLICT (reseller_id) DO NOTHING;`);
  }

  // ── Reseller offers
  // offers[i] maps to resellerIds[i]
  const offerDefs = [
    // r1 → TaskFlow $59  (Tier 1)
    { app: APP_IDS[0], slug: 'taskflow-pro',   price: 5900, floor: 4000, tier: 1 },
    // r2 → InvoiceNinja $39 (Tier 1)
    { app: APP_IDS[1], slug: 'invoice-ninja',  price: 3900, floor: 2400, tier: 1 },
    // r3 → AnalyticsHub $99 (Tier 1)
    { app: APP_IDS[2], slug: 'analytics-hub',  price: 9900, floor: 6500, tier: 1 },
    // r4 → TaskFlow $55  (Tier 1)
    { app: APP_IDS[0], slug: 'taskflow-pro',   price: 5500, floor: 4000, tier: 1 },
    // r5 → InvoiceNinja $35 (Tier 1)
    { app: APP_IDS[1], slug: 'invoice-ninja',  price: 3500, floor: 2400, tier: 1 },
    // r6 → AnalyticsHub $89 (Tier 2 WL)
    { app: APP_IDS[2], slug: 'analytics-hub',  price: 8900, floor: 6500, tier: 2 },
    // r7 → TaskFlow $65 (Tier 1)
    { app: APP_IDS[0], slug: 'taskflow-pro',   price: 6500, floor: 4000, tier: 1 },
    // r8 → InvoiceNinja $45 (Tier 1)
    { app: APP_IDS[1], slug: 'invoice-ninja',  price: 4500, floor: 2400, tier: 1 },
    // r9 → AnalyticsHub $89 (Tier 1)
    { app: APP_IDS[2], slug: 'analytics-hub',  price: 8900, floor: 6500, tier: 1 },
    // r10 → TaskFlow $69 (Tier 1)
    { app: APP_IDS[0], slug: 'taskflow-pro',   price: 6900, floor: 4000, tier: 1 },
  ];

  for (let i = 0; i < offerDefs.length; i++) {
    const o = offerDefs[i];
    const offerId = OFFER_IDS[i];
    if (o.tier === 2) {
      q(`INSERT INTO public.reseller_offers
           (id, reseller_id, app_id, slug, sell_price_cents, vendor_floor_snapshot_cents,
            stripe_price_id, status, wl_tier,
            wl_logo_url, wl_brand_color, wl_display_name,
            wl_stripe_subscription_id, wl_status)
         VALUES (
           '${offerId}','${resellerIds[i]}','${o.app}',
           '${o.slug}',${o.price},${o.floor},
           'price_demo_offer${i + 1}','active',2,
           'https://placehold.co/240x80/4F46E5/white?text=DataVis',
           '#4F46E5',
           'DataVis Analytics Suite',
           '${sid('sub', 8000 + i)}',
           'active'
         )
         ON CONFLICT (id) DO NOTHING;`);
    } else {
      q(`INSERT INTO public.reseller_offers
           (id, reseller_id, app_id, slug, sell_price_cents, vendor_floor_snapshot_cents,
            stripe_price_id, status, wl_tier)
         VALUES (
           '${offerId}','${resellerIds[i]}','${o.app}',
           '${o.slug}',${o.price},${o.floor},
           'price_demo_offer${i + 1}','active',1
         )
         ON CONFLICT (id) DO NOTHING;`);
    }
  }

  // ── Affiliate links
  const affAppMap = [
    [0, APP_IDS[0]], [1, APP_IDS[0]], [2, APP_IDS[0]],  // aff1-3 → TaskFlow
    [3, APP_IDS[1]], [4, APP_IDS[1]], [5, APP_IDS[1]],  // aff4-6 → InvoiceNinja
    [6, APP_IDS[2]], [7, APP_IDS[2]], [8, APP_IDS[2]], [9, APP_IDS[2]], // aff7-10 → AnalyticsHub
  ];
  const affCodes = affAppMap.map(([i]) => `aff${String(i + 1).padStart(3, '0')}demo`);

  for (const [affIdx, appId] of affAppMap) {
    q(`INSERT INTO public.affiliate_links (affiliate_id, code, app_id)
       VALUES ('${affiliateIds[affIdx]}','${affCodes[affIdx]}','${appId}');`);
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────
  // Distribution:
  //   TaskFlow (0-57, 58 buyers):
  //     0-24  direct          25 subs
  //     25-29 affiliate1       5 subs
  //     30-34 affiliate2       5 subs
  //     35-37 affiliate3       3 subs
  //     38-43 reseller1/softshop $59   6 subs
  //     44-49 reseller4/devtools $55   6 subs
  //     50-54 reseller7/taskmaster $65 5 subs
  //     55-57 reseller10/appbundle $69 3 subs
  //   InvoiceNinja (58-108, 51 buyers):
  //     58-74  direct          17 subs
  //     75-79  affiliate4       5 subs
  //     80-85  affiliate5       6 subs
  //     86-90  affiliate6       5 subs
  //     91-96  reseller2/invoicepro $39 6 subs
  //     97-101 reseller5/billmate $35  5 subs
  //     102-108 reseller8/payeasy $45  7 subs
  //   AnalyticsHub (109-142, 34 buyers):
  //     109-118 direct          10 subs
  //     119-123 affiliate7       5 subs
  //     124-127 affiliate8       4 subs
  //     128-131 affiliate9       4 subs
  //     132-134 affiliate10      3 subs
  //     135-138 reseller3/analytix $99 4 subs
  //     139-142 reseller6/datavis $89 WL T2  4 subs

  function getSubAttribution(i) {
    if (i < 58) {
      // TaskFlow
      const appId = APP_IDS[0]; const appPrice = 4900; const appFloor = 4000;
      if (i < 25)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: null, resId: null, offIdx: null, wlTier: null, openness: null };
      if (i < 30)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[0], resId: null, offIdx: null, wlTier: null, openness: null };
      if (i < 35)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[1], resId: null, offIdx: null, wlTier: null, openness: null };
      if (i < 38)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[2], resId: null, offIdx: null, wlTier: null, openness: null };
      if (i < 44)  return { appId, appPrice, appFloor, sellPrice: 5900, affId: null, resId: resellerIds[0], offIdx: 0, wlTier: 1, openness: 'open_to_wl' };
      if (i < 50)  return { appId, appPrice, appFloor, sellPrice: 5500, affId: null, resId: resellerIds[3], offIdx: 3, wlTier: 1, openness: 'open_to_wl' };
      if (i < 55)  return { appId, appPrice, appFloor, sellPrice: 6500, affId: null, resId: resellerIds[6], offIdx: 6, wlTier: 1, openness: 'open_to_wl' };
      return              { appId, appPrice, appFloor, sellPrice: 6900, affId: null, resId: resellerIds[9], offIdx: 9, wlTier: 1, openness: 'open_to_wl' };
    }
    if (i < 109) {
      // InvoiceNinja
      const j = i - 58; const appId = APP_IDS[1]; const appPrice = 2900; const appFloor = 2400;
      if (j < 17)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: null, resId: null, offIdx: null, wlTier: null, openness: null };
      if (j < 22)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[3], resId: null, offIdx: null, wlTier: null, openness: null };
      if (j < 28)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[4], resId: null, offIdx: null, wlTier: null, openness: null };
      if (j < 33)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[5], resId: null, offIdx: null, wlTier: null, openness: null };
      if (j < 39)  return { appId, appPrice, appFloor, sellPrice: 3900, affId: null, resId: resellerIds[1], offIdx: 1, wlTier: 1, openness: 'open_to_resellers' };
      if (j < 44)  return { appId, appPrice, appFloor, sellPrice: 3500, affId: null, resId: resellerIds[4], offIdx: 4, wlTier: 1, openness: 'open_to_resellers' };
      return              { appId, appPrice, appFloor, sellPrice: 4500, affId: null, resId: resellerIds[7], offIdx: 7, wlTier: 1, openness: 'open_to_resellers' };
    }
    // AnalyticsHub
    const j = i - 109; const appId = APP_IDS[2]; const appPrice = 7900; const appFloor = 6500;
    if (j < 10)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: null, resId: null, offIdx: null, wlTier: null, openness: null };
    if (j < 15)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[6], resId: null, offIdx: null, wlTier: null, openness: null };
    if (j < 19)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[7], resId: null, offIdx: null, wlTier: null, openness: null };
    if (j < 23)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[8], resId: null, offIdx: null, wlTier: null, openness: null };
    if (j < 26)  return { appId, appPrice, appFloor, sellPrice: appPrice, affId: affiliateIds[9], resId: null, offIdx: null, wlTier: null, openness: null };
    if (j < 30)  return { appId, appPrice, appFloor, sellPrice: 9900, affId: null, resId: resellerIds[2], offIdx: 2, wlTier: 1, openness: 'open_to_resellers' };
    return              { appId, appPrice, appFloor, sellPrice: 8900, affId: null, resId: resellerIds[5], offIdx: 5, wlTier: 2, openness: 'open_to_wl' };
  }

  const subIds = [];
  for (let i = 0; i < buyerIds.length; i++) {
    const a = getSubAttribution(i);
    const subId = fixedUUID('ccc00000', i + 1);
    subIds.push(subId);
    const isReseller = a.resId !== null;
    const stripeSubId = sid('sub', 1000 + i);
    const stripeCustId = sid('cus', 1000 + i);
    const anonUserId = `anon_usr_${String(i + 1).padStart(6, '0')}`;
    // Stagger created_at over ~90 days of history
    const created = new Date('2026-02-10T00:00:00Z');
    created.setDate(created.getDate() + Math.floor((i / 143) * 90));

    const affPart = a.affId ? `'${a.affId}'` : 'NULL';
    const resPart = isReseller ? `'${a.resId}'` : 'NULL';
    const offPart = a.offIdx !== null ? `'${OFFER_IDS[a.offIdx]}'` : 'NULL';
    const floorPart = isReseller ? a.appFloor : 'NULL';
    const wlTierPart = a.wlTier !== null ? a.wlTier : 'NULL';
    const opennessPart = a.openness ? `'${a.openness}'` : 'NULL';
    // Affiliate commission snapshot: 4000 for TaskFlow, 3000 for Invoice, 5000 for Analytics
    const affCommission = a.affId
      ? (a.appId === APP_IDS[0] ? 4000 : a.appId === APP_IDS[1] ? 3000 : 5000)
      : null;
    const affCommPart = affCommission !== null ? affCommission : 'NULL';

    q(`INSERT INTO public.subscriptions
         (id, buyer_id, app_id, stripe_subscription_id, stripe_customer_id,
          status, price_cents, anon_user_id, current_period_end,
          affiliate_id, reseller_id, reseller_offer_id,
          vendor_floor_snapshot_cents,
          affiliate_commission_snapshot_bps,
          reseller_wl_tier_snapshot, vendor_openness_snapshot, created_at)
       VALUES (
         '${subId}','${buyerIds[i]}','${a.appId}',
         '${stripeSubId}','${stripeCustId}',
         'active',${a.sellPrice},'${anonUserId}',
         '2026-06-24T00:00:00Z',
         ${affPart},${resPart},${offPart},
         ${floorPart},
         ${affCommPart},
         ${wlTierPart},${opennessPart},
         '${created.toISOString()}'
       )
       ON CONFLICT (id) DO NOTHING;`);
  }

  // ── Vendor revenue events (4 months: Feb–May 2026) ─────────────────────────
  // amount_cents = vendor's revenue (gross for direct/aff, floor for reseller)
  // net_amount_cents = amount - stripe fees
  function netAmount(gross) {
    return gross - (Math.round(gross * 0.029) + 30);
  }

  const months = [
    { label: '2026-02', start: new Date('2026-02-01'), growthFraction: 0.62 },
    { label: '2026-03', start: new Date('2026-03-01'), growthFraction: 0.76 },
    { label: '2026-04', start: new Date('2026-04-01'), growthFraction: 0.89 },
    { label: '2026-05', start: new Date('2026-05-01'), growthFraction: 1.00 },
  ];

  let evtCounter = 0;
  for (const month of months) {
    for (let i = 0; i < buyerIds.length; i++) {
      const a = getSubAttribution(i);
      // Include sub if created before this month (growth simulation)
      const subCreated = new Date('2026-02-10T00:00:00Z');
      subCreated.setDate(subCreated.getDate() + Math.floor((i / 143) * 90));
      if (subCreated > month.start) continue;

      const isReseller = a.resId !== null;
      const vendorId = a.appId === APP_IDS[0] ? v1 : a.appId === APP_IDS[1] ? v2 : v3;
      const gross = isReseller ? a.appFloor : a.appPrice;
      const net = netAmount(gross);
      evtCounter++;
      const occurred = new Date(month.start);
      occurred.setDate(occurred.getDate() + (i % 27));

      q(`INSERT INTO public.vendor_revenue_events
           (vendor_id, amount_cents, net_amount_cents, is_reseller_sale,
            stripe_invoice_id, stripe_event_id, app_id, subscription_id, occurred_at)
         VALUES (
           '${vendorId}',${gross},${net},${isReseller},
           '${sid('in', 10000 + evtCounter)}',
           '${sid('evt', 10000 + evtCounter)}',
           '${a.appId}','${subIds[i]}',
           '${occurred.toISOString()}'
         )
         ON CONFLICT (stripe_event_id) DO NOTHING;`);
    }
  }

  // ── Vendor billing (monthly aggregates for admin + vendor dashboards) ───────
  //   Computed from direct+affiliate subs only (is_reseller_sale=false).
  //   Feb: ~62%, Mar: ~76%, Apr: ~89%, May: ~100% of current subs
  //
  //   Vendor1 (TaskFlow): 38 direct+aff subs × $4728 net = $179,664/mo max
  //   Vendor2 (InvoiceNinja): 33 direct+aff × $2786 = $91,938/mo max
  //   Vendor3 (AnalyticsHub): 26 direct+aff × $7641 = $198,666/mo max
  const billingDef = [
    { vid: v1, rows: [
      { ps: '2026-02-01', pe: '2026-02-28', gross: 111391, tier: 1, cut: 1200 },
      { ps: '2026-03-01', pe: '2026-03-31', gross: 136545, tier: 2, cut: 800  },
      { ps: '2026-04-01', pe: '2026-04-30', gross: 159900, tier: 2, cut: 800  },
      { ps: '2026-05-01', pe: '2026-05-31', gross: 179664, tier: 2, cut: 800  },
    ]},
    { vid: v2, rows: [
      { ps: '2026-02-01', pe: '2026-02-28', gross: 57001,  tier: 1, cut: 1200 },
      { ps: '2026-03-01', pe: '2026-03-31', gross: 69872,  tier: 1, cut: 1200 },
      { ps: '2026-04-01', pe: '2026-04-30', gross: 81824,  tier: 1, cut: 1200 },
      { ps: '2026-05-01', pe: '2026-05-31', gross: 91938,  tier: 1, cut: 1200 },
    ]},
    { vid: v3, rows: [
      { ps: '2026-02-01', pe: '2026-02-28', gross: 123173, tier: 2, cut: 800  },
      { ps: '2026-03-01', pe: '2026-03-31', gross: 150986, tier: 2, cut: 800  },
      { ps: '2026-04-01', pe: '2026-04-30', gross: 176813, tier: 2, cut: 800  },
      { ps: '2026-05-01', pe: '2026-05-31', gross: 198666, tier: 2, cut: 800  },
    ]},
  ];
  for (const bv of billingDef) {
    for (const r of bv.rows) {
      q(`INSERT INTO public.vendor_billing
           (vendor_id, period_start, period_end, gross_revenue_cents, tier, cut_bps)
         VALUES ('${bv.vid}','${r.ps}','${r.pe}',${r.gross},${r.tier},${r.cut})
         ON CONFLICT (vendor_id, period_start) DO NOTHING;`);
    }
  }

  // ── Affiliate MRR (active + lifetime)
  //   active_mrr = price × active_subs_referred
  //   lifetime = 4 months worth
  const affMRR = [
    { i: 0, active: 24500,  lifetime: 98000  },  // 5 × $49
    { i: 1, active: 24500,  lifetime: 98000  },  // 5 × $49
    { i: 2, active: 14700,  lifetime: 58800  },  // 3 × $49
    { i: 3, active: 14500,  lifetime: 58000  },  // 5 × $29
    { i: 4, active: 17400,  lifetime: 69600  },  // 6 × $29
    { i: 5, active: 14500,  lifetime: 58000  },  // 5 × $29
    { i: 6, active: 39500,  lifetime: 158000 },  // 5 × $79
    { i: 7, active: 31600,  lifetime: 126400 },  // 4 × $79
    { i: 8, active: 31600,  lifetime: 126400 },  // 4 × $79
    { i: 9, active: 23700,  lifetime: 94800  },  // 3 × $79
  ];
  for (const m of affMRR) {
    q(`UPDATE public.profiles SET
         affiliate_active_mrr_cents=${m.active},
         affiliate_lifetime_mrr_cents=${m.lifetime}
       WHERE id='${affiliateIds[m.i]}';`);
  }

  // ── Audit log entries
  q(`INSERT INTO public.audit_log (actor_id, actor_role, action, entity_type, entity_id, metadata) VALUES
     ('${adminId}','admin','app_approved','app','${APP_IDS[0]}','{"app_name":"TaskFlow Pro","vendor_email":"vendor1@demo.com"}'),
     ('${adminId}','admin','app_approved','app','${APP_IDS[1]}','{"app_name":"InvoiceNinja","vendor_email":"vendor2@demo.com"}'),
     ('${adminId}','admin','app_approved','app','${APP_IDS[2]}','{"app_name":"AnalyticsHub","vendor_email":"vendor3@demo.com"}'),
     ('${adminId}','admin','vendor_cut_override_set','vendor','${v3}','{"old_bps":null,"new_bps":700,"reason":"Enterprise deal — negotiated rate"}');`);

  q('ALTER TABLE public.profiles ENABLE TRIGGER guard_vendor_cut_override_trigger;');
  q('SET session_replication_role = DEFAULT;');
  q('COMMIT;');

  // ── Run SQL ────────────────────────────────────────────────────────────────
  console.log(`\n🚀 Executing SQL (${lines.length} statements)…`);
  const sqlText = lines.join('\n');
  try {
    const out = psql(sqlText);
    if (out && out.includes('ERROR')) {
      console.error('SQL error:\n', out);
      process.exit(1);
    }
  } catch (err) {
    console.error('SQL execution failed:\n', err.message);
    if (err.stderr) console.error(err.stderr);
    process.exit(1);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`
╔══════════════════════════════════════════════════════════════════════╗
║              🎉  DEMO SEED COMPLETE                                  ║
║                  Password for ALL accounts: Demo1234!                ║
╠══════════════════════════════════════════════════════════════════════╣
║  Dashboard URL → http://localhost:3000                               ║
╠══════════════════════════════════════════════════════════════════════╣
║  ADMIN                                                               ║
║    admin@demo.com  → /admin                                          ║
╠══════════════════════════════════════════════════════════════════════╣
║  VENDORS                                                             ║
║    vendor1@demo.com  → TaskFlow Pro  ($49/mo, open_to_wl)            ║
║                        MRR ~$1,797 | Tier 2 (8%) | 38 direct+aff    ║
║    vendor2@demo.com  → InvoiceNinja  ($29/mo, open_to_resellers)     ║
║                        MRR ~$920  | Tier 1 (12%) | 33 direct+aff    ║
║    vendor3@demo.com  → AnalyticsHub  ($79/mo, custom cut 7%)         ║
║                        MRR ~$1,987 | Tier 2 (8% → 7% override)      ║
╠══════════════════════════════════════════════════════════════════════╣
║  RESELLERS (each has active $19/mo billing)                          ║
║    reseller1@demo.com  slug=softshop     TaskFlow @$59   6 subs      ║
║    reseller2@demo.com  slug=invoicepro   Invoice  @$39   6 subs      ║
║    reseller3@demo.com  slug=analytix     Analytics@$99   4 subs      ║
║    reseller4@demo.com  slug=devtools     TaskFlow @$55   6 subs      ║
║    reseller5@demo.com  slug=billmate     Invoice  @$35   5 subs      ║
║    reseller6@demo.com  slug=datavis      Analytics@$89   4 subs (WL T2)║
║    reseller7@demo.com  slug=taskmaster   TaskFlow @$65   5 subs      ║
║    reseller8@demo.com  slug=payeasy      Invoice  @$45   7 subs      ║
║    reseller9@demo.com  slug=insights     Analytics@$89   4 subs      ║
║   reseller10@demo.com  slug=appbundle    TaskFlow @$69   3 subs      ║
╠══════════════════════════════════════════════════════════════════════╣
║  AFFILIATES                                                           ║
║    affiliate1@demo.com  slug=techreviewer   TaskFlow  ×5  $245 MRR   ║
║    affiliate2@demo.com  slug=saasgeek       TaskFlow  ×5  $245 MRR   ║
║    affiliate3@demo.com  slug=productivehq   TaskFlow  ×3  $147 MRR   ║
║    affiliate4@demo.com  slug=cloudadviser   Invoice   ×5  $145 MRR   ║
║    affiliate5@demo.com  slug=softwareguru   Invoice   ×6  $174 MRR   ║
║    affiliate6@demo.com  slug=appreviews     Invoice   ×5  $145 MRR   ║
║    affiliate7@demo.com  slug=startuptips    Analytics ×5  $395 MRR   ║
║    affiliate8@demo.com  slug=devmarketer    Analytics ×4  $316 MRR   ║
║    affiliate9@demo.com  slug=saasblog       Analytics ×4  $316 MRR   ║
║   affiliate10@demo.com  slug=toolreviewer   Analytics ×3  $237 MRR   ║
╠══════════════════════════════════════════════════════════════════════╣
║  BUYERS: buyer1@demo.com … buyer143@demo.com (143 active subs)       ║
╠══════════════════════════════════════════════════════════════════════╣
║  TOTALS:  143 active subscriptions across 3 apps                     ║
║           58 TaskFlow | 51 InvoiceNinja | 34 AnalyticsHub            ║
║           Direct: 52 | Affiliate: 43 | Reseller: 48                  ║
╠══════════════════════════════════════════════════════════════════════╣
║  TO DELETE:  node scripts/seed-demo.mjs --cleanup                    ║
╚══════════════════════════════════════════════════════════════════════╝
`);
}

// ── entry point ──────────────────────────────────────────────────────────────
if (process.argv.includes('--cleanup')) {
  cleanup().catch(e => { console.error(e); process.exit(1); });
} else {
  seed().catch(e => { console.error(e); process.exit(1); });
}
