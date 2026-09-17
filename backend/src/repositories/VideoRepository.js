import { BaseRepository } from './BaseRepository.js';
import { DoctorVideo } from '../domain/care.js';

/**
 * Doctor short-video library + watch sessions.
 *
 * Watch sessions are the honest signal behind the doctor revenue model: the
 * monthly video pool is split by *watched seconds*, not by view counts, so a
 * doctor cannot farm the pool with clickbait thumbnails.
 */
export class VideoRepository extends BaseRepository {
  constructor(db) {
    super(db);
    this.table = 'doctor_videos';
  }

  create({
    doctorId,
    title,
    summary = null,
    topic,
    tags = [],
    keyPoints = [],
    durationSec = 45,
    language = 'en',
    mediaKind = 'note',
    mediaPath = null,
    mediaMime = null,
    mediaBytes = null,
    isPreview = false,
    status = 'published',
  }) {
    const id = this.id();
    const now = this.now();
    this.db.run(
      `INSERT INTO doctor_videos
         (id, doctor_id, title, summary, topic, tags, key_points, duration_sec, language,
          media_kind, media_path, media_mime, media_bytes, is_preview, status, published_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      doctorId,
      title,
      summary,
      topic,
      JSON.stringify(tags),
      JSON.stringify(keyPoints),
      durationSec,
      language,
      mediaKind,
      mediaPath,
      mediaMime,
      mediaBytes,
      isPreview ? 1 : 0,
      status,
      status === 'published' ? now : null,
      now,
      now,
    );
    return this.findById(id);
  }

  findById(id) {
    return DoctorVideo.fromRow(this.db.get('SELECT * FROM doctor_videos WHERE id = ?', id));
  }

  static UPDATABLE = {
    title: 'title',
    summary: 'summary',
    topic: 'topic',
    tags: 'tags',
    keyPoints: 'key_points',
    durationSec: 'duration_sec',
    language: 'language',
    isPreview: 'is_preview',
    status: 'status',
  };

  update(id, fields) {
    const sets = [];
    const params = [];
    for (const [key, column] of Object.entries(VideoRepository.UPDATABLE)) {
      if (!(key in fields) || fields[key] === undefined) continue;
      const value = Array.isArray(fields[key]) ? JSON.stringify(fields[key]) : fields[key];
      sets.push(`${column} = ?`);
      params.push(typeof value === 'boolean' ? (value ? 1 : 0) : value);
    }
    if (sets.length === 0) return this.findById(id);
    if (fields.status === 'published') {
      sets.push('published_at = COALESCE(published_at, ?)');
      params.push(this.now());
    }
    sets.push('updated_at = ?');
    params.push(this.now(), id);
    this.db.run(`UPDATE doctor_videos SET ${sets.join(', ')} WHERE id = ?`, ...params);
    return this.findById(id);
  }

  remove(id) {
    return this.db.run('DELETE FROM doctor_videos WHERE id = ?', id).changes ?? 0;
  }

  /** Patient-facing feed: published videos only, optionally by topic/search. */
  listFeed({ topic = null, q = null, doctorId = null, previewOnly = false, page = 1, pageSize = 20 } = {}) {
    const params = [];
    let where = `status = 'published'`;
    if (topic) {
      where += ' AND topic = ?';
      params.push(topic);
    }
    if (doctorId) {
      where += ' AND doctor_id = ?';
      params.push(doctorId);
    }
    if (previewOnly) where += ' AND is_preview = 1';
    if (q) {
      where += ' AND (LOWER(title) LIKE ? OR LOWER(COALESCE(summary, \'\')) LIKE ? OR LOWER(tags) LIKE ?)';
      const needle = `%${String(q).toLowerCase()}%`;
      params.push(needle, needle, needle);
    }
    const total = this.count(where, params);
    const rows = this.db.all(
      `SELECT * FROM doctor_videos WHERE ${where}
       ORDER BY is_preview DESC, view_count DESC, published_at DESC
       LIMIT ? OFFSET ?`,
      ...params,
      pageSize,
      (page - 1) * pageSize,
    );
    return { items: rows.map(DoctorVideo.fromRow), total, page, pageSize };
  }

  listByDoctor(doctorId, { status = null } = {}) {
    const params = [doctorId];
    let where = 'doctor_id = ?';
    if (status) {
      where += ' AND status = ?';
      params.push(status);
    }
    return this.db
      .all(`SELECT * FROM doctor_videos WHERE ${where} ORDER BY created_at DESC`, ...params)
      .map(DoctorVideo.fromRow);
  }

  topics() {
    return this.db
      .all(
        `SELECT topic, COUNT(*) AS videos FROM doctor_videos WHERE status = 'published'
         GROUP BY topic ORDER BY videos DESC, topic ASC`,
      )
      .map((r) => ({ topic: r.topic, videos: r.videos }));
  }

  // ------------------------------------------------------------------ views
  recordView({ videoId, doctorId, userId = null, memberId = null, secondsWatched = 0, completed = false }) {
    const id = this.id();
    const now = this.now();
    const safeSeconds = Math.max(0, Math.min(7200, Math.round(Number(secondsWatched) || 0)));
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO video_views (id, video_id, doctor_id, user_id, member_id, seconds_watched, completed, period, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        videoId,
        doctorId,
        userId,
        memberId,
        safeSeconds,
        completed ? 1 : 0,
        now.slice(0, 7),
        now,
      );
      this.db.run(
        `UPDATE doctor_videos SET view_count = view_count + 1,
           watch_seconds_total = watch_seconds_total + ?, updated_at = ? WHERE id = ?`,
        safeSeconds,
        now,
        videoId,
      );
    });
    return { id, secondsWatched: safeSeconds, period: now.slice(0, 7) };
  }

  /** Watch seconds per doctor for a period — the input to the video-pool split. */
  watchSecondsByDoctor(period) {
    return this.db.all(
      `SELECT doctor_id, COUNT(*) AS views, COALESCE(SUM(seconds_watched), 0) AS seconds
       FROM video_views WHERE period = ? GROUP BY doctor_id ORDER BY seconds DESC`,
      period,
    );
  }

  watchSecondsForDoctor(doctorId, { period = null } = {}) {
    const row = period
      ? this.db.get(
          `SELECT COUNT(*) AS views, COALESCE(SUM(seconds_watched), 0) AS seconds
           FROM video_views WHERE doctor_id = ? AND period = ?`,
          doctorId,
          period,
        )
      : this.db.get(
          `SELECT COUNT(*) AS views, COALESCE(SUM(seconds_watched), 0) AS seconds
           FROM video_views WHERE doctor_id = ?`,
          doctorId,
        );
    return { views: row ? row.views : 0, seconds: row ? row.seconds : 0 };
  }

  topVideosForDoctor(doctorId, { limit = 5 } = {}) {
    return this.db
      .all(
        `SELECT id, title, view_count, watch_seconds_total, is_preview FROM doctor_videos
         WHERE doctor_id = ? ORDER BY view_count DESC, published_at DESC LIMIT ?`,
        doctorId,
        limit,
      )
      .map((r) => ({
        id: r.id,
        title: r.title,
        viewCount: r.view_count,
        watchSeconds: r.watch_seconds_total,
        isPreview: !!r.is_preview,
      }));
  }
}
