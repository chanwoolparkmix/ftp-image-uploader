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
  res.setHeader('Access-Control-Allow-Origin', '*');
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
    const [username, password] = decoded.split(':');
    
    if (username !== AUTH_USER || password !== AUTH_PASS) {
      res.setHeader('WWW-Authenticate', 'Basic realm="Image Uploader"');
      return res.status(401).json({ error: 'Invalid credentials' });
    }
  }

  try {
    const file = await parseMultipartForm(req);
    
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

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
    console.log(`✅ Upload: ${filename} (${Math.round(file.buffer.length / 1024)}KB) from ${ip}`);

    return res.status(200).json({
      success: true,
      url: publicUrl,
      filename: filename,
      size: file.buffer.length,
      markdown: `![](${publicUrl})`
    });

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({ error: 'Upload failed', details: error.message });
  }
}

function parseMultipartForm(req) {
  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: req.headers });
    let fileData = null;

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
    });

    busboy.on('finish', () => {
      resolve(fileData);
    });

    busboy.on('error', reject);
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
    console.log(`📤 FTP: ${remotePath}`);

  } finally {
    client.close();
  }
}