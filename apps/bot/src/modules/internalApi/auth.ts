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

  const expectedBuffer = Buffer.from(secret);
  const actualBuffer = Buffer.from(header);

  if (
    expectedBuffer.length !== actualBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, actualBuffer)
  ) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
}
