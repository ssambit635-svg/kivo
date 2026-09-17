import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../../utils/id.js';
import {
  NotFoundError,
  ValidationError,
  ForbiddenError,
  UnsupportedMediaError,
  PaymentRequiredError,
  PayloadTooLargeError,
} from '../../common/errors.js';
import { VIDEO_TOPIC_KEYS, VIDEO_CLAIM_LINT_NOTE, lintClaims, specialtyLabel } from './catalog.js';

const ALLOWED_MIME = {
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'video/quicktime': '.mov',
};

/**
 * The doctor shorts library.
 *
 * Two shapes of short are supported on purpose:
 *   • 'upload' — a real phone-shot clip, streamed through a signed URL
 *   • 'note'   — a caption-style short (title + key points) that still shows
 *                up in the feed and still earns pool share from watch time,
 *                so the demo has content without shipping binaries
 *
 * Access is entitlement-gated: preview shorts are free, the rest need Care+.
 */
export class VideoService {
  constructor({ config, videoRepository, doctorRepository, subscriptionService, mediaLinkService, auditService }) {
    this.config = config;
    this.videos = videoRepository;
    this.doctors = doctorRepository;
    this.subscriptions = subscriptionService;
    this.media = mediaLinkService;
    this.audit = auditService;
  }

  // -------------------------------------------------------------- doctor side
  publish(doctor, payload, file = null, ctx = {}) {
    const clean = this.validate(payload);
    let media = { kind: 'note', path: null, mime: null, bytes: null };
    if (file) media = this.storeFile(file);

    const video = this.videos.create({
      doctorId: doctor.id,
      title: clean.title,
      summary: clean.summary,
      topic: clean.topic,
      tags: clean.tags,
      keyPoints: clean.keyPoints,
      durationSec: clean.durationSec,
      language: clean.language,
      mediaKind: media.kind,
      mediaPath: media.path,
      mediaMime: media.mime,
      mediaBytes: media.bytes,
      isPreview: clean.isPreview,
      status: clean.status,
    });
    this.doctors.bumpCounter(doctor.id, 'video_count', 1);
    this.audit.record({
      userId: doctor.user_id,
      action: 'doctor.video_published',
      resourceType: 'doctor_video',
      resourceId: video.id,
      metadata: { topic: video.topic, mediaKind: video.media_kind, isPreview: !!video.is_preview },
      ctx,
    });
    return video.toJSON({ doctor, locked: false, includeMedia: true });
  }

  validate(payload) {
    const title = String(payload.title || '').trim();
    const summary = String(payload.summary || '').trim();
    const topic = String(payload.topic || '').trim();
    const keyPoints = Array.isArray(payload.keyPoints)
      ? payload.keyPoints.map((p) => String(p).trim()).filter(Boolean).slice(0, 8)
      : [];
    const tags = Array.isArray(payload.tags)
      ? payload.tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean).slice(0, 8)
      : [];

    if (title.length < 6) throw new ValidationError('Give the short a clearer title (at least 6 characters)');
    if (!VIDEO_TOPIC_KEYS.includes(topic)) {
      throw new ValidationError('Pick a valid topic for the short', [
        { path: 'topic', message: `Must be one of: ${VIDEO_TOPIC_KEYS.join(', ')}` },
      ]);
    }
    const durationSec = Number(payload.durationSec ?? 45);
    if (!Number.isFinite(durationSec) || durationSec < 5 || durationSec > 600) {
      throw new ValidationError('durationSec must be between 5 and 600 seconds');
    }

    // Claim lint: a health product's content cannot promise outcomes.
    const offenders = lintClaims([title, summary, ...keyPoints].join(' \n '));
    if (offenders.length > 0) {
      throw new ValidationError(
        `This short reads like a medical claim (${offenders.map((o) => `"${o}"`).join(', ')}). Rewrite it as education, not a promise.`,
        offenders.map((term) => ({ path: 'title', message: `Avoid the term "${term}"`, code: 'CLAIM_LINT' })),
      );
    }

