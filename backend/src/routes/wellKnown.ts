// W-07: /.well-known/security.txt (RFC 9116). Registered at the APP root,
// not under /api/v1, because scanners and researchers request the literal
// path. Served as text/plain with a 24h cache. The Contact address is the
// product's real support address (beyonixsolutions.com).
import type { FastifyInstance } from 'fastify';

const SECURITY_CONTACT = 'mailto:security@beyonixsolutions.com';

export function securityTxtBody(expires: Date): string {
  return [
    `Contact: ${SECURITY_CONTACT}`,
    'Expires: ' + expires.toUTCString().replace('GMT', 'Z').slice(0, 20) + '+00:00',
    'Preferred-Languages: en',
    'Policy: https://beyonixsolutions.com/security',
    'Canonical: https://api.beyonixsolutions.com/.well-known/security.txt',
  ].join('\n') + '\n';
}

export async function registerWellKnownRoutes(fastify: FastifyInstance) {
  fastify.get('/.well-known/security.txt', async (_req, reply) => {
    const expires = new Date();
    expires.setFullYear(expires.getFullYear() + 1);
    return reply
      .header('Content-Type', 'text/plain; charset=utf-8')
      .header('Cache-Control', 'public, max-age=86400')
      .send(securityTxtBody(expires));
  });
}
