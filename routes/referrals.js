const express = require('express');
const { readDB } = require('../services/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Статистика по своим рефералам: код, сколько людей пришло, сколько заработано
router.get('/stats', requireAuth, async (req, res) => {
  const db = await readDB();
  const me = db.users.find(u => u.id === req.user.id);
  if (!me) return res.status(404).json({ error: 'Пользователь не найден' });

  const referred = db.users.filter(u => u.referredBy === me.id);
  res.json({
    code: me.referralCode || null,
    referredCount: referred.length,
    totalEarned: me.referralEarnings || 0,
    bonusAmount: db.settings?.referralBonusAmount ?? 0
  });
});

module.exports = router;