    return {
      title,
      summary: summary || null,
      topic,
      keyPoints: keyPoints.length > 0 ? keyPoints : [summary || title],
      tags,
      durationSec: Math.round(durationSec),
      language: String(payload.language || 'en').slice(0, 12),
      isPreview: !!payload.isPreview,
      status: payload.status === 'draft' ? 'draft' : 'published',
    };
  }

  storeFile(file) {
    const ext = ALLOWED_MIME[file.mimetype];
    if (!ext) {
      throw new UnsupportedMediaError('Upload MP4, WebM or MOV video (or publish a caption short)');
    }
    if (file.size > this.config.maxVideoUploadBytes) {
      throw new PayloadTooLargeError('Video exceeds the configured upload limit');
    }
    fs.mkdirSync(this.config.videoDir, { recursive: true });
    const fileName = `${newId()}${ext}`;
    fs.writeFileSync(path.join(this.config.videoDir, fileName), file.buffer);
    return { kind: 'upload', path: fileName, mime: file.mimetype, bytes: file.size };
  }

  update(doctor, videoId, fields, ctx = {}) {
    const video = this.videos.findById(videoId);
    if (!video || video.doctor_id !== doctor.id) throw new NotFoundError('Video not found');
    if (fields.title || fields.summary || fields.keyPoints) {
      const offenders = lintClaims(
        [fields.title, fields.summary, ...(fields.keyPoints || [])].filter(Boolean).join(' \n '),
      );
      if (offenders.length > 0) {
        throw new ValidationError(`Remove claim language: ${offenders.join(', ')}`);
      }
    }
    const updated = this.videos.update(videoId, fields);
    this.audit.record({
      userId: doctor.user_id,
      action: 'doctor.video_updated',
      resourceType: 'doctor_video',
      resourceId: videoId,
      metadata: { fields: Object.keys(fields) },
      ctx,
    });
    return updated.toJSON({ doctor, locked: false, includeMedia: true });
  }

  archive(doctor, videoId, ctx = {}) {
    const video = this.videos.findById(videoId);
    if (!video || video.doctor_id !== doctor.id) throw new NotFoundError('Video not found');
    this.videos.update(videoId, { status: 'archived' });
    this.doctors.bumpCounter(doctor.id, 'video_count', -1);
    this.audit.record({
      userId: doctor.user_id,
      action: 'doctor.video_archived',
      resourceType: 'doctor_video',
      resourceId: videoId,
      ctx,
    });
    return { archived: true, id: videoId };
  }

  doctorLibrary(doctor) {
    const all = this.videos.listByDoctor(doctor.id);
    return {
      doctor: doctor.toJSON(),
      stats: {
        published: all.filter((v) => v.status === 'published').length,
        drafts: all.filter((v) => v.status === 'draft').length,
        views: all.reduce((sum, v) => sum + v.view_count, 0),
        watchSeconds: all.reduce((sum, v) => sum + v.watch_seconds_total, 0),
      },
      claimPolicy: VIDEO_CLAIM_LINT_NOTE,
      items: all.map((v) => v.toJSON({ doctor, locked: false, includeMedia: true })),
    };
  }

  /** Videos a doctor may attach to a consultation reply. */
  recommendable(doctor) {
    return this.videos
      .listByDoctor(doctor.id, { status: 'published' })
      .map((v) => ({
        id: v.id,
        title: v.title,
        topic: v.topic,
        topicLabel: specialtyLabel(v.topic),
        durationSec: v.duration_sec,
        isPreview: !!v.is_preview,
      }));
  }

  /** Verify + fetch videos a doctor attached to a reply (ownership enforced). */
  attachable(doctor, videoIds = []) {
    const out = [];
    for (const id of videoIds.slice(0, 3)) {
      const video = this.videos.findById(id);
      if (!video || video.doctor_id !== doctor.id || video.status !== 'published') {
        throw new NotFoundError('One of the selected videos is not available');
      }
      out.push(video);
    }
    return out;
  }

  // ------------------------------------------------------------- patient side
  /** Feed with entitlement-aware `locked` flags — the paywall is visible, not hidden. */
  feed(user, { topic = null, q = null, page = 1, pageSize = 20, previewOnly = false } = {}) {
    const ent = this.subscriptions.entitlements(user);
    const result = this.videos.listFeed({ topic, q, page, pageSize, previewOnly });
    const fullAccess = ent.videoAccess === 'full';
    return {
      items: result.items.map((v) =>
        v.toJSON({
          doctor: this.doctors.findById(v.doctor_id),
          locked: !fullAccess && !v.is_preview,
        }),
      ),
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
      topics: this.videos.topics().map((t) => ({ ...t, label: specialtyLabel(t.topic) })),
      access: {
        videoAccess: ent.videoAccess,
        fullAccess,
        subscriptionActive: ent.active,
        upsell: fullAccess ? null : 'Care+ unlocks the full doctor shorts library.',
      },
    };
  }

  /** Signed playback grant, or the caption payload for a 'note' short. */
  playback(user, videoId, ctx = {}) {
    const video = this.videos.findById(videoId);
    if (!video || video.status !== 'published') throw new NotFoundError('Video not found');
    const ent = this.subscriptions.entitlements(user);
    if (!video.is_preview && ent.videoAccess !== 'full') {
      throw new PaymentRequiredError(
        'This short is part of the Care+ library. Subscribe to watch the full library.',
        'SUBSCRIPTION_REQUIRED',
      );
    }
    this.audit.record({
      userId: user.id,
      action: 'video.playback_granted',
      resourceType: 'doctor_video',
      resourceId: video.id,
      metadata: { mediaKind: video.media_kind, preview: !!video.is_preview },
      ctx,
    });
    const doctor = this.doctors.findById(video.doctor_id);
    const base = {
      video: video.toJSON({ doctor, locked: false, includeMedia: true }),
      mediaKind: video.media_kind,
      captions: video.media_kind === 'note',
      note: 'Educational content from a verified doctor. Not a consultation and not medical advice.',
    };
    if (video.media_kind === 'upload' && video.media_path) {
      return { ...base, stream: this.media.sign({ videoId: video.id, userId: user.id }) };
    }
    return { ...base, stream: null, watchSeconds: video.duration_sec };
  }

  /**
   * Open a byte stream for a SIGNED, expiring playback link. The link itself
   * is the grant (it is user-bound and short-lived), so this path needs no
   * session — which is exactly what a <video src> needs.
   */
  openStream({ videoId, uid, exp, sig, rangeHeader = null }) {
    const video = this.videos.findById(videoId);
    if (!video || video.status !== 'published') throw new NotFoundError('Video not found');
    // Signature before capability: a tampered link is rejected the same way for
    // every video, so it cannot be used to probe which ids exist.
    if (!this.media.verify({ videoId, userId: uid, exp, sig })) {
      throw new ForbiddenError('This playback link is invalid or has expired', 'PLAYBACK_LINK_INVALID');
    }
    if (video.media_kind !== 'upload' || !video.media_path) {
      throw new NotFoundError('This short has no video stream (caption short)');
    }
    const absPath = this.media.resolveFile(video.media_path);
    const size = fs.statSync(absPath).size;
    const range = this.media.resolveRange({ size, rangeHeader });
    return { absPath, size, mime: video.media_mime || 'video/mp4', range };
  }

  recordWatch(user, videoId, { secondsWatched = 0, completed = false } = {}) {
    const video = this.videos.findById(videoId);
    if (!video || video.status !== 'published') throw new NotFoundError('Video not found');
    const ent = this.subscriptions.entitlements(user);
    if (!video.is_preview && ent.videoAccess !== 'full') {
      throw new PaymentRequiredError('Subscribe to watch this short', 'SUBSCRIPTION_REQUIRED');
    }
    // Clamp the client's claim: you cannot watch longer than the short exists.
    const claimed = Math.max(0, Math.min(video.duration_sec, Math.round(Number(secondsWatched) || 0)));
    const result = this.videos.recordView({
      videoId: video.id,
      doctorId: video.doctor_id,
      userId: user.id,
      secondsWatched: claimed,
      completed: completed || claimed >= video.duration_sec - 2,
    });
    return {
      recorded: true,
      secondsWatched: result.secondsWatched,
      period: result.period,
      poolNote: 'Watch time feeds the monthly shorts pool that pays this doctor.',
    };
  }
}
