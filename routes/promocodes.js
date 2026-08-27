const express = require('express');
const { v4: uuid } = require('uuid');
const { readDB, writeDB } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// --- Покупатель: активировать промокод (даёт бонус на баланс) ---
router.post('/redeem', requireAuth, async (req, res) => {
  const { code } = req.body;
  if (!code || !code.trim()) return res.status(400).json({ error: 'Введите промокод' });

  const db = await readDB();
  const promo = db.promocodes.find(p => p.code === code.trim().toUpperCase());
  if (!promo) return res.status(404).json({ error: 'Такой промокод не найден' });
  if (!promo.active) return res.status(409).json({ error: 'Этот промокод больше не активен' });
  if (promo.expiresAt && new Date(promo.expiresAt) < new Date()) {
    return res.status(409).json({ error: 'Срок действия промокода истёк' });
  }
  if (promo.maxUses && promo.usedBy.length >= promo.maxUses) {
    return res.status(409).json({ error: 'Промокод больше не действует — лимит использований исчерпан' });
  }
  if (promo.usedBy.includes(req.user.id)) {
    return res.status(409).json({ error: 'Вы уже использовали этот промокод' });
  }

  const user = db.users.find(u => u.id === req.user.id);
  user.balance = (user.balance || 0) + promo.value;
  promo.usedBy.push(req.user.id);
  await writeDB(db);

  res.json({ ok: true, bonus: promo.value, newBalance: user.balance });
});

// --- Админ: управление промокодами (только super_admin) ---

router.get('/admin/list', requireAuth, requireRole('super_admin'), async (req, res) => {
  const db = await readDB();
  res.json(db.promocodes.slice().reverse().map(p => ({ ...p, usedCount: p.usedBy.length })));
});

router.post('/admin', requireAuth, requireRole('super_admin'), async (req, res) => {
  const { code, value, maxUses, expiresAt } = req.body;
  if (!code || !code.trim()) return res.status(400).json({ error: 'Укажите код' });
  const valueNum = Number(value);
  if (!valueNum || valueNum <= 0) return res.status(400).json({ error: 'Укажите сумму бонуса' });

  const db = await readDB();
  const normalizedCode = code.trim().toUpperCase();
  if (db.promocodes.find(p => p.code === normalizedCode)) {
    return res.status(409).json({ error: 'Промокод с таким названием уже есть' });
  }
  const promo = {
    id: uuid(),
    code: normalizedCode,
    value: valueNum,
    maxUses: maxUses ? Number(maxUses) : null,
    expiresAt: expiresAt || null,
    active: true,
    usedBy: [],
    createdAt: new Date().toISOString()
  };
  db.promocodes.push(promo);
  await writeDB(db);
  res.json(promo);
});

router.patch('/admin/:id', requireAuth, requireRole('super_admin'), async (req, res) => {
  const { active } = req.body;
  const db = await readDB();
  const promo = db.promocodes.find(p => p.id === req.params.id);
  if (!promo) return res.status(404).json({ error: 'Промокод не найден' });
  if (active !== undefined) promo.active = !!active;
  await writeDB(db);
  res.json(promo);
});

router.delete('/admin/:id', requireAuth, requireRole('super_admin'), async (req, res) => {
  const db = await readDB();
  const before = db.promocodes.length;
  db.promocodes = db.promocodes.filter(p => p.id !== req.params.id);
  if (db.promocodes.length === before) return res.status(404).json({ error: 'Промокод не найден' });
  await writeDB(db);
  res.json({ ok: true });
});

module.exports = router;
