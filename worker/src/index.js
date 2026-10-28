// Cloudflare Workers エントリポイント（D1 を保存先として使用）
import { handle } from './logic.js';
import facilityIdList from './facility-ids.json';

const facilityIds = new Set(facilityIdList.ids);

function d1Store(db) {
  return {
    async insertReport({ facilityId, level, createdAt }) {
      await db.prepare('INSERT INTO reports (facility_id, level, created_at) VALUES (?1, ?2, ?3)').bind(facilityId, level, createdAt).run();
    },
    async listReports(since) {
      const { results } = await db.prepare('SELECT facility_id, level, created_at FROM reports WHERE created_at >= ?1').bind(since).all();
      return results.map((r) => ({ facilityId: r.facility_id, level: r.level, createdAt: r.created_at }));
    },
    async countRateEvents({ clientKey, facilityId, since }) {
      const row = facilityId
        ? await db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE client_key = ?1 AND facility_id = ?2 AND created_at >= ?3').bind(clientKey, facilityId, since).first()
        : await db.prepare('SELECT COUNT(*) AS n FROM rate_events WHERE client_key = ?1 AND created_at >= ?2').bind(clientKey, since).first();
      return row?.n ?? 0;
    },
    async countFacilityReports({ facilityId, since }) {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM reports WHERE facility_id = ?1 AND created_at >= ?2').bind(facilityId, since).first();
      return row?.n ?? 0;
    },
    async insertRateEvent({ clientKey, facilityId, createdAt }) {
      await db.prepare('INSERT INTO rate_events (client_key, facility_id, created_at) VALUES (?1, ?2, ?3)').bind(clientKey, facilityId, createdAt).run();
    },
    async purge({ reportsBefore, rateEventsBefore }) {
      await db.batch([
        db.prepare('DELETE FROM reports WHERE created_at < ?1').bind(reportsBefore),
        db.prepare('DELETE FROM rate_events WHERE created_at < ?1').bind(rateEventsBefore),
      ]);
    },
  };
}

export default {
  async fetch(request, env) {
    try {
      return await handle(request, { env, store: d1Store(env.DB), facilityIds });
    } catch {
      // 例外の詳細（リクエスト内容を含みうる）はレスポンスにもログにも出さない
      return new Response(JSON.stringify({ ok: false, error: 'internal_error' }), {
        status: 500, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  },
  // 定期削除（wrangler.toml の crons で設定）
  async scheduled(_event, env) {
    const now = Date.now();
    const hours = Number(env.RETENTION_HOURS) || 24;
    await d1Store(env.DB).purge({ reportsBefore: now - hours * 3600000, rateEventsBefore: now - 3600000 });
  },
};
