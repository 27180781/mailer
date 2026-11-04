import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from '../config.js';
import { one, pool, query } from '../db.js';

/**
 * Daily encrypted database backup to an S3-compatible bucket (Cloudflare R2).
 * pg_dump (custom format) → gzip → AES-256-GCM → multipart upload. Old backups are pruned.
 *
 * File format (.mlbk): "MLBK1" | salt(16) | iv(12) | ciphertext | tag(16)
 * The key is scrypt(BACKUP_PASSPHRASE, salt). Without the passphrase a backup can't be read.
 */

const MAGIC = Buffer.from('MLBK1');
const PREFIX = 'backups/';

export const backupConfig = () => ({
  endpoint: process.env.BACKUP_S3_ENDPOINT || '',
  bucket: process.env.BACKUP_S3_BUCKET || '',
  accessKeyId: process.env.BACKUP_S3_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.BACKUP_S3_SECRET_ACCESS_KEY || '',
  region: process.env.BACKUP_S3_REGION || 'auto',
  passphrase: process.env.BACKUP_PASSPHRASE || '',
  hour: Number(process.env.BACKUP_HOUR ?? '3'),
  retentionDays: Number(process.env.BACKUP_RETENTION_DAYS ?? '30'),
  pgDump: process.env.PG_DUMP_PATH || 'pg_dump',
});

export function backupConfigured() {
  const c = backupConfig();
  return !!(c.endpoint && c.bucket && c.accessKeyId && c.secretAccessKey && c.passphrase);
}

export interface BackupStore {
  upload(key: string, body: Readable): Promise<void>;
  list(): Promise<{ key: string; size: number; modified: Date }[]>;
  remove(key: string): Promise<void>;
  download(key: string): Promise<Readable>;
}

export function s3Store(): BackupStore {
  const c = backupConfig();
  const client = new S3Client({
    region: c.region,
    endpoint: c.endpoint,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    forcePathStyle: true,
  });
  return {
    async upload(key, body) {
      await new Upload({ client, params: { Bucket: c.bucket, Key: key, Body: body, ContentType: 'application/octet-stream' } }).done();
    },
    async list() {
      const out: { key: string; size: number; modified: Date }[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket: c.bucket, Prefix: PREFIX, ContinuationToken: token }));
        for (const o of r.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0, modified: o.LastModified ?? new Date(0) });
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out.sort((a, b) => b.modified.getTime() - a.modified.getTime());
    },
    async remove(key) {
      await client.send(new DeleteObjectCommand({ Bucket: c.bucket, Key: key }));
    },
    async download(key) {
      const r = await client.send(new GetObjectCommand({ Bucket: c.bucket, Key: key }));
      return r.Body as Readable;
    },
  };
}

/** Replaceable in tests */
export const backupDeps = { store: (): BackupStore => s3Store() };

function encryptor(passphrase: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
  let headerSent = false;
  return new Transform({
    transform(chunk, _enc, cb) {
      if (!headerSent) {
        this.push(Buffer.concat([MAGIC, salt, iv]));
        headerSent = true;
      }
      cb(null, cipher.update(chunk));
    },
    flush(cb) {
      if (!headerSent) this.push(Buffer.concat([MAGIC, salt, iv]));
      this.push(cipher.final());
      this.push(cipher.getAuthTag());
      cb();
    },
  });
}

