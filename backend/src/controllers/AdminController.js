import { z } from 'zod';
import { ctxFromReq } from '../services/AuditService.js';

export const adminSchemas = {
  listUsersQuery: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
    q: z.string().trim().max(120).optional(),
  }),
  userParams: z.object({ userId: z.string().uuid() }),
  setStatus: z.object({ status: z.enum(['active', 'disabled']) }),
  auditQuery: z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
    userId: z.string().uuid().optional(),
    action: z.string().trim().max(120).optional(),
  }),
};

export class AdminController {
  constructor(adminService) {
    this.admin = adminService;
  }

  listUsers = (req, res, next) => {
    try {
      res.json(this.admin.listUsers(req.actor, req.query));
    } catch (e) {
      next(e);
    }
  };

  setUserStatus = (req, res, next) => {
    try {
      res.json(this.admin.setUserStatus(req.actor, req.params.userId, req.body.status, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  listAudit = (req, res, next) => {
    try {
      res.json(this.admin.listAudit(req.actor, req.query));
    } catch (e) {
      next(e);
    }
  };
}
