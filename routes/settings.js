const express = require('express');
const { readDB } = require('../services/db');

const router = express.Router();

// Публичные настройки — нужны фронтенду, чтобы показывать VIP-уровни,
// бонусы за пополнение и т.д. БЕЗ входа в аккаунт. Никаких секретов тут нет.
router.get('/public', async (req, res) => {
  const db = await readDB();
  const s = db.settings || {};
  res.json({
    vipTiers: s.vipTiers || [],
    firstOrderDiscountEnabled: !!s.firstOrderDiscountEnabled,
    firstOrderDiscountPercent: s.firstOrderDiscountPercent || 0,
    topupBonusTiers: s.topupBonusTiers || [],
    referralBonusAmount: s.referralBonusAmount || 0,
    guarantorCommission: s.guarantorCommission || 0
  });
});

module.exports = router;
