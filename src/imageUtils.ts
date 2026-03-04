import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const AVATAR_MAX_SIZE = 256;
const PHOTO_MAX_WIDTH = 1200;
const JPEG_QUALITY = 80;

export async function processAvatar(filePath: string): Promise<void> {
  try {
    const buffer = await sharp(filePath)
      .resize(AVATAR_MAX_SIZE, AVATAR_MAX_SIZE, { fit: 'cover' })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    await fs.promises.writeFile(filePath, buffer);
  } catch (err) {
    console.error(`[Image] Failed to process avatar ${filePath}:`, err);
  }
}

export async function processSubmissionPhoto(filePath: string): Promise<void> {
  try {
    const buffer = await sharp(filePath)
      .resize(PHOTO_MAX_WIDTH, undefined, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: JPEG_QUALITY })
      .toBuffer();
    await fs.promises.writeFile(filePath, buffer);
  } catch (err) {
    console.error(`[Image] Failed to process photo ${filePath}:`, err);
  }
}

const MIGRATION_SKIP_THRESHOLD = 50 * 1024; // 50KB

export async function migrateExistingImages(uploadsDir: string): Promise<void> {
  if (!fs.existsSync(uploadsDir)) return;

  const files = await fs.promises.readdir(uploadsDir);
  const imageFiles = files.filter(f => /\.(jpg|jpeg|png|webp)$/i.test(f));

  if (imageFiles.length === 0) return;

  let processed = 0;
  for (const file of imageFiles) {
    const filePath = path.join(uploadsDir, file);
    const stat = await fs.promises.stat(filePath);

    if (stat.size < MIGRATION_SKIP_THRESHOLD) continue;

    if (file.startsWith('avatar-')) {
      await processAvatar(filePath);
    } else {
      await processSubmissionPhoto(filePath);
    }
    processed++;
  }

  if (processed > 0) {
    console.log(`[ImageMigration] Processed ${processed}/${imageFiles.length} images`);
  }
}
