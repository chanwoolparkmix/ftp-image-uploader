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

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  // CORS 설정
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
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
    
    console.log('Auth Header:', authHeader ? 'Present' : 'Missing');
    
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
      
      console.log('Username:', username, 'Expected:', AUTH_USER);
      
      if (username !== AUTH_USER || password !== AUTH_PASS) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader", charset="UTF-8"');
        return res.status(401).json({ error: 'Invalid username or password' });
      }
      
      console.log('✅ Authentication successful');
      
    } catch (error) {
      console.error('Auth error:', error);
      res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader", charset="UTF-8"');
      return res.status(401).json({ error: 'Authentication failed' });
    }
  }

  try {
    const file = await parseMultipartForm(req);
    
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type. Allowed: JPEG, PNG, GIF, WebP' });
    }

    // 5MB 제한 (브라우저에서 최적화된 이미지)
    if (file.buffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 5MB after optimization)' });
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
    console.log(`✅ Upload: ${filename} (${sizeKB}KB) from ${ip}`);

    return res.status(200).json({
      success: true,
      url: publicUrl,
      filename: filename,
      size: file.buffer.length,
      markdown: `![](${publicUrl})`
    });

  } catch (error) {
    console.error('❌ Upload error:', error);
    return res.status(500).json({ 
      error: 'Upload failed', 
      details: error.message 
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
  const random = crypto.randomBytes(8).toString('hex');
  const timestamp = Date.now();
  return `img-${timestamp}-${random}.${ext}`;
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
      secure: false
    });

    const dir = remotePath.substring(0, remotePath.lastIndexOf('/'));
    await client.ensureDir(dir);
    await client.uploadFrom(Buffer.from(buffer), remotePath);
    
    console.log(`📤 FTP upload: ${remotePath}`);

  } catch (error) {
    console.error('FTP error:', error);
    throw new Error(`FTP upload failed: ${error.message}`);
  } finally {
    client.close();
  }
}