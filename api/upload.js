import ftp from 'basic-ftp';
import Busboy from 'busboy';
import crypto from 'crypto';
import { Readable } from 'stream';

const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const FTP_PORT = process.env.FTP_PORT || '21';
const FTP_PATH = process.env.FTP_PATH || '/';
const PUBLIC_URL = process.env.PUBLIC_URL;
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;

// 허용된 도메인
const ALLOWED_ORIGIN = 'https://ftp-image-uploader.vercel.app';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // CORS 설정 - 엄격한 도메인 화이트리스트
  const origin = req.headers.origin;
  const allowedOrigins = [
    ALLOWED_ORIGIN,
    'http://localhost:3000',
    'http://localhost:8000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:8000'
  ];
  
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  } else if (!origin) {
    // origin이 없는 경우 (Postman, curl 등 직접 요청)
    // Basic Auth가 있으므로 허용
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else {
    // 허용되지 않은 origin은 CORS 헤더를 설정하지 않음
    // 브라우저가 요청을 차단함
    console.warn('[CORS_BLOCKED]', origin);
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 필수 환경변수 체크
  if (!FTP_HOST || !FTP_USER || !FTP_PASS || !PUBLIC_URL) {
    console.error('[CONFIG_ERROR] Missing: FTP_HOST, FTP_USER, FTP_PASS, or PUBLIC_URL');
    return res.status(500).json({ 
      error: 'Server configuration error',
      errorCode: 'ERR_CONFIG'
    });
  }

  // Basic Auth 검증
  if (AUTH_USER && AUTH_PASS) {
    const auth = req.headers.authorization;
    
    if (!auth) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader"');
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const [scheme, credentials] = auth.split(' ');
    
    if (scheme !== 'Basic') {
      res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader"');
      return res.status(401).json({ error: 'Invalid authentication' });
    }
    
    const decoded = Buffer.from(credentials, 'base64').toString();
    const colonIndex = decoded.indexOf(':');
    
    if (colonIndex === -1) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader"');
      return res.status(401).json({ error: 'Invalid credentials format' });
    }
    
    const username = decoded.substring(0, colonIndex);
    const password = decoded.substring(colonIndex + 1);
    
    if (username !== AUTH_USER || password !== AUTH_PASS) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader"');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  }

  try {
    const file = await parseMultipartForm(req);

    if (!file) {
      return res.status(400).json({ error: 'No file provided', errorCode: 'ERR_NO_FILE' });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ 
        error: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP',
        errorCode: 'ERR_INVALID_TYPE'
      });
    }

    // 파일 시그니처 검증
    if (!isValidImageSignature(file.buffer, file.mimetype)) {
      return res.status(400).json({ 
        error: 'File signature does not match file type',
        errorCode: 'ERR_INVALID_SIGNATURE'
      });
    }

    if (file.buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ 
        error: 'File too large (max 10MB)',
        errorCode: 'ERR_FILE_TOO_LARGE'
      });
    }

    // 파일명 생성 (옛날 방식 사용 - UUID 대신 짧은 랜덤값)
    const filename = generateSecureFilename(file.filename);
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const isAd = file.isAd === 'true';
    const basePath = FTP_PATH.replace(/\/+$/, ''); // 끝 슬래시 제거
    const remotePath = isAd
      ? `${basePath}/ad`
      : `${basePath}/${year}/${month}`;
    const fullPath = `${remotePath}/${filename}`;

    // FTP 업로드 (옛날 방식 - Stream 사용)
    await uploadToFTP(file.buffer, fullPath);

    const publicBase = PUBLIC_URL.replace(/\/+$/, ''); // 끝 슬래시 제거
    const publicUrl = isAd
      ? `${publicBase}/ad/${filename}`
      : `${publicBase}/${year}/${month}/${filename}`;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const sizeKB = Math.round(file.buffer.length / 1024);
    console.log(`[UPLOAD_SUCCESS] ${filename} (${sizeKB}KB) from ${ip}`);

    return res.status(200).json({
      success: true,
      url: publicUrl,
      filename: filename,
      size: file.buffer.length,
      isAd: isAd,
      markdown: `![](${publicUrl})`
    });

  } catch (error) {
    console.error('[UPLOAD_ERROR]', error.message);
    console.error('[UPLOAD_ERROR_STACK]', error.stack);
    
    return res.status(500).json({ 
      error: 'Upload failed',
      details: error.message, // 디버깅용
      errorCode: 'ERR_UPLOAD_FAILED'
    });
  }
}

function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    let fileData = null;
    const fields = {};

    busboy.on('field', (fieldname, value) => {
      fields[fieldname] = value;
    });

    busboy.on('file', (fieldname, file, info) => {
      const chunks = [];
      file.on('data', (chunk) => chunks.push(chunk));
      file.on('end', () => {
        fileData = {
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimetype: info.mimeType
        };
      });
      file.on('error', reject);
    });

    busboy.on('finish', () => {
      if (fileData) fileData.isAd = fields.isAd || 'false';
      resolve(fileData);
    });
    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

// 파일명 생성 (옛날 방식 - 짧고 안전)
function generateSecureFilename(originalName) {
  const ext = originalName.split('.').pop().toLowerCase();
  const random = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now();
  return `img-${timestamp}-${random}.${ext}`;
}

// 파일 시그니처 검증 (매직 넘버)
function isValidImageSignature(buffer, mimetype) {
  if (buffer.length < 12) return false;

  const signatures = {
    'image/jpeg': [[0xFF, 0xD8, 0xFF]],
    'image/png': [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
    'image/gif': [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    'image/webp': [[0x52, 0x49, 0x46, 0x46]]
  };

  const expectedSigs = signatures[mimetype];
  if (!expectedSigs) return false;

  return expectedSigs.some(sig => {
    return sig.every((byte, index) => buffer[index] === byte);
  });
}

// Buffer를 Stream으로 변환
function bufferToStream(buffer) {
  const stream = new Readable();
  stream.push(buffer);
  stream.push(null);
  return stream;
}

// FTP 업로드 (옛날 방식 복원)
async function uploadToFTP(buffer, remotePath) {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    console.log('[FTP_CONNECT_START]', { host: FTP_HOST, port: FTP_PORT });

    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      port: parseInt(FTP_PORT),
      secure: false,
      timeout: 30000
    });

    console.log('[FTP_CONNECTED]');

    const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    await client.ensureDir(dir);
    
    console.log('[FTP_DIR_READY]', dir);

    // 핵심: Buffer를 Stream으로 변환해서 업로드
    const stream = bufferToStream(buffer);
    await client.uploadFrom(stream, remotePath);

    console.log('[FTP_UPLOAD_SUCCESS]', remotePath);

  } catch (error) {
    console.error('[FTP_ERROR]', {
      message: error.message,
      code: error.code,
      host: FTP_HOST
    });
    throw error;
  } finally {
    client.close();
  }
}
