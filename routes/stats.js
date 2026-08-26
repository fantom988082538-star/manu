const express = require('express');
const { readDB } = require('../services/db');

const router = express.Router();

// Маскируем имя для приватности: "Азиз Каримов" -> "Азиз К."
function maskName(name) {
  if (!name) return 'Покупатель';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  return parts[0] + ' ' + parts[1][0].toUpperCase() + '.';
}

// Публичная статистика — лента последних покупок (обезличенно) + счётчик для бейджа доверия.
// Никаких приватных данных тут нет (ни UID, ни телефона, ни точного времени входа).
router.get('/public', async (req, res) => {
  const db = await readDB();
  const completed = db.orders.filter(o => o.status === 'completed');

  const feed = completed
    .slice()
    .sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt))
    .slice(0, 20)
    .map(o => {
      const user = db.users.find(u => u.id === o.userId);
      return {
        name: maskName(user?.name),
        gameTitle: o.gameTitle,
        packLabel: o.packLabel,
        time: o.completedAt || o.createdAt
      };
    });

  res.json({
    completedOrdersCount: completed.length,
    feed
  });
});

module.exports = router;
