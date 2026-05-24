/**
 * Owns: analytics queries for the admin dashboard (page views, signups, stats).
 * Does NOT own: page_view tracking middleware, kine CRUD, subscription logic.
 *
 * All queries exclude demo accounts (@demo.kinevia.pro) and beta/lifetime-free
 * accounts so the admin dashboard reflects real-user metrics only.
 *
 * COMMERCIAL_LAUNCH_DATE: Day 1 of the commercial phase. All "all time"
 * metrics use this as the floor — pre-launch test accounts and activity
 * are invisible to the analytics dashboard.
 */

// ── Commercial launch date ─────────────────────────────────────────
// 2026-05-17 = Day 1 of the first cold-email campaign (37 kinés).
// "all" period queries use this as their start date, not epoch.
const COMMERCIAL_LAUNCH_DATE = '2026-05-17';

// ── Exclusion filter ──────────────────────────────────────────────
// Subquery that returns kine IDs to exclude from every metric.
// Criteria: demo email domain OR lifetime_free flag.
const EXCLUDED_KINE_IDS = `(
  SELECT id FROM kines
  WHERE email LIKE '%@demo.kinevia.pro'
     OR lifetime_free = TRUE
)`;

// WHERE-safe fragment for the kines table itself (used in signup counts).
const KINE_EXCLUSION = `email NOT LIKE '%@demo.kinevia.pro' AND COALESCE(lifetime_free, FALSE) = FALSE`;

// ── Page views ────────────────────────────────────────────────────

/**
 * Daily page views + unique visitors, excluding views logged by demo/beta kinés.
 * Anonymous views (kine_id IS NULL) are kept — those are real public visitors.
 */
async function getDailyPageViews(pool, dateFilter) {
  const sql = `
    SELECT
      DATE(viewed_at AT TIME ZONE 'Europe/Paris') AS day,
      COUNT(*) AS views,
      COUNT(DISTINCT ip_hash) AS unique_visitors
    FROM page_views
    WHERE (kine_id IS NULL OR kine_id NOT IN ${EXCLUDED_KINE_IDS})
    ${dateFilter ? 'AND ' + dateFilter : ''}
    GROUP BY DATE(viewed_at AT TIME ZONE 'Europe/Paris')
    ORDER BY day ASC
  `;
  const result = await pool.query(sql);
  return result.rows;
}

/**
 * Total page views + unique visitors for the given period.
 */
async function getTotalPageViews(pool, dateFilter) {
  const sql = `
    SELECT
      COUNT(*) AS total_views,
      COUNT(DISTINCT ip_hash) AS total_unique
    FROM page_views
    WHERE (kine_id IS NULL OR kine_id NOT IN ${EXCLUDED_KINE_IDS})
    ${dateFilter ? 'AND ' + dateFilter : ''}
  `;
  const result = await pool.query(sql);
  return result.rows[0];
}

/**
 * Top pages by view count for the given period.
 */
async function getTopPages(pool, dateFilter, limit = 10) {
  const sql = `
    SELECT path, COUNT(*) AS views
    FROM page_views
    WHERE (kine_id IS NULL OR kine_id NOT IN ${EXCLUDED_KINE_IDS})
    ${dateFilter ? 'AND ' + dateFilter : ''}
    GROUP BY path
    ORDER BY views DESC
    LIMIT ${parseInt(limit, 10)}
  `;
  const result = await pool.query(sql);
  return result.rows;
}

// ── Signups ───────────────────────────────────────────────────────

/**
 * Daily signup count (real kinés only).
 */
async function getDailySignups(pool, dateFilter) {
  const sql = `
    SELECT
      DATE(created_at AT TIME ZONE 'Europe/Paris') AS day,
      COUNT(*) AS signups
    FROM kines
    WHERE ${KINE_EXCLUSION}
    ${dateFilter ? 'AND ' + dateFilter : ''}
    GROUP BY DATE(created_at AT TIME ZONE 'Europe/Paris')
    ORDER BY day ASC
  `;
  const result = await pool.query(sql);
  return result.rows;
}

/**
 * Total signup count for the given period.
 */
async function getTotalSignups(pool, dateFilter) {
  const sql = `
    SELECT COUNT(*) AS total_signups
    FROM kines
    WHERE ${KINE_EXCLUSION}
    ${dateFilter ? 'AND ' + dateFilter : ''}
  `;
  const result = await pool.query(sql);
  return parseInt(result.rows[0].total_signups, 10) || 0;
}

// ── Platform stats ────────────────────────────────────────────────

/**
 * Global platform stats (kines by subscription status, patients, programmes).
 * Excludes demo/beta kinés and their patients/programmes.
 * Only counts kinés who signed up on or after COMMERCIAL_LAUNCH_DATE.
 */
async function getPlatformStats(pool) {
  // Kines counted here = post-launch real users only (no demo, no lifetime_free).
  // Patients/programmes scoped to those same kines.
  const POST_LAUNCH_KINE_IDS = `(
    SELECT id FROM kines
    WHERE ${KINE_EXCLUSION}
      AND created_at >= '${COMMERCIAL_LAUNCH_DATE}'
  )`;

  const [kinesStats, patientsCount, programmesCount] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) AS total_kines,
        COUNT(*) FILTER (WHERE COALESCE(subscription_status, 'trialing') = 'trialing') AS trialing,
        COUNT(*) FILTER (WHERE COALESCE(subscription_status, 'trialing') = 'active') AS active,
        COUNT(*) FILTER (WHERE COALESCE(subscription_status, 'trialing') IN ('cancelled', 'canceled')) AS cancelled,
        COUNT(*) FILTER (WHERE COALESCE(subscription_status, 'trialing') = 'past_due') AS past_due,
        COUNT(*) FILTER (WHERE COALESCE(subscription_status, 'trialing') = 'expired') AS expired
      FROM kines
      WHERE ${KINE_EXCLUSION}
        AND created_at >= '${COMMERCIAL_LAUNCH_DATE}'
    `),
    pool.query(`
      SELECT COUNT(*) AS total
      FROM patients
      WHERE kine_id IN ${POST_LAUNCH_KINE_IDS}
    `),
    pool.query(`
      SELECT COUNT(*) AS total
      FROM programmes
      WHERE kine_id IN ${POST_LAUNCH_KINE_IDS}
    `),
  ]);

  const k = kinesStats.rows[0];
  return {
    total_kines: parseInt(k.total_kines, 10),
    total_patients: parseInt(patientsCount.rows[0].total, 10),
    total_programmes: parseInt(programmesCount.rows[0].total, 10),
    subscription_trialing: parseInt(k.trialing, 10),
    subscription_active: parseInt(k.active, 10),
    subscription_cancelled: parseInt(k.cancelled, 10),
    subscription_past_due: parseInt(k.past_due, 10),
    subscription_expired: parseInt(k.expired, 10),
  };
}

module.exports = {
  getDailyPageViews,
  getTotalPageViews,
  getTopPages,
  getDailySignups,
  getTotalSignups,
  getPlatformStats,
  // Exported for testing / reuse
  EXCLUDED_KINE_IDS,
  KINE_EXCLUSION,
  COMMERCIAL_LAUNCH_DATE,
};