/** Decrypts a whole backup file (for restore). */
export function decryptBackup(data: Buffer, passphrase: string): Buffer {
  if (!data.subarray(0, 5).equals(MAGIC)) throw new Error('not a mailer backup file');
  const salt = data.subarray(5, 21);
  const iv = data.subarray(21, 33);
  const tag = data.subarray(data.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', scryptSync(passphrase, salt, 32), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data.subarray(33, data.length - 16)), decipher.final()]);
}

function israelDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function israelHour(d = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jerusalem', hour: '2-digit', hourCycle: 'h23' }).format(d));
}

async function setStatus(value: Record<string, unknown>) {
  await query(
    `INSERT INTO system_kv (key, value, updated_at) VALUES ('backup_status', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(value)],
  );
}

export async function backupStatus() {
  const row = await one<{ value: string }>(`SELECT value FROM system_kv WHERE key = 'backup_status'`);
  return row ? JSON.parse(row.value) : null;
}

/** Runs one backup now. Guarded by an advisory lock so two workers never back up at once. */
export async function runBackup(reason: 'scheduled' | 'manual' = 'manual') {
  const c = backupConfig();
  if (!backupConfigured()) throw new Error('הגיבוי לא מוגדר: חסרים משתני BACKUP_S3_* או BACKUP_PASSPHRASE');
  const lock = await pool.connect();
  try {
    const got = await lock.query(`SELECT pg_try_advisory_lock(727001) AS ok`);
    if (!got.rows[0].ok) throw new Error('גיבוי אחר רץ כרגע');
    const started = Date.now();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const key = `${PREFIX}${israelDate()}/mailer-${stamp}.dump.gz.mlbk`;
    const store = backupDeps.store();
    let bytes = 0;
    try {
      const dump = spawn(c.pgDump, ['--format=custom', '--no-owner', '--no-privileges', '--dbname', config.databaseUrl], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      dump.stderr.on('data', (d) => (stderr += d.toString()));
      const exited = new Promise<number>((resolve, reject) => {
        dump.on('error', reject);
        dump.on('close', (code) => resolve(code ?? 1));
      });
      const counter = new Transform({ transform(chunk, _e, cb) { bytes += chunk.length; cb(null, chunk); } });
      const out = new PassThrough();
      const uploading = store.upload(key, out);
      await pipeline(dump.stdout, createGzip(), encryptor(c.passphrase), counter, out);
      const code = await exited;
      if (code !== 0) throw new Error(`pg_dump נכשל (${code}): ${stderr.trim().slice(0, 300)}`);
      await uploading;
    } catch (err: any) {
      await setStatus({ ok: false, at: new Date().toISOString(), reason, error: String(err?.message ?? err), key });
      throw err;
    }
    // Retention
    let pruned = 0;
    const cutoff = Date.now() - c.retentionDays * 86_400_000;
    for (const o of await store.list()) {
      if (o.modified.getTime() < cutoff) {
        await store.remove(o.key);
        pruned++;
      }
    }
    const status = { ok: true, at: new Date().toISOString(), day: israelDate(), reason, key, bytes, seconds: Math.round((Date.now() - started) / 1000), pruned };
    await setStatus(status);
    console.log(`backup: ${key} (${bytes} bytes, ${status.seconds}s, pruned ${pruned})`);
    return status;
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(727001)`).catch(() => {});
    lock.release();
  }
}

/** Called by the worker every few minutes: one backup per Israeli day, after BACKUP_HOUR. */
export async function maybeRunScheduledBackup(now = new Date()) {
  if (!backupConfigured()) return;
  const c = backupConfig();
  if (israelHour(now) < c.hour) return;
  const last = await backupStatus();
  if (last?.ok && last.day === israelDate(now)) return;
  // After a failure, wait an hour before retrying
  if (last && !last.ok && Date.now() - new Date(last.at).getTime() < 3_600_000) return;
  await runBackup('scheduled').catch((err) => console.error('scheduled backup failed', err));
}

export async function listBackups() {
  if (!backupConfigured()) return [];
  return (await backupDeps.store().list()).slice(0, 60);
}

/** Downloads and decrypts a backup to a pg_restore-ready buffer (custom format, gunzipped by the caller). */
export async function fetchBackup(key: string) {
  const c = backupConfig();
  const body = await backupDeps.store().download(key);
  const chunks: Buffer[] = [];
  for await (const ch of body) chunks.push(Buffer.from(ch));
  return decryptBackup(Buffer.concat(chunks), c.passphrase);
}
