import fastify, { FastifyInstance } from 'fastify';
import Recording from '../recorder/recording';
import RecorderModule from '../recorder';
import { DEFAULT_REWARDS } from './rewards';
import { checkInternalSecret } from './auth';
import { sendWebhook } from './webhook';
import path from 'path';
import fs from 'fs';

const sessionToRecording = new Map<string, string>();

let server: FastifyInstance | null = null;

export async function startInternalApi(recorder: RecorderModule<any>, config: any) {
  server = fastify({ logger: false });

  const secret = process.env[config.secretEnv] || '';
  if (!secret) {
    recorder.logger.error('Internal API secret is not set. Refusing to start.');
    return;
  }
  const webhookUrl = process.env[config.webhookUrlEnv] || '';

  server.get('/internal/health', async () => {
    return { status: 'ok' };
  });

  server.register(async (instance) => {
    instance.addHook('preHandler', async (request, reply) => {
      await checkInternalSecret(request, reply, secret);
    });

    instance.post<{
      Body: {
        sessionId: string;
        guildId: string;
        channelId: string;
        initiatorUserId: string;
      };
    }>('/internal/record/start', async (request, reply) => {
      const { sessionId, guildId, channelId, initiatorUserId } = request.body;

      if (!sessionId || !guildId || !channelId || !initiatorUserId) {
        return reply.status(400).send({ error: 'Missing required fields' });
      }

      if (recorder.recordings.has(guildId)) {
        return reply.status(409).send({ error: 'Recording already exists for this guild' });
      }

      const guild = recorder.client.bot.guilds.get(guildId);
      if (!guild) return reply.status(404).send({ error: 'Guild not found' });

      const channel = guild.channels.get(channelId) as any;
      if (!channel || ![2, 13].includes(channel.type)) {
        return reply.status(400).send({ error: 'Invalid channel type' });
      }

      const user = await recorder.client.bot.getRESTUser(initiatorUserId);
      if (!user) return reply.status(404).send({ error: 'User not found' });

      const recording = new Recording(recorder as any, channel, user, true);
      recorder.recordings.set(guildId, recording);
      sessionToRecording.set(sessionId, recording.id);

      try {
        await recording.start(DEFAULT_REWARDS, false);
        return {
          recordingId: recording.id,
          sessionId,
          startedAt: new Date().toISOString()
        };
      } catch (error) {
        recorder.recordings.delete(guildId);
        sessionToRecording.delete(sessionId);
        throw error;
      }
    });

    instance.post<{ Body: { sessionId: string } }>('/internal/record/stop', async (request, reply) => {
      const { sessionId } = request.body;
      if (!sessionId) return reply.status(400).send({ error: 'Missing sessionId' });
      
      const recordingId = sessionToRecording.get(sessionId);
      if (!recordingId) return reply.status(404).send({ error: 'Session not found' });

      const recording = Array.from(recorder.recordings.values()).find((r) => r.id === recordingId);
      if (!recording) return reply.status(404).send({ error: 'Recording not found' });

      await recording.stop(true, 'n-us-internal');

      const filePath = path.join(recorder.recordingPath, `${recording.id}.ogg`);
      let fileSize = 0;
      try {
        if (fs.existsSync(filePath)) {
          fileSize = fs.statSync(filePath).size;
        }
      } catch (e) {}

      let webhookFailed = false;
      if (webhookUrl) {
        try {
          await sendWebhook(webhookUrl, secret, {
            sessionId,
            recordingId: recording.id,
            endedAt: new Date().toISOString(),
            durationMs: recording.startedAt ? Date.now() - recording.startedAt.getTime() : 0,
            fileSize
          });
        } catch (err: any) {
          webhookFailed = true;
          recorder.logger.error(`Webhook failed for session ${sessionId}: ${err.message}`);
        }
      }

      sessionToRecording.delete(sessionId);
      return {
        recordingId: recording.id,
        sessionId,
        endedAt: new Date().toISOString(),
        filePath: `${recording.id}.ogg`,
        webhookFailed
      };
    });

    instance.get<{ Params: { recordingId: string }; Querystring: { download?: string } }>(
      '/internal/record/:recordingId/file',
      async (request, reply) => {
        const { recordingId } = request.params;
        const filePath = path.join(recorder.recordingPath, `${recordingId}.ogg`);

        if (!fs.existsSync(filePath)) {
          return reply.status(404).send({ error: 'File not found' });
        }

        if (request.query.download === '1') {
          reply.header('Content-Disposition', `attachment; filename="${recordingId}.ogg"`);
        }

        const stream = fs.createReadStream(filePath);
        return reply.type('application/ogg').send(stream);
      }
    );
  });

  try {
    await server.listen({ port: config.port, host: config.host });
    recorder.logger.info(`Internal API listening on ${config.host}:${config.port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

export async function stopInternalApi() {
  if (server) {
    await server.close();
    server = null;
  }
}
