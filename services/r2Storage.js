const { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const bucket = process.env.R2_BUCKET_NAME || 'tavora-files';
const publicBaseUrl = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '');
const endpoint = process.env.R2_ENDPOINT || 'https://4b3af1eaea15fcec76da0af184c6d307.r2.cloudflarestorage.com';

let client = null;

const isConfigured = () => Boolean(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY);

const getClient = () => {
  if (!isConfigured()) return null;
  if (!client) {
    client = new S3Client({
      region: 'auto',
      endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
};

const getPublicUrl = (key) => {
  if (!key) return '';
  if (/^https?:\/\//i.test(key)) return key;
  if (publicBaseUrl) return `${publicBaseUrl}/${key.replace(/^\//, '')}`;
  
  const baseUrl = process.env.API_URL || 'https://backend-web-tavora.fly.dev';
  return `${baseUrl}/api/files/${key.replace(/^\//, '')}`;
};

const uploadBuffer = async (buffer, key, contentType) => {
  const s3 = getClient();
  if (!s3) throw new Error('R2 storage is not configured.');
  const normalizedKey = key.replace(/^\//, '');
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: normalizedKey,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return getPublicUrl(normalizedKey);
};

const deleteObject = async (key) => {
  const s3 = getClient();
  if (!s3 || !key) return;
  const normalizedKey = key.replace(/^\//, '').replace(/^https?:\/\/[^/]+\//, '');
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: normalizedKey }));
};

const getObjectStream = async (key) => {
  const s3 = getClient();
  if (!s3) throw new Error('R2 storage is not configured.');
  const normalizedKey = key.replace(/^\//, '');
  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: normalizedKey }));
  return { body: response.Body, contentType: response.ContentType || 'application/octet-stream' };
};

const getSignedDownloadUrl = async (key, expiresIn = 3600) => {
  const s3 = getClient();
  if (!s3) throw new Error('R2 storage is not configured.');
  const normalizedKey = key.replace(/^\//, '');
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: normalizedKey }), { expiresIn });
};

module.exports = {
  isConfigured,
  getPublicUrl,
  uploadBuffer,
  deleteObject,
  getObjectStream,
  getSignedDownloadUrl,
};
