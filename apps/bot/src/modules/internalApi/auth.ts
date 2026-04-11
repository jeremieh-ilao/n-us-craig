import { FastifyReply, FastifyRequest } from 'fastify';
import crypto from 'crypto';

export async function checkInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply,
  secret: string
) {
  const header = request.headers['x-internal-secret'];
  if (!header || typeof header !== 'string') {
    return reply.status(401).send({ error: 'Unauthorized' });
  }

  const hmacKey = 'n-us-internal-auth';
  const expectedHmac = crypto.createHmac('sha256', hmacKey).update(secret).digest();
  const actualHmac = crypto.createHmac('sha256', hmacKey).update(header).digest();

  if (!crypto.timingSafeEqual(expectedHmac, actualHmac)) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}
