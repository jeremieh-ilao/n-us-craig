import fastify, { FastifyInstance } from 'fastify';
import { spawn } from 'child_process';
import Recording from '../recorder/recording';
import RecorderModule from '../recorder';
import { DEFAULT_REWARDS } from './rewards';
import { checkInternalSecret } from './auth';
import { sendWebhook } from './webhook';
import path from 'path';
import fs from 'fs';

const sessionToRecording = new Map<string, string>();

let server: FastifyInstance | null = null;

const COOK_SCRIPT_PATH = '/app/cook.sh';
const COOK_FORMAT = process.env.COOK_FORMAT || 'flac';
const COOK_CONTAINER = process.env.COOK_CONTAINER || 'mix';
const COOK_TIMEOUT_MS = parseInt(process.env.COOK_TIMEOUT_MS || '600000', 10); // 10 min default

/**
 * cook.sh を起動し、録音 fragments を単一 .ogg にまとめて
 * `<recordingPath>/<id>.cook.ogg` として保存する。
 */
async function runCook(
  recordingId: string,
  recorder: RecorderModule<any>
): Promise<{ outputPath: string; size: number }> {
  const outputPath = path.join(recorder.recordingPath, `${recordingId}.cook.ogg`);

  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const outStream = fs.createWriteStream(outputPath);
    const proc = spawn(COOK_SCRIPT_PATH, [recordingId, COOK_FORMAT, COOK_CONTAINER], {
      cwd: '/app',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
      }
    });

    let stderr = '';
    proc.stdout?.pipe(outStream);
    proc.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL');
      settle(() => reject(new Error(`cook timeout after ${COOK_TIMEOUT_MS}ms: ${stderr.slice(-200)}`)));
    }, COOK_TIMEOUT_MS);

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      settle(() => reject(new Error(`cook spawn failed: ${err.message}`)));
    });

    outStream.on('error', (err) => {
      clearTimeout(killTimer);
      proc.kill('SIGKILL');
      settle(() => reject(new Error(`cook output stream failed: ${err.message}`)));
    });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      outStream.end(() => {
        if (code !== 0) {
          // exit 0 でなくても /tmp 残骸を残さないようファイル削除
          try { fs.unlinkSync(outputPath); } catch {}
          return settle(() => reject(new Error(`cook exited ${code}: ${stderr.slice(-500)}`)));
        }

        let stats: fs.Stats;
        try {
          stats = fs.statSync(outputPath);
        } catch (e: any) {
          return settle(() => reject(new Error(`cook output stat failed: ${e.message}`)));
        }

        if (stats.size === 0) {
          try { fs.unlinkSync(outputPath); } catch {}
          return settle(() => reject(new Error(`cook produced empty output: ${stderr.slice(-200)}`)));
        }

        // Ogg magic byte (OggS = 4F 67 67 53) を検証
        // 空録音時に cook.sh が flac の usage を stdout に流す等の garbage を弾く
        try {
          const buf = Buffer.alloc(4);
          const fd = fs.openSync(outputPath, 'r');
          fs.readSync(fd, buf, 0, 4, 0);
          fs.closeSync(fd);
          const magic = buf.toString('ascii');
          if (magic !== 'OggS') {
            try { fs.unlinkSync(outputPath); } catch {}
            return settle(() =>
              reject(
                new Error(
                  `cook output is not a valid Ogg file (magic="${magic.replace(/[^\x20-\x7e]/g, '?')}", size=${stats.size}): ${stderr.slice(-200)}`
                )
              )
            );
          }
        } catch (e: any) {
          return settle(() => reject(new Error(`cook output magic check failed: ${e.message}`)));
        }

        settle(() => resolve({ outputPath, size: stats.size }));
      });
    });
  });
}

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

      // Cook: combine raw fragments into a single playable .ogg
      // Failure does not abort the stop response — bot side decides what to do via cookError.
      let cookFileSize = 0;
      let cookError: string | undefined;
      try {
        recorder.logger.info(`Cook starting for recording ${recording.id} (format=${COOK_FORMAT}, container=${COOK_CONTAINER})`);
        const t0 = Date.now();
        const cookResult = await runCook(recording.id, recorder);
        cookFileSize = cookResult.size;
        recorder.logger.info(`Cook complete for ${recording.id}: ${cookFileSize} bytes in ${Date.now() - t0}ms`);
      } catch (err: any) {
        cookError = err.message;
        recorder.logger.error(`Cook failed for ${recording.id}: ${err.message}`);
      }

      let webhookFailed = false;
      if (webhookUrl) {
        try {
          await sendWebhook(webhookUrl, secret, {
            sessionId,
            recordingId: recording.id,
            endedAt: new Date().toISOString(),
            durationMs: recording.startedAt ? Date.now() - recording.startedAt.getTime() : 0,
            fileSize: cookFileSize,
            cookError
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
        filePath: `${recording.id}.cook.ogg`,
        fileSize: cookFileSize,
        cookError,
        webhookFailed
      };
    });

    instance.get<{ Params: { recordingId: string }; Querystring: { download?: string } }>(
      '/internal/record/:recordingId/file',
      async (request, reply) => {
        const { recordingId } = request.params;
        const cookedPath = path.join(recorder.recordingPath, `${recordingId}.cook.ogg`);
        const rawPath = path.join(recorder.recordingPath, `${recordingId}.ogg`);

        // cooked が優先、なければ legacy raw を fallback
        let servePath: string | null = null;
        if (fs.existsSync(cookedPath)) {
          servePath = cookedPath;
        } else if (fs.existsSync(rawPath)) {
          servePath = rawPath;
        }

        if (!servePath) {
          return reply.status(404).send({ error: 'File not found' });
        }

        if (request.query.download === '1') {
          reply.header('Content-Disposition', `attachment; filename="${recordingId}.ogg"`);
        }

        const stream = fs.createReadStream(servePath);
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
