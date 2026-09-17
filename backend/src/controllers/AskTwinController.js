import { z } from 'zod';
import { ctxFromReq } from '../services/AuditService.js';
import { MIN_QUESTION_LENGTH, MAX_QUESTION_LENGTH } from '../services/AskTwinService.js';

export const askTwinSchemas = {
  memberParams: z.object({ memberId: z.string().uuid() }),
  ask: z.object({
    question: z
      .string({ required_error: 'question is required' })
      .trim()
      .min(MIN_QUESTION_LENGTH, `question must be at least ${MIN_QUESTION_LENGTH} characters`)
      .max(MAX_QUESTION_LENGTH, `question must be at most ${MAX_QUESTION_LENGTH} characters`),
  }),
};

/**
 * Ask the Twin — grounded Q&A over the member's Digital Health Twin
 * (demo narrative §17 step 7). Read-only: same authorization surface as
 * trends (owner/editor/viewer may ask; strangers get 404; admins get no
 * health access). Every answer is deterministic + grounded in verified data.
 */
export class AskTwinController {
  constructor({ askTwinService }) {
    this.askTwin = askTwinService;
  }

  ask = async (req, res, next) => {
    try {
      const answer = await this.askTwin.ask(req.actor, req.params.memberId, req.body.question, ctxFromReq(req));
      res.json(answer);
    } catch (e) {
      next(e);
    }
  };

  suggestions = async (req, res, next) => {
    try {
      res.json(await this.askTwin.suggestions(req.actor, req.params.memberId));
    } catch (e) {
      next(e);
    }
  };
}
