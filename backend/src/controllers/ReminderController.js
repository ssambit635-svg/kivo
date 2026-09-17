import { z } from 'zod';
import { ctxFromReq } from '../services/AuditService.js';
import { REMINDER_KINDS } from '../services/ReminderService.js';

export const reminderSchemas = {
  memberParams: z.object({ memberId: z.string().uuid() }),
  reminderParams: z.object({ reminderId: z.string().uuid() }),
  create: z.object({
    kind: z.enum(REMINDER_KINDS),
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(2000).nullish(),
    dueAt: z.string().min(1).max(64),
    repeatIntervalDays: z.number().int().min(1).max(3650).nullish(),
  }),
  update: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      notes: z.string().trim().max(2000).nullish().optional(),
      dueAt: z.string().min(1).max(64).optional(),
      repeatIntervalDays: z.number().int().min(1).max(3650).nullish().optional(),
      status: z.enum(['pending', 'done', 'dismissed']).optional(),
      snoozeUntil: z.string().min(1).max(64).nullish().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'At least one field is required' }),
  listQuery: z.object({
    kind: z.string().optional(),
    status: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  }),
};

export class ReminderController {
  constructor(reminderService) {
    this.reminders = reminderService;
  }

  create = (req, res, next) => {
    try {
      res.status(201).json(this.reminders.create(req.actor, req.params.memberId, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  list = (req, res, next) => {
    try {
      res.json(this.reminders.list(req.actor, req.params.memberId, req.query));
    } catch (e) {
      next(e);
    }
  };

  due = (req, res, next) => {
    try {
      res.json(this.reminders.due(req.actor, req.params.memberId));
    } catch (e) {
      next(e);
    }
  };

  update = (req, res, next) => {
    try {
      res.json(this.reminders.update(req.actor, req.params.reminderId, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  remove = (req, res, next) => {
    try {
      res.json(this.reminders.remove(req.actor, req.params.reminderId, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };
}
