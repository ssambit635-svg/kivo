import fs from 'node:fs';
import { z } from 'zod';
import { ctxFromReq } from '../services/AuditService.js';

const uuid = z.string().uuid();
const PAYMENT_METHODS = ['upi', 'card', 'netbanking', 'wallet'];

export const careSchemas = {
  doctorListQuery: z.object({
    specialty: z.string().trim().max(60).optional(),
    city: z.string().trim().max(80).optional(),
    q: z.string().trim().max(80).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  }),
  doctorParams: z.object({ doctorId: z.string().min(1).max(120) }),
  subscribe: z.object({
    planCode: z.enum(['care_monthly', 'care_yearly']),
    method: z.enum(PAYMENT_METHODS).default('upi'),
    simulate: z.enum(['success', 'failure']).default('success'),
  }),
  paymentIntent: z
    .object({
      purpose: z.enum(['subscription', 'consultation']),
      planCode: z.enum(['care_monthly', 'care_yearly']).optional(),
      consultationId: uuid.optional(),
      amountInr: z.number().int().min(0).max(100000).optional(),
    })
    .refine((o) => (o.purpose === 'subscription' ? !!o.planCode : o.amountInr != null), {
      message: 'planCode is required for subscription intents; amountInr for consultation intents',
    }),
  confirmPayment: z.object({
    method: z.enum(PAYMENT_METHODS).default('upi'),
    simulate: z.enum(['success', 'failure']).default('success'),
  }),
  intentParams: z.object({ intentId: uuid }),
  bookConsultation: z.object({
    memberId: uuid,
    doctorId: uuid,
    subject: z.string().trim().min(4).max(160),
    question: z.string().trim().min(20).max(2000),
    shareHealthData: z.boolean().default(true),
  }),
  consultationParams: z.object({ consultationId: uuid }),
  consultationListQuery: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
  }),
  message: z.object({ body: z.string().trim().min(2).max(2000) }),
  videoFeedQuery: z.object({
    topic: z.string().trim().max(60).optional(),
    q: z.string().trim().max(80).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(50).default(20),
    previewOnly: z.coerce.boolean().default(false),
  }),
  videoParams: z.object({ videoId: uuid }),
  watch: z.object({
    secondsWatched: z.number().int().min(0).max(3600),
    completed: z.boolean().optional(),
  }),
};

/**
 * Patient-facing care API: subscription (mock billing), doctor directory,
 * consultations with scoped chart consent, and the shorts library.
 */
export class CareController {
  constructor({ subscriptionService, doctorService, consultationService, videoService }) {
    this.subscriptions = subscriptionService;
    this.doctors = doctorService;
    this.consultations = consultationService;
    this.videos = videoService;
  }

  // ------------------------------------------------------------ subscription
  plans = (_req, res) => {
    res.json({
      plans: this.subscriptions.plans(),
      billing: {
        mode: 'mock',
        provider: 'mock-gateway',
        notice:
          'Hackathon build: plans, payments and the payout ledger are simulated. No real gateway is contacted and ' +
          'no card/UPI credential is ever collected or stored.',
      },
      revenueModel: this.subscriptions.revenueModel(),
    });
  };

  entitlements = (req, res, next) => {
    try {
      res.json({ entitlements: this.subscriptions.entitlements(req.actor) });
    } catch (e) {
      next(e);
    }
  };

  subscribe = (req, res, next) => {
    try {
      res.status(201).json(this.subscriptions.subscribe(req.actor, { ...req.body, ctx: ctxFromReq(req) }));
    } catch (e) {
      next(e);
    }
  };

  cancelSubscription = (req, res, next) => {
    try {
      res.json(this.subscriptions.cancel(req.actor, { ctx: ctxFromReq(req) }));
    } catch (e) {
      next(e);
    }
  };

  createIntent = (req, res, next) => {
    try {
      const intent = this.subscriptions.createIntent(req.actor, { ...req.body, ctx: ctxFromReq(req) });
      res.status(201).json({ payment: intent.toJSON() });
    } catch (e) {
      next(e);
    }
  };

  confirmIntent = (req, res, next) => {
    try {
      const settled = this.subscriptions.settleIntent(req.actor, req.params.intentId, {
        ...req.body,
        ctx: ctxFromReq(req),
      });
      const consultation =
        settled && settled.purpose === 'consultation'
          ? this.consultations.onPaymentSettled(settled, ctxFromReq(req))
          : null;
      res.json({
        payment: settled.toJSON(),
        consultation,
        entitlements: this.subscriptions.entitlements(req.actor),
      });
    } catch (e) {
      next(e);
    }
  };

