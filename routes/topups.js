const express = require('express');
const multer = require('multer');
const { v4: uuid } = require('uuid');
const { readDB, writeDB } = require('../services/db');
const { saveFile, readFile, checksumOf } = require('../services/fileStorage');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyAdminWithButtons } = require('../services/telegram');
const { approveTopup, rejectTopup } = require('../services/actions');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 МБ — чек хранится файлом на диске, не в базе
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Разрешены только изображения (jpg, png, webp)'), ok);
  }
});

router.post('/', requireAuth, upload.single('receipt'), async (req, res) => {
  const { amount } = req.body;
  if (!req.file) return res.status(400).json({ error: 'Прикрепите скриншот или фото чека' });
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'Укажите сумму пополнения' });

  const checksum = checksumOf(req.file.buffer);
  const db = await readDB();
  const duplicate = db.topups.find(t => t.checksum === checksum);
  if (duplicate) {
    return res.status(409).json({ error: 'Этот чек уже был использован ранее' });
  }

  const topupId = uuid();
  // Чек — файлом на диск (uploads/receipts/), не base64 в базе. Доступен
  // только через авторизованный админ-эндпоинт ниже, не отдаётся статикой
  // напрямую — это платёжные данные, не публичные фото объявлений.
  const receiptPath = saveFile(req.file.buffer, 'receipts', topupId, req.file.mimetype);

  const topup = {
    id: topupId,
    userId: req.user.id,
    amount: amountNum,
    receiptImage: receiptPath, // относительный путь к файлу, не base64
    checksum,
    status: 'pending',
    reviewedBy: null,
    reviewedAt: null,
    rejectReason: null,
    createdAt: new Date().toISOString()
  };
  db.topups.push(topup);
  await writeDB(db);

  const user = db.users.find(u => u.id === req.user.id);
  notifyAdminWithButtons(
    `💰 <b>Новая заявка на пополнение</b>\n` +
    `Пользователь: ${user?.name || '—'} (${user?.phone || '—'})\n` +
    `Сумма: <b>${amountNum} сомони</b>`,
    [[
      { text: '✅ Подтвердить', callback_data: `topup_approve:${topup.id}` },
      { text: '❌ Отклонить', callback_data: `topup_reject:${topup.id}` }
    ]]
  );

  res.json({ ...topup, receiptImage: undefined, checksum: undefined });
});

router.get('/', requireAuth, async (req, res) => {
  const db = await readDB();
  const mine = db.topups
    .filter(t => t.userId === req.user.id)
    .reverse()
    .map(({ checksum, receiptImage, ...safe }) => safe);
  res.json(mine);
});

router.get('/admin/list', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const status = req.query.status || 'pending';
  const list = db.topups
    .filter(t => status === 'all' || t.status === status)
    .reverse()
    .map(t => {
      const user = db.users.find(u => u.id === t.userId);
      return { ...t, checksum: undefined, receiptImage: undefined, userName: user?.name, userPhone: user?.phone };
    });
  res.json(list);
});

// Само изображение чека — отдельным запросом, чтобы список заявок не тянул все картинки разом.
// Читаем файл с диска и отдаём как data-URI — формат ответа не поменялся,
// админ-панели на фронте ничего менять не нужно.
router.get('/admin/:id/receipt', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const topup = db.topups.find(t => t.id === req.params.id);
  if (!topup) return res.status(404).json({ error: 'Заявка не найдена' });
  if (!topup.receiptImage) return res.status(404).json({ error: 'Чек не найден' });

  const buffer = readFile(topup.receiptImage);
  if (!buffer) return res.status(404).json({ error: 'Файл чека не найден на диске' });
  const ext = topup.receiptImage.split('.').pop();
  const mimetype = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
  res.json({ image: `data:${mimetype};base64,${buffer.toString('base64')}` });
});

router.post('/admin/:id/approve', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const result = await approveTopup(db, req.params.id, req.user.id);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true, newBalance: result.user.balance, bonusApplied: result.amountBonus });
});

router.post('/admin/:id/reject', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const { reason } = req.body;
  const db = await readDB();
  const result = await rejectTopup(db, req.params.id, req.user.id, reason);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json({ ok: true });
});

module.exports = router;
