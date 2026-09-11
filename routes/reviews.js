const express = require('express');
const { v4: uuid } = require('uuid');
const { readDB, writeDB } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// Оставить отзыв (нужен вход в аккаунт)
router.post('/', requireAuth, async (req, res) => {
  const { rating, text } = req.body;
  const ratingNum = Number(rating);
  if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
    return res.status(400).json({ error: 'Оценка должна быть от 1 до 5 звёзд' });
  }
  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Напишите текст отзыва' });
  }
  const db = await readDB();
  const user = db.users.find(u => u.id === req.user.id);

  const review = {
    id: uuid(),
    userId: req.user.id,
    userName: user?.name || 'Пользователь',
    rating: ratingNum,
    text: text.trim().slice(0, 1000),
    createdAt: new Date().toISOString()
  };
  db.reviews.push(review);
  await writeDB(db);
  res.json(review);
});

// Список всех отзывов — публичный, показывается на сайте
router.get('/', async (req, res) => {
  const db = await readDB();
  const list = db.reviews.slice().reverse();
  res.json(list);
});

// Удалить отзыв (модерация — например спам или оскорбления)
router.delete('/:id', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const before = db.reviews.length;
  db.reviews = db.reviews.filter(r => r.id !== req.params.id);
  if (db.reviews.length === before) return res.status(404).json({ error: 'Отзыв не найден' });
  await writeDB(db);
  res.json({ ok: true });
});

module.exports = router;
