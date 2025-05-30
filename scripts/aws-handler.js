import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

// AWS Configuration
let s3Client = null;

export function initializeAWS(config) {
  s3Client = new S3Client({
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

export async function uploadScreenshotToS3(screenshot, metadata) {
  if (!s3Client) {
    throw new Error('AWS S3 client not initialized');
  }

  const timestamp = new Date().toISOString();
  const key = `screenshots/${metadata.url.replace(/[^a-zA-Z0-9]/g, '_')}_${timestamp}.png`;
  
  // Convert base64 to buffer
  const imageBuffer = Buffer.from(screenshot, 'base64');
  
  const command = new PutObjectCommand({
    Bucket: process.env.AWS_BUCKET_NAME,
    Key: key,
    Body: imageBuffer,
    ContentType: 'image/png',
    Metadata: {
      timestamp: metadata.timestamp.toString(),
      url: metadata.url,
      title: metadata.title,
      trigger: metadata.trigger
    }
  });

  try {
    await s3Client.send(command);
    console.log('✅ Screenshot uploaded to S3:', key);
    return { success: true, key };
  } catch (error) {
    console.error('Failed to upload to S3:', error);
    throw error;
  }
} 