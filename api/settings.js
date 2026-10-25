import ftp from 'basic-ftp';
import crypto from 'crypto';
import { Readable, Writable } from 'stream';

// 업로드 설정을 FTP 서버의 JSON 파일에 저장해서 모든 기기에서 동일하게 불러온다.
// (별도 DB 없이 기존 FTP 환경변수만 사용)

const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const FTP_PORT = process.env.FTP_PORT || '21';
const FTP_PATH = process.env.FTP_PATH || '/';
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;

const SETTINGS_FILE = '.uploader-settings.json';
const MAX_VARIANTS = 10;
const MAX_VARIANT_PX = 8192;
const MAX_BODY_BYTES = 16 * 1024;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Allow', 'GET, PUT, OPTIONS');

  // 같은 도메인에서만 호출되므로 CORS 헤더는 설정하지 않는다.
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'PUT') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!FTP_HOST || !FTP_USER || !FTP_PASS) {
    console.error('[CONFIG_ERROR] Missing: FTP_HOST, FTP_USER, or FTP_PASS');
    return res.status(500).json({ error: 'Server configuration error', errorCode: 'ERR_CONFIG' });
  }

  if (!isAuthorized(req)) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader"');
    return res.status(401).json({ error: 'Authentication required' });
  }

  const remotePath = `${FTP_PATH.replace(/\/+$/, '')}/${SETTINGS_FILE}`;

  try {
    if (req.method === 'GET') {
      const stored = await readSettingsFile(remotePath);
      if (!stored) return res.status(200).json({ settings: null });
      return res.status(200).json({ settings: stored.settings, updatedAt: stored.updatedAt });
    }

    // PUT
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { body = null; }
    }
    if (!body || typeof body !== 'object') {
      return res.status(400).json({ error: 'Invalid JSON body', errorCode: 'ERR_INVALID_BODY' });
    }
    if (JSON.stringify(body).length > MAX_BODY_BYTES) {
      return res.status(413).json({ error: 'Settings too large', errorCode: 'ERR_TOO_LARGE' });
    }

    const settings = sanitizeSettings(body.settings);
    if (!settings) {
      return res.status(400).json({ error: 'Invalid settings', errorCode: 'ERR_INVALID_SETTINGS' });
    }

    const updatedAt = Date.now();
    await writeSettingsFile(remotePath, { settings, updatedAt });
    return res.status(200).json({ success: true, settings, updatedAt });
  } catch (error) {
    console.error('[SETTINGS_ERROR]', error.message);
    return res.status(500).json({ error: 'Settings sync failed', errorCode: 'ERR_SETTINGS_FAILED' });
  }
}

// ── 인증 (upload.js와 동일한 Basic Auth, 타이밍 공격 방지 비교) ──
function isAuthorized(req) {
  if (!AUTH_USER || !AUTH_PASS) return true;

  const header = req.headers.authorization || '';
  const [scheme, credentials] = header.split(' ');
  if (scheme !== 'Basic' || !credentials) return false;

  const decoded = Buffer.from(credentials, 'base64').toString();
  const i = decoded.indexOf(':');
  if (i === -1) return false;

  const userOk = safeEqual(decoded.substring(0, i), AUTH_USER);
  const passOk = safeEqual(decoded.substring(i + 1), AUTH_PASS);
  return userOk && passOk;
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ── 설정 검증: 알려진 필드만, 타입/범위 확인 ──
function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // 동기화 대상은 srcset 사용 여부와 사이즈 목록뿐 (그 외 필드는 무시)
  if (typeof raw.srcset !== 'boolean') return null;
  const out = { srcset: raw.srcset };

  if (!Array.isArray(raw.variants) || raw.variants.length > MAX_VARIANTS) return null;
  const seen = new Set();
  out.variants = [];
  for (const v of raw.variants) {
    if (!v || typeof v.name !== 'string' || !/^[a-z0-9_-]{1,30}$/.test(v.name)) return null;
    if (!Number.isInteger(v.px) || v.px < 1 || v.px > MAX_VARIANT_PX) return null;
    if (seen.has(v.name)) return null;
    seen.add(v.name);
    out.variants.push({ name: v.name, px: v.px });
  }
  return out;
}

// ── FTP ──
async function withClient(fn) {
  const client = new ftp.Client(30000);
  client.ftp.verbose = false;
  try {
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      port: parseInt(FTP_PORT),
      secure: false
    });
    return await fn(client);
  } finally {
    client.close();
  }
}

async function readSettingsFile(remotePath) {
  return withClient(async (client) => {
    const chunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) { chunks.push(chunk); cb(); }
    });
    try {
      await client.downloadTo(sink, remotePath);
    } catch (error) {
      if (error.code === 550) return null; // 파일 없음 = 아직 저장된 설정 없음
      throw error;
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const settings = sanitizeSettings(parsed.settings);
      if (!settings) return null; // 손상된 파일은 없는 것으로 취급
      return { settings, updatedAt: Number(parsed.updatedAt) || 0 };
    } catch {
      return null;
    }
  });
}

async function writeSettingsFile(remotePath, data) {
  return withClient(async (client) => {
    const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    if (dir) await client.ensureDir(dir);
    await client.uploadFrom(Readable.from([Buffer.from(JSON.stringify(data, null, 2), 'utf8')]), remotePath);
  });
}
