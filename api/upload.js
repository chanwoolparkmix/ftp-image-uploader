import ftp from 'basic-ftp';
import Busboy from 'busboy';
import crypto from 'crypto';

const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const FTP_PORT = process.env.FTP_PORT || '21';
const FTP_PATH = process.env.FTP_PATH || '/';
const PUBLIC_URL = process.env.PUBLIC_URL;
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;

// 허용된 도메인 (환경변수로 설정 가능)
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://ftp-image-uploader.vercel.app';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // CORS 설정 - 특정 도메인만 허용
  const origin = req.headers.origin;
  if (origin === ALLOWED_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Basic Auth 검증
  if (AUTH_USER && AUTH_PASS) {
    const authHeader = req.headers.authorization;
    
    if (!authHeader) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    try {
      const [scheme, credentials] = authHeader.split(' ');
      
      if (scheme !== 'Basic') {
        res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader", charset="UTF-8"');
        return res.status(401).json({ error: 'Invalid authentication scheme' });
      }
      
      const decoded = Buffer.from(credentials, 'base64').toString('utf-8');
      const colonIndex = decoded.indexOf(':');
      
      if (colonIndex === -1) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader", charset="UTF-8"');
        return res.status(401).json({ error: 'Invalid credentials format' });
      }
      
      const username = decoded.substring(0, colonIndex);
      const password = decoded.substring(colonIndex + 1);
      
      if (username !== AUTH_USER || password !== AUTH_PASS) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader", charset="UTF-8"');
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      
    } catch (error) {
      console.error('[AUTH_ERROR]', error.message);
      res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentication failed' });
    }
  }

  try {
    const file = await parseMultipartForm(req);
    
    if (!file) {
      return res.status(400).json({ error: 'No file provided', errorCode: 'ERR_NO_FILE' });
    }

    // MIME 타입 검증
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ 
        error: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP',
        errorCode: 'ERR_INVALID_TYPE'
      });
    }

    // 파일 시그니처 검증 (매직 넘버)
    if (!isValidImageSignature(file.buffer, file.mimetype)) {
      return res.status(400).json({ 
        error: 'File signature does not match file type',
        errorCode: 'ERR_INVALID_SIGNATURE'
      });
    }

    // 5MB 제한
    if (file.buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ 
        error: 'File too large (max 5MB after optimization)',
        errorCode: 'ERR_FILE_TOO_LARGE'
      });
    }

    const filename = generateSecureFilename(file.filename);
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const remotePath = `${FTP_PATH}/${year}/${month}`;
    const fullPath = `${remotePath}/${filename}`;

    await uploadToFTP(file.buffer, fullPath);

    const publicUrl = `${PUBLIC_URL}/${year}/${month}/${filename}`;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const sizeKB = Math.round(file.buffer.length / 1024);
    console.log(`[UPLOAD_SUCCESS] ${filename} (${sizeKB}KB) from ${ip}`);

    return res.status(200).json({
      success: true,
      url: publicUrl,
      filename: filename,
      size: file.buffer.length,
      markdown: `![](${publicUrl})`
    });

  } catch (error) {
    console.error('[UPLOAD_ERROR]', error.message, error.stack);
    
    // 클라이언트에는 일반적인 메시지만 전송
    return res.status(500).json({ 
      error: 'Upload failed. Please try again.',
      errorCode: 'ERR_UPLOAD_FAILED'
    });
  }
}

function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    let fileData = null;

    busboy.on('file', (fieldname, file, info) => {
      const chunks = [];
      
      file.on('data', (chunk) => {
        chunks.push(chunk);
      });
      
      file.on('end', () => {
        fileData = {
          buffer: Buffer.concat(chunks),
          filename: info.filename,
          mimetype: info.mimeType
        };
      });
      
      file.on('error', (error) => {
        reject(error);
      });
    });

    busboy.on('finish', () => {
      resolve(fileData);
    });

    busboy.on('error', (error) => {
      reject(error);
    });

    req.pipe(busboy);
  });
}

function generateSecureFilename(originalName) {
  const ext = originalName.split('.').pop().toLowerCase();
  // UUID v4 형식 사용 (충돌 가능성 극히 낮음)
  const uuid = crypto.randomUUID();
  const timestamp = Date.now();
  return `img-${timestamp}-${uuid}.${ext}`;
}

// 파일 시그니처 검증 (매직 넘버)
function isValidImageSignature(buffer, mimetype) {
  if (buffer.length < 12) return false;

  const signatures = {
    'image/jpeg': [[0xFF, 0xD8, 0xFF]],
    'image/png': [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
    'image/gif': [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]],
    'image/webp': [[0x52, 0x49, 0x46, 0x46]] // RIFF
  };

  const expectedSigs = signatures[mimetype];
  if (!expectedSigs) return false;

  return expectedSigs.some(sig => {
    return sig.every((byte, index) => buffer[index] === byte);
  });
}

async function uploadToFTP(buffer, remotePath) {
  const client = new ftp.Client();
  client.ftp.verbose = false;

  try {
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      port: parseInt(FTP_PORT),
      secure: false,
      timeout: 30000 // 30초 타임아웃
    });

    const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    await client.ensureDir(dir);
    await client.uploadFrom(Buffer.from(buffer), remotePath);
    
    console.log(`[FTP_UPLOAD] ${remotePath}`);

  } catch (error) {
    console.error('[FTP_ERROR]', error.message);
    throw new Error('FTP_UPLOAD_FAILED');
  } finally {
    client.close();
  }
}