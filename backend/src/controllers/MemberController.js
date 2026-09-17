import { z } from 'zod';
import { ctxFromReq } from '../services/AuditService.js';

export const memberSchemas = {
  create: z.object({
    name: z.string().trim().min(1).max(120),
    relationship: z.enum(['self', 'parent', 'grandparent', 'spouse', 'child', 'sibling', 'other']).default('other'),
    dob: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).nullish(),
    sex: z.enum(['male', 'female', 'other']).nullish(),
    heightCm: z.number().min(30).max(280).nullish(),
    familyHistory: z.record(z.any()).optional(),
  }),
  update: z
    .object({
      name: z.string().trim().min(1).max(120).optional(),
      relationship: z.enum(['self', 'parent', 'grandparent', 'spouse', 'child', 'sibling', 'other']).optional(),
      dob: z.string().nullish(),
      sex: z.enum(['male', 'female', 'other']).nullish(),
      heightCm: z.number().min(30).max(280).nullish(),
      familyHistory: z.record(z.any()).optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'At least one field is required' }),
  share: z.object({
    granteeEmail: z.string().trim().toLowerCase().email().max(254),
    permission: z.enum(['viewer', 'editor']),
  }),
  memberParams: z.object({ memberId: z.string().uuid() }),
  revokeShareParams: z.object({ memberId: z.string().uuid(), granteeUserId: z.string().uuid() }),
};

export class MemberController {
  constructor(memberService) {
    this.members = memberService;
  }

  list = (req, res, next) => {
    try {
      res.json(this.members.listForActor(req.actor));
    } catch (e) {
      next(e);
    }
  };

  get = (req, res, next) => {
    try {
      res.json(this.members.getForActor(req.actor, req.params.memberId));
    } catch (e) {
      next(e);
    }
  };

  create = (req, res, next) => {
    try {
      res.status(201).json(this.members.create(req.actor, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  update = (req, res, next) => {
    try {
      res.json(this.members.update(req.actor, req.params.memberId, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  remove = (req, res, next) => {
    try {
      res.json(this.members.remove(req.actor, req.params.memberId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  familyHistory = (req, res, next) => {
    try {
      res.json(this.members.familyHistoryContext(req.actor, req.params.memberId));
    } catch (e) {
      next(e);
    }
  };

  listShares = (req, res, next) => {
    try {
      res.json({ items: this.members.listShares(req.actor, req.params.memberId) });
    } catch (e) {
      next(e);
    }
  };

  grantShare = (req, res, next) => {
    try {
      res.status(201).json(this.members.grantShare(req.actor, req.params.memberId, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  revokeShare = (req, res, next) => {
    try {
      res.json(this.members.revokeShare(req.actor, req.params.memberId, req.params.granteeUserId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };
}
