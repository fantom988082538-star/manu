const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { readDB, writeDB } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { completeOrder, cancelOrder } = require('../services/actions');

const router = express.Router();
router.use(requireAuth);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 3 * 1024 * 1024 }, // 3 МБ — фото игры хранится в базе как base64, не разгоняем размер
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Разрешены только изображения (jpg, png, webp)'), ok);
  }
});

// --- Доступно: super_admin, checker_admin, manager ---

router.get('/orders', requireRole('super_admin', 'checker_admin', 'manager'), async (req, res) => {
  const db = await readDB();
  res.json(db.orders.slice().reverse());
});

router.post('/orders/:id/complete', requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const result = await completeOrder(db, req.params.id, req.user.id);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json(result.order);
});

router.post('/orders/:id/cancel', requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const { reason } = req.body;
  const db = await readDB();
  const result = await cancelOrder(db, req.params.id, req.user.id, reason);
  if (result.error) return res.status(409).json({ error: result.error });
  res.json(result.order);
});

// --- Доступно: только super_admin и checker_admin ---

router.get('/revenue', requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const completed = db.orders.filter(o => o.status === 'completed');
  const total = completed.reduce((s, o) => s + o.price, 0);
  res.json({ totalOrders: db.orders.length, completedOrders: completed.length, totalRevenue: total });
});

// --- Доступно: только super_admin ---

router.patch('/games/:key/packs/:packId', requireRole('super_admin'), async (req, res) => {
  const { price, label, denom } = req.body;
  const db = await readDB();
  const game = db.games.find(g => g.key === req.params.key);
  if (!game) return res.status(404).json({ error: 'Игра не найдена' });
  const pack = game.packs.find(p => p.id === req.params.packId);
  if (!pack) return res.status(404).json({ error: 'Пакет не найден' });
  if (price !== undefined) pack.price = Number(price);
  if (label !== undefined) pack.label = label;
  if (denom !== undefined) pack.denom = denom;
  await writeDB(db);
  res.json(pack);
});

router.post('/games/:key/packs', requireRole('super_admin'), async (req, res) => {
  const { label, price, denom } = req.body;
  if (!label || !price) return res.status(400).json({ error: 'Укажите название и цену пакета' });
  const db = await readDB();
  const game = db.games.find(g => g.key === req.params.key);
  if (!game) return res.status(404).json({ error: 'Игра не найдена' });
  const id = `${req.params.key}_${Date.now()}`;
  const pack = { id, label, price: Number(price), denom: denom || '' };
  game.packs.push(pack);
  await writeDB(db);
  res.json(pack);
});

router.delete('/games/:key/packs/:packId', requireRole('super_admin'), async (req, res) => {
  const db = await readDB();
  const game = db.games.find(g => g.key === req.params.key);
  if (!game) return res.status(404).json({ error: 'Игра не найдена' });
  const before = game.packs.length;
  game.packs = game.packs.filter(p => p.id !== req.params.packId);
  if (game.packs.length === before) return res.status(404).json({ error: 'Пакет не найден' });
  await writeDB(db);
  res.json({ ok: true });
});

// Загрузить/заменить фото игры — хранится прямо в базе как base64 (переживает "сон" сервера)
router.post('/games/:key/image', requireRole('super_admin'), upload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Прикрепите изображение' });
  const db = await readDB();
  const game = db.games.find(g => g.key === req.params.key);
  if (!game) return res.status(404).json({ error: 'Игра не найдена' });
  const dataUri = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
  game.image = dataUri;
  await writeDB(db);
  res.json({ ok: true, image: dataUri });
});

router.patch('/games/:key', requireRole('super_admin'), async (req, res) => {
  const { title, needsServer, supplierGameCode, idLabel, idPlaceholder, serverLabel, serverPlaceholder, pricingType, commissionPercent } = req.body;
  const db = await readDB();
  const game = db.games.find(g => g.key === req.params.key);
  if (!game) return res.status(404).json({ error: 'Игра не найдена' });
  if (title !== undefined) game.title = title;
  if (needsServer !== undefined) game.needsServer = !!needsServer;
  if (supplierGameCode !== undefined) game.supplierGameCode = supplierGameCode;
  if (idLabel !== undefined) game.idLabel = idLabel;
  if (idPlaceholder !== undefined) game.idPlaceholder = idPlaceholder;
  if (serverLabel !== undefined) game.serverLabel = serverLabel;
  if (serverPlaceholder !== undefined) game.serverPlaceholder = serverPlaceholder;
  if (pricingType !== undefined) game.pricingType = pricingType;
  if (commissionPercent !== undefined) game.commissionPercent = Number(commissionPercent);
  await writeDB(db);
  res.json(game);
});

