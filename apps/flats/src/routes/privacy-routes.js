import { timingSafeEqual } from 'node:crypto';

import { checkRate as defaultCheckRate } from '../support/request-rate-limit.js';
import { validateIntake, scopeSubjectData } from '../privacy/privacy-requests.js';
import { validateDispute, correctionPlan } from '../privacy/disputes.js';
import * as privacyRepository from '../infrastructure/database/privacyRequestRepository.js';
import * as reviewRepository from '../infrastructure/database/integrityReviewRepository.js';

/**
 * Privacy request API (§47) and the admin review API over it (§36, §49, §60).
 *
 * Public surface is two endpoints: submit a request, and look up a request's
 * status by its reference. Neither ever says whether any data about an
 * identifier exists -- otherwise the intake form would be a free lookup
 * service for "is this phone number in their database".
 *
 * Admin endpoints require PRIVACY_ADMIN_KEY specifically. The shared internal
 * key used by the queue and fetchers is deliberately NOT accepted: a secret
 * that crawler infrastructure holds must not unlock other people's personal
 * data (least privilege, §54).
 */

const ADMIN_KEY_MIN_LENGTH = 32;
const REVIEWER_MAX_LENGTH = 100;

function adminKeyMatches(actual, expected) {
  const actualBuffer = Buffer.from(String(actual ?? ''));
  const expectedBuffer = Buffer.from(String(expected ?? ''));
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

/** Admin authentication, returning the reviewer name every change is recorded under. */
function requireAdmin(req, res, env) {
  const expected = String(env.PRIVACY_ADMIN_KEY ?? '');
  if (expected.length < ADMIN_KEY_MIN_LENGTH) {
    res.status(503).json({ error: 'privacy_admin_not_configured' });
    return null;
  }
  if (!adminKeyMatches(req.get('x-admin-key'), expected)) {
    res.status(401).json({ error: 'unauthorized' });
    return null;
  }
  const reviewer = String(req.get('x-reviewer') ?? '').trim();
  if (!reviewer || reviewer.length > REVIEWER_MAX_LENGTH) {
    res.status(400).json({ error: 'reviewer_required' });
    return null;
  }
  return reviewer;
}

/** Responses here contain personal data or request state; no cache may keep them. */
function noStore(_req, res, next) {
  res.set('Cache-Control', 'no-store');
  next();
}

/**
 * Logs without personal data. Postgres errors can echo row values in their
 * `detail`, and request bodies here are personal data by definition, so only
 * the route and the error code are written.
 */
function failed(res, route, error, log) {
  log(`[privacy] ${route} failed: ${error?.code ?? error?.name ?? 'error'}`);
  res.status(500).json({ error: 'internal_error' });
}

function sendResult(res, result, okStatus = 200) {
  if (result?.ok) return res.status(okStatus).json(result);
  const status = result?.error === 'conflict' ? 409 : 400;
  return res.status(status).json(result ?? { ok: false, error: 'invalid' });
}

export function installPrivacyRoutes(app, deps = {}) {
  const privacy = deps.privacyRepository ?? privacyRepository;
  const review = deps.reviewRepository ?? reviewRepository;
  const checkRate = deps.checkRate ?? defaultCheckRate;
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((message) => console.error(message));

  app.use('/api/privacy', noStore);
  app.use('/api/admin/privacy', noStore);
  app.use('/api/admin/review', noStore);

  // --- public ---------------------------------------------------------------

  app.post('/api/privacy/requests', async (req, res) => {
    if (!checkRate(req, res, 'privacyIntake', 60_000)) return;
    const intake = validateIntake(req.body);
    if (!intake.ok) return res.status(400).json(intake);
    try {
      const created = await privacy.createPrivacyRequest(intake.request);
      // The same answer whether or not anything is held about the identifiers.
      return res.status(202).json({ ok: true, ...created });
    } catch (error) {
      return failed(res, 'intake', error, log);
    }
  });

  app.get('/api/privacy/requests/:reference', async (req, res) => {
    if (!checkRate(req, res, 'privacyStatus', 2_000)) return;
    try {
      const status = await privacy.findPrivacyRequestStatus(req.params.reference);
      return status ? res.json({ ok: true, ...status }) : res.status(404).json({ ok: false, error: 'not_found' });
    } catch (error) {
      return failed(res, 'status', error, log);
    }
  });

  // --- admin: privacy requests ----------------------------------------------

  app.get('/api/admin/privacy/requests', async (req, res) => {
    if (!requireAdmin(req, res, env)) return;
    try {
      const after = req.query.afterId ? { id: req.query.afterId, dueAt: req.query.afterDueAt } : null;
      return res.json(await privacy.listOpenPrivacyRequests({ limit: req.query.limit, after }));
    } catch (error) {
      return failed(res, 'list', error, log);
    }
  });

  app.post('/api/admin/privacy/requests/:id/transition', async (req, res) => {
    const reviewer = requireAdmin(req, res, env);
    if (!reviewer) return;
    try {
      return sendResult(res, await privacy.transitionPrivacyRequest({ id: req.params.id, to: req.body?.to, reason: req.body?.reason, reviewer }));
    } catch (error) {
      return failed(res, 'transition', error, log);
    }
  });

  app.post('/api/admin/privacy/requests/:id/verify', async (req, res) => {
    const reviewer = requireAdmin(req, res, env);
    if (!reviewer) return;
    try {
      return sendResult(res, await privacy.verifyRequestIdentifiers({ id: req.params.id, identifiers: req.body?.identifiers, method: req.body?.method, reviewer }));
    } catch (error) {
      return failed(res, 'verify', error, log);
    }
  });

  // The data an access or portability answer may contain, scoped to verified
  // identifiers only. Refuses outright while nothing is verified.
  app.get('/api/admin/privacy/requests/:id/subject-data', async (req, res) => {
    if (!requireAdmin(req, res, env)) return;
    try {
      const request = await privacy.getPrivacyRequest(req.params.id);
      if (!request) return res.status(404).json({ ok: false, error: 'not_found' });
      if (!request.verifiedIdentifiers.length) return res.status(409).json({ ok: false, error: 'identity_verification_required' });
      const records = await privacy.findSubjectRecords(request.verifiedIdentifiers);
      return sendResult(res, scopeSubjectData(request, records));
    } catch (error) {
      return failed(res, 'subject-data', error, log);
    }
  });

  app.post('/api/admin/privacy/restrictions', async (req, res) => {
    const reviewer = requireAdmin(req, res, env);
    if (!reviewer) return;
    try {
      return sendResult(res, await privacy.restrictProcessing({
        actorIds: Array.isArray(req.body?.actorIds) ? req.body.actorIds : [],
        contactPointIds: Array.isArray(req.body?.contactPointIds) ? req.body.contactPointIds : [],
        kind: req.body?.kind,
        note: req.body?.note,
        reviewer,
      }));
    } catch (error) {
      return failed(res, 'restrict', error, log);
    }
  });

  // --- admin: disputes ------------------------------------------------------

  app.post('/api/admin/privacy/disputes', async (req, res) => {
    if (!requireAdmin(req, res, env)) return;
    const dispute = validateDispute(req.body);
    if (!dispute.ok) return res.status(400).json(dispute);
    try {
      const created = await privacy.createDisputeCase(dispute.dispute);
      return res.status(201).json({ ok: true, ...created, correctionPlanIfUpheld: correctionPlan(dispute.dispute) });
    } catch (error) {
      return failed(res, 'dispute', error, log);
    }
  });

  app.post('/api/admin/privacy/disputes/:id/resolve', async (req, res) => {
    const reviewer = requireAdmin(req, res, env);
    if (!reviewer) return;
    try {
      return sendResult(res, await privacy.resolveDisputeCase({ id: req.params.id, outcome: req.body?.outcome, note: req.body?.note, reviewer }));
    } catch (error) {
      return failed(res, 'resolve-dispute', error, log);
    }
  });

  // --- admin: integrity review (Stage G repository) --------------------------

  app.get('/api/admin/review/queue', async (req, res) => {
    if (!requireAdmin(req, res, env)) return;
    try {
      const after = req.query.afterId
        ? { id: req.query.afterId, independentCount: req.query.afterCount, lastObservedAt: req.query.afterObservedAt }
        : null;
      return res.json(await review.listReviewQueue({ limit: req.query.limit, after }));
    } catch (error) {
      return failed(res, 'review-queue', error, log);
    }
  });

  app.post('/api/admin/review/evidence/:id/action', async (req, res) => {
    const reviewer = requireAdmin(req, res, env);
    if (!reviewer) return;
    try {
      return sendResult(res, await review.applyReviewAction({ evidenceId: req.params.id, action: req.body?.action, note: req.body?.note, reviewer }));
    } catch (error) {
      return failed(res, 'review-action', error, log);
    }
  });

  app.get('/api/admin/review/history/:subjectType/:id', async (req, res) => {
    if (!requireAdmin(req, res, env)) return;
    try {
      return res.json({ ok: true, items: await review.listReviewHistory({ subjectType: req.params.subjectType, subjectId: req.params.id, limit: req.query.limit }) });
    } catch (error) {
      return failed(res, 'review-history', error, log);
    }
  });
}

export const __privacyRoutesTest = { adminKeyMatches, ADMIN_KEY_MIN_LENGTH };