  payments = (req, res, next) => {
    try {
      res.json({ payments: this.subscriptions.listPayments(req.actor) });
    } catch (e) {
      next(e);
    }
  };

  // ---------------------------------------------------------------- doctors
  directory = (req, res, next) => {
    try {
      res.json(this.doctors.directory(req.query));
    } catch (e) {
      next(e);
    }
  };

  specialties = (_req, res, next) => {
    try {
      res.json({ specialties: this.doctors.specialties() });
    } catch (e) {
      next(e);
    }
  };

  doctorProfile = (req, res, next) => {
    try {
      res.json({ doctor: this.doctors.publicProfile(req.params.doctorId) });
    } catch (e) {
      next(e);
    }
  };

  // ----------------------------------------------------------- consultations
  bookConsultation = (req, res, next) => {
    try {
      const result = this.consultations.book(req.actor, req.body, ctxFromReq(req));
      res.status(201).json(result);
    } catch (e) {
      next(e);
    }
  };

  myConsultations = (req, res, next) => {
    try {
      res.json(this.consultations.listMine(req.actor, { page: req.query.page, pageSize: req.query.pageSize }));
    } catch (e) {
      next(e);
    }
  };

  myConsultation = async (req, res, next) => {
    try {
      res.json(await this.consultations.getMine(req.actor, req.params.consultationId));
    } catch (e) {
      next(e);
    }
  };

  postMessage = (req, res, next) => {
    try {
      const message = this.consultations.addPatientMessage(
        req.actor,
        req.params.consultationId,
        req.body.body,
        ctxFromReq(req),
      );
      res.status(201).json({ message });
    } catch (e) {
      next(e);
    }
  };

  revokeConsent = (req, res, next) => {
    try {
      res.json(this.consultations.revokeConsent(req.actor, req.params.consultationId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  closeConsultation = (req, res, next) => {
    try {
      res.json(this.consultations.closeMine(req.actor, req.params.consultationId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  // ----------------------------------------------------------------- videos
  videoFeed = (req, res, next) => {
    try {
      res.json(this.videos.feed(req.actor, req.query));
    } catch (e) {
      next(e);
    }
  };

  playback = (req, res, next) => {
    try {
      res.json(this.videos.playback(req.actor, req.params.videoId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  watch = (req, res, next) => {
    try {
      res.json(this.videos.recordWatch(req.actor, req.params.videoId, req.body));
    } catch (e) {
      next(e);
    }
  };

  /**
   * Signed media stream. No session here by design: the expiring, user-bound
   * signature IS the authorization (a <video> tag cannot send headers).
   */
  mediaStream = (req, res, next) => {
    try {
      const opened = this.videos.openStream({
        videoId: req.params.videoId,
        uid: req.query.uid,
        exp: req.query.exp,
        sig: req.query.sig,
        rangeHeader: req.headers.range,
      });
      res.setHeader('Content-Type', opened.mime);
      res.setHeader('Accept-Ranges', 'bytes');
      if (opened.range.invalid) {
        res.status(416).setHeader('Content-Range', `bytes */${opened.size}`);
        return res.end();
      }
      if (opened.range.partial) {
        res.status(206);
        res.setHeader('Content-Range', `bytes ${opened.range.start}-${opened.range.end}/${opened.size}`);
      }
      res.setHeader('Content-Length', String(opened.range.length ?? opened.size));
      return fs
        .createReadStream(opened.absPath, { start: opened.range.start, end: opened.range.end })
        .on('error', next)
        .pipe(res);
    } catch (e) {
      return next(e);
    }
  };

  // ------------------------------------------------------------------ home
  /** One call for the care tab: plan, upcoming consultations, suggested shorts. */
  home = (req, res, next) => {
    try {
      const entitlements = this.subscriptions.entitlements(req.actor);
      const consultations = this.consultations.listMine(req.actor, { page: 1, pageSize: 5 });
      const videos = this.videos.feed(req.actor, { page: 1, pageSize: 6 });
      const topDoctors = this.doctors.directory({ page: 1, pageSize: 4 });
      res.json({
        entitlements,
        consultations: consultations.items,
        videos: videos.items,
        doctors: topDoctors.items,
        billing: { mode: 'mock', notice: 'Demo billing — no real gateway, no real money.' },
      });
    } catch (e) {
      next(e);
    }
  };
}
