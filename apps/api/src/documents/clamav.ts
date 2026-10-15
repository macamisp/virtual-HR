/**
 * FR-DOC-013: virus scanning with clamd over TCP (INSTREAM). Hand-written to avoid a
 * dependency: `zINSTREAM\0`, then chunks prefixed with a 4-byte big-endian length, then a
 * zero-length chunk. clamd answers `stream: OK`, `stream: <signature> FOUND` or `... ERROR`.
 * Anything that is not a clear OK or FOUND is an error, never "clean".
 */
import net from 'node:net';
import type { Readable } from 'node:stream';

export type ScanResult = { status: 'CLEAN' } | { status: 'INFECTED'; signature: string };

export interface ClamdOptions {
  host: string;
  port: number;
  timeoutMs: number;
}

export function clamdFromEnv(env: Record<string, string | undefined> = process.env): ClamdOptions {
  return {
    host: env.CLAMAV_HOST || 'localhost',
    port: Number.parseInt(env.CLAMAV_PORT || '3310', 10),
    timeoutMs: Number.parseInt(env.CLAMAV_TIMEOUT_MS || '120000', 10),
  };
}

const CHUNK = 64 * 1024;

export async function scanStream(source: Readable, opts: ClamdOptions): Promise<ScanResult> {
  const socket = net.createConnection({ host: opts.host, port: opts.port });
  socket.setTimeout(opts.timeoutMs);
  let reply = '';
  const done = new Promise<string>((resolve, reject) => {
    socket.on('data', (d) => {
      reply += d.toString('utf8');
    });
    socket.on('end', () => resolve(reply));
    socket.on('close', () => resolve(reply));
    socket.on('timeout', () => {
      socket.destroy();
      reject(new Error('clamd timed out'));
    });
    socket.on('error', (err) => reject(new Error(`clamd unavailable: ${err.message}`)));
  });
  // Surface connection failures before streaming.
  done.catch(() => undefined);

  const write = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (socket.destroyed) return reject(new Error('clamd connection closed early'));
      socket.write(buf, (err) => (err ? reject(err) : resolve()));
    });

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    await write(Buffer.from('zINSTREAM\0', 'latin1'));
    for await (const raw of source) {
      const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      for (let i = 0; i < data.length; i += CHUNK) {
        const part = data.subarray(i, i + CHUNK);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(part.length, 0);
        await write(Buffer.concat([len, part]));
      }
    }
    await write(Buffer.alloc(4));
  } catch (err) {
    socket.destroy();
    // clamd may have closed the socket with an explanation (e.g. size limit): prefer it.
    const said = await done.catch(() => '');
    if (said.includes('ERROR')) throw new Error(`clamd: ${said.replace(/\0/g, '').trim()}`);
    throw err instanceof Error ? err : new Error('clamd scan failed');
  }

  const text = (await done).replace(/\0/g, '').trim();
  const found = /^stream: (.+) FOUND$/.exec(text);
  if (found) return { status: 'INFECTED', signature: found[1]! };
  if (text === 'stream: OK') return { status: 'CLEAN' };
  throw new Error(`clamd: ${text || 'no answer'}`);
}
