import ftp from 'basic-ftp';
import Busboy from 'busboy';
import sharp from 'sharp';
import crypto from 'crypto';

// 환경 변수
const FTP_HOST = process.env.FTP_HOST;
const FTP_USER = process.env.FTP_USER;
const FTP_PASS = process.env.FTP_PASS;
const FTP_PORT = process.env.FTP_PORT || '21';
const FTP_PATH = process.env.FTP_PATH || '/';
const PUBLIC_URL = process.env.PUBLIC_URL;
const API_KEY = process.env.API_KEY;

// 기본 최적화 설정
const DEFAULT_MAX_DIMENSION = process.env.MAX_DIMENSION || '1200';
const DEFAULT_QUALITY = process.env.IMAGE_QUALITY || '85';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (API_KEY && req.headers['x-api-key'] !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const { file, optimize } = await parseMultipartForm(req);
    
    if (!file) {
      return res.status(400).json({ error: 'No file provided' });
    }

    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!allowedTypes.includes(file.mimetype)) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    if (file.buffer.length > 10 * 1024 * 1024) {
      return res.status(400).json({ error: 'File too large (max 10MB)' });
    }

    let processedBuffer = file.buffer;
    if (optimize !== 'false') {
      try {
        const maxDim = parseInt(DEFAULT_MAX_DIMENSION);
        const qual = parseInt(DEFAULT_QUALITY);
        processedBuffer = await optimizeImage(file.buffer, file.mimetype, maxDim, qual);
      } catch (error) {
        console.error('Optimization failed:', error);
      }
    }

    const filename = generateSecureFilename(file.filename);
    const date = new Date();
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const remotePath = `${FTP_PATH}/${year}/${month}`;
    const fullPath = `${remotePath}/${filename}`;

    await uploadToFTP(processedBuffer, fullPath);

    const publicUrl = `${PUBLIC_URL}/${year}/${month}/${filename}`;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`✅ Upload: ${filename} from ${ip}`);

    return res.status(200).json({
      success: true,
      url: publicUrl,
      filename: filename,
      size: processedBuffer.length,
      optimized: optimize !== 'false',
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
    let optimize = 'true';

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

    busboy.on('field', (fieldname, val) => {
      if (fieldname === 'optimize') optimize = val;
    });

    busboy.on('finish', () => {
      resolve({ file: fileData, optimize });
    });

    busboy.on('error', reject);
    req.pipe(busboy);
  });
}

async function optimizeImage(buffer, mimetype, maxDimension, quality) {
  const image = sharp(buffer);
  const metadata = await image.metadata();
  let optimized = image;

  if (metadata.width > maxDimension || metadata.height > maxDimension) {
    optimized = optimized.resize(maxDimension, maxDimension, {
      fit: 'inside',
      withoutEnlargement: true
    });
  }

  switch (mimetype) {
    case 'image/jpeg':
      optimized = optimized.jpeg({ quality: quality, mozjpeg: true });
      break;
    case 'image/png':
      const pngCompression = Math.round(9 - (quality / 100) * 9);
      optimized = optimized.png({ compressionLevel: pngCompression });
      break;
    case 'image/webp':
      optimized = optimized.webp({ quality: quality });
      break;
    case 'image/gif':
      return buffer;
  }

  return optimized.toBuffer();
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