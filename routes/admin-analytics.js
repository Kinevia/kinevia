/**
 * Owns: /api/admin/analytics and /api/admin/stats route handlers.
 * Does NOT own: auth middleware, page-view tracking, kine CRUD.
 *
 * All metrics exclude demo (@demo.kinevia.pro) and beta (lifetime_free) accounts
 * and are floored at COMMERCIAL_LAUNCH_DATE (2026-05-17, Day 1 of cold email campaign).
 * Queries live in db/admin-analytics.js.
 */

const express = require('express');
const router = express.Router();
const analyticsDb = require('../db/admin-analytics');

/**
 * Factory: accepts pool + requireAdmin middleware from server.js.
 * Usage: app.use('/api/admin', require('./routes/admin-analytics')(pool, requireAdmin));
 */
module.exports = function mountAdminAnalytics(pool, requireAdmin) {

  // GET /api/admin/analytics — time-series page views + signups (filtered)
  router.get('/analytics', requireAdmin, async (req, res) => {
    try {
      const period = req.query.period || '30';
      let viewsDateFilter = '';
      let signupsDateFilter = '';

      // All periods are floored at COMMERCIAL_LAUNCH_DATE so pre-launch
      // test activity never appears in the dashboard.
      const launchFloorViews   = `viewed_at >= '${analyticsDb.COMMERCIAL_LAUNCH_DATE}'`;
      const launchFloorSignups = `created_at >= '${analyticsDb.COMMERCIAL_LAUNCH_DATE}'`;

      if (period === '7') {
        viewsDateFilter   = `viewed_at >= NOW() - INTERVAL '7 days' AND ${launchFloorViews}`;
        signupsDateFilter = `created_at >= NOW() - INTERVAL '7 days' AND ${launchFloorSignups}`;
      } else if (period === '30') {
        viewsDateFilter   = `viewed_at >= NOW() - INTERVAL '30 days' AND ${launchFloorViews}`;
        signupsDateFilter = `created_at >= NOW() - INTERVAL '30 days' AND ${launchFloorSignups}`;
      } else {
        // 'all' = since commercial launch (not epoch)
        viewsDateFilter   = launchFloorViews;
        signupsDateFilter = launchFloorSignups;
      }

      const [dailyViews, dailySignups, totals, totalSignups, topPages] = await Promise.all([
        analyticsDb.getDailyPageViews(pool, viewsDateFilter),
        analyticsDb.getDailySignups(pool, signupsDateFilter),
        analyticsDb.getTotalPageViews(pool, viewsDateFilter),
        analyticsDb.getTotalSignups(pool, signupsDateFilter),
        analyticsDb.getTopPages(pool, viewsDateFilter),
      ]);

      const totalViews = parseInt(totals.total_views, 10) || 0;
      const totalUnique = parseInt(totals.total_unique, 10) || 0;
      const conversionRate = totalUnique > 0
        ? ((totalSignups / totalUnique) * 100).toFixed(1)
        : '0.0';

      res.json({
        period,
        totals: {
          views: totalViews,
          unique_visitors: totalUnique,
          signups: totalSignups,
          conversion_rate: conversionRate,
        },
        daily_views: dailyViews.map(r => ({
          day: r.day,
          views: parseInt(r.views, 10),
          unique: parseInt(r.unique_visitors, 10),
        })),
        daily_signups: dailySignups.map(r => ({
          day: r.day,
          signups: parseInt(r.signups, 10),
        })),
        top_pages: topPages.map(r => ({
          path: r.path,
          views: parseInt(r.views, 10),
        })),
      });
    } catch (err) {
      console.error('[analytics] admin error:', err.message);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  // GET /api/admin/stats — global platform stats (filtered)
  router.get('/stats', requireAdmin, async (req, res) => {
    try {
      const stats = await analyticsDb.getPlatformStats(pool);
      res.json(stats);
    } catch (err) {
      console.error('Admin stats error:', err);
      res.status(500).json({ error: 'Erreur serveur' });
    }
  });

  return router;
};
