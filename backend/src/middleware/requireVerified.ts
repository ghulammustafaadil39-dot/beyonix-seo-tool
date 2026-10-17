// S-01: gate for paid/cost-incurring features.
// Unverified accounts may sign up, verify, and browse, but cannot trigger
// crawls, keyword research, rank checks, content/geo generation, reports, or
// paid checkout until their email is verified.
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { ApiError } from '../errors.js';

let bypassWarned = false;

/** Fastify preHandler: use on routes that spend provider budget or money. */
export async function requireVerifiedEmail(req: FastifyRequest): Promise<void> {
  // DEV ONLY: local-testing bypass (DEV_BYPASS_EMAIL_VERIFICATION=true).
  // Never enable in production — see config.ts.
  if (config.devBypassEmailVerification) {
    if (!bypassWarned) {
      bypassWarned = true;
      req.log.warn(
        'DEV_BYPASS_EMAIL_VERIFICATION is ON — email-verification gate disabled. Never use in production.',
      );
    }
    return;
  }
  if (!req.tenant?.emailVerified) {
    throw new ApiError(
      403,
      'EMAIL_NOT_VERIFIED',
      'Please verify your email address to use this feature. Check your inbox for the verification link.',
    );
  }
}
