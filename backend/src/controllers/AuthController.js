import { z } from 'zod';
import { ctxFromReq } from '../services/AuditService.js';

const emailSchema = z.string().trim().toLowerCase().email('Valid email required').max(254);
const passwordSchema = z.string().min(1, 'Password required').max(128);

export const authSchemas = {
  register: z.object({
    email: emailSchema,
    displayName: z.string().trim().min(1).max(120),
    password: z.string().min(12, 'Password must be at least 12 characters').max(128),
  }),
  login: z.object({ email: emailSchema, password: passwordSchema }),
  refresh: z.object({ refreshToken: z.string().min(20).max(512) }),
  logout: z.object({ refreshToken: z.string().min(20).max(512).optional() }),
  changePassword: z.object({
    currentPassword: passwordSchema,
    newPassword: z.string().min(12, 'Password must be at least 12 characters').max(128),
  }),
  deleteAccount: z.object({ password: passwordSchema }),
};

export class AuthController {
  constructor(authService, privacyService = null) {
    this.auth = authService;
    this.privacy = privacyService;
  }

  register = async (req, res, next) => {
    try {
      const session = await this.auth.register(req.body, ctxFromReq(req));
      res.status(201).json(session);
    } catch (e) {
      next(e);
    }
  };

  login = async (req, res, next) => {
    try {
      const session = await this.auth.login(req.body, ctxFromReq(req));
      res.json(session);
    } catch (e) {
      next(e);
    }
  };

  refresh = async (req, res, next) => {
    try {
      res.json(await this.auth.refresh(req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  logout = async (req, res, next) => {
    try {
      res.json(await this.auth.logout(req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  logoutAll = async (req, res, next) => {
    try {
      res.json(await this.auth.logoutAll(req.actor, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  changePassword = async (req, res, next) => {
    try {
      res.json(await this.auth.changePassword(req.actor, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  me = (req, res) => {
    res.json({ user: req.actor.toJSON() });
  };

  exportMyData = (req, res, next) => {
    try {
      res.json(this.privacy.exportFor(req.actor, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };

  deleteMe = async (req, res, next) => {
    try {
      res.json(await this.privacy.deleteAccount(req.actor, req.body, ctxFromReq(req)));
    } catch (e) {
      next(e);
    }
  };
}