router.post('/games', requireRole('super_admin'), async (req, res) => {
  const { key, title, needsServer, supplierGameCode, idLabel, idPlaceholder, serverLabel, serverPlaceholder, pricingType, commissionPercent, packs } = req.body;
  const db = await readDB();
  if (db.games.find(g => g.key === key)) {
    return res.status(409).json({ error: 'Игра с таким ключом уже есть' });
  }
  const game = {
    key, title, needsServer: !!needsServer, supplierGameCode,
    idLabel: idLabel || 'UID игрока',
    idPlaceholder: idPlaceholder || 'Например: 123456789',
    serverLabel: serverLabel || 'Сервер',
    serverPlaceholder: serverPlaceholder || '',
    pricingType: pricingType === 'percentage' ? 'percentage' : 'fixed',
    commissionPercent: Number(commissionPercent) || 0,
    packs: packs || []
  };
  db.games.push(game);
  await writeDB(db);
  res.json(game);
});

router.delete('/games/:key', requireRole('super_admin'), async (req, res) => {
  const db = await readDB();
  const before = db.games.length;
  db.games = db.games.filter(g => g.key !== req.params.key);
  if (db.games.length === before) return res.status(404).json({ error: 'Игра не найдена' });
  await writeDB(db);
  res.json({ ok: true });
});

router.get('/users', requireRole('super_admin'), async (req, res) => {
  const db = await readDB();
  res.json(db.users.map(u => ({
    id: u.id, name: u.name, phone: u.phone, role: u.role, balance: u.balance,
    totalSpent: u.totalSpent || 0, manualVipTier: u.manualVipTier || null,
    createdAt: u.createdAt
  })));
});

router.patch('/users/:id/role', requireRole('super_admin'), async (req, res) => {
  const { role } = req.body;
  const allowedRoles = ['super_admin', 'checker_admin', 'manager', 'user'];
  if (!allowedRoles.includes(role)) return res.status(400).json({ error: 'Недопустимая роль' });
  const db = await readDB();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  user.role = role;
  await writeDB(db);
  res.json({ id: user.id, name: user.name, role: user.role });
});

// Сбросить пароль пользователя (например, если он его забыл)
router.post('/users/:id/reset-password', requireRole('super_admin'), async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'Пароль должен быть не короче 4 символов' });
  }
  const db = await readDB();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  user.passwordHash = await bcrypt.hash(newPassword, 10);
  await writeDB(db);
  console.log(`[admin] Пароль пользователя ${user.id} сброшен администратором`);
  res.json({ ok: true });
});

router.patch('/users/:id/balance', requireRole('super_admin'), async (req, res) => {
  const { amount, reason } = req.body;
  const db = await readDB();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  user.balance = (user.balance || 0) + Number(amount || 0);
  if (user.balance < 0) user.balance = 0; // на всякий случай, баланс не должен уходить в минус
  await writeDB(db);
  console.log(`[admin] Баланс ${user.id} изменён на ${amount} (${reason || 'без причины'})`);
  res.json({ id: user.id, balance: user.balance });
});

// Назначить пользователю VIP-статус вручную (в обход автоматического расчёта по сумме покупок)
router.patch('/users/:id/vip', requireRole('super_admin'), async (req, res) => {
  const { discountPercent, label } = req.body;
  const db = await readDB();
  const user = db.users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (discountPercent === null || discountPercent === undefined) {
    user.manualVipTier = null; // убрать ручной VIP — вернётся автоматический расчёт по сумме покупок
  } else {
    user.manualVipTier = { discountPercent: Number(discountPercent), label: label || 'VIP' };
  }
  await writeDB(db);
  res.json({ id: user.id, manualVipTier: user.manualVipTier });
});

// --- Настройки магазина ---
router.get('/settings', requireRole('super_admin'), async (req, res) => {
  const db = await readDB();
  res.json(db.settings || { referralBonusAmount: 0 });
});

router.patch('/settings', requireRole('super_admin'), async (req, res) => {
  const { referralBonusAmount, topupBonusTiers, vipTiers, firstOrderDiscountEnabled, firstOrderDiscountPercent } = req.body;
  const db = await readDB();
  if (!db.settings) db.settings = {};
  if (referralBonusAmount !== undefined) db.settings.referralBonusAmount = Number(referralBonusAmount);
  if (topupBonusTiers !== undefined) {
    db.settings.topupBonusTiers = topupBonusTiers
      .map(t => ({ minAmount: Number(t.minAmount), bonus: Number(t.bonus) }))
      .filter(t => t.minAmount > 0 && t.bonus > 0);
  }
  if (vipTiers !== undefined) {
    db.settings.vipTiers = vipTiers
      .map(t => ({ minSpent: Number(t.minSpent), discountPercent: Number(t.discountPercent), label: t.label || 'VIP' }))
      .filter(t => t.minSpent > 0 && t.discountPercent > 0);
  }
  if (firstOrderDiscountEnabled !== undefined) db.settings.firstOrderDiscountEnabled = !!firstOrderDiscountEnabled;
  if (firstOrderDiscountPercent !== undefined) db.settings.firstOrderDiscountPercent = Number(firstOrderDiscountPercent);
  await writeDB(db);
  res.json(db.settings);
});

module.exports = router;
