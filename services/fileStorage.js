// Хранилище файлов (фото объявлений, чеки пополнений) — на диске VPS,
// НЕ base64 в базе. Раньше так делали специально из-за Render (там диск
// стирался при "засыпании" бесплатного сервера) — на своём VPS диск
// постоянный, значит можно и нужно хранить файлы по-нормальному.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

// Папки создаются автоматически при первом запуске — руками ничего создавать не нужно.
const SUBFOLDERS = ['listings', 'receipts'];
for (const folder of SUBFOLDERS) {
  const dir = path.join(UPLOADS_DIR, folder);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function extFromMime(mimetype) {
  if (mimetype === 'image/png') return 'png';
  if (mimetype === 'image/webp') return 'webp';
  return 'jpg';
}

// Сохраняет файл на диск, возвращает ОТНОСИТЕЛЬНЫЙ публичный путь
// (например "/uploads/listings/abc123-0.jpg"). Абсолютный URL (с доменом)
// собирает уже сам роут, который знает текущий хост запроса.
function saveFile(buffer, category, baseName, mimetype) {
  const ext = extFromMime(mimetype);
  const filename = `${baseName}.${ext}`;
  const filePath = path.join(UPLOADS_DIR, category, filename);
  fs.writeFileSync(filePath, buffer);
  return `/uploads/${category}/${filename}`;
}

// Читает файл с диска по его публичному пути (используется там, где файл
// НЕ отдаём напрямую через статику — например чеки, доступные только админу)
function readFile(publicPath) {
  const filePath = path.join(UPLOADS_DIR, '..', publicPath);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath);
}

function deleteFile(publicPath) {
  if (!publicPath || !publicPath.startsWith('/uploads/')) return;
  const filePath = path.join(UPLOADS_DIR, '..', publicPath);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function checksumOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = { saveFile, readFile, deleteFile, checksumOf, UPLOADS_DIR };
