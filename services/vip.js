// Единая логика определения VIP-скидки пользователя. Раньше была продублирована
// в routes/auth.js (/me) и routes/orders.js по отдельности — вынесено сюда,
// чтобы оба места всегда считали одинаково.
//
// Три независимых источника VIP, применяется МАКСИМУМ из них (не складываются):
//   1) auto      — по общей сумме покупок (settings.vipTiers), как было раньше
//   2) manual    — администратор поставил вручную (user.manualVipTier), как было раньше
//   3) purchased — куплен за деньги через плашку "VIP — скидка до 10%" (ТЗ п.16-18)
//
// Купленный уровень никогда не понижается сам по себе (user.purchasedVipPercent
// только растёт, см. services/actions.js approveTopup).
function computeVip(db, user) {
  const settings = db.settings || {};
  const totalSpent = user.totalSpent || 0;

  const vipTiers = (settings.vipTiers || []).slice().sort((a, b) => b.minSpent - a.minSpent);
  const autoTier = vipTiers.find(t => totalSpent >= t.minSpent) || null;

  const manualTier = user.manualVipTier || null;

  const purchasedPercent = user.purchasedVipPercent || 0;
  const purchasedTier = purchasedPercent > 0
    ? { discountPercent: purchasedPercent, label: `VIP ${purchasedPercent}%`, source: 'purchased' }
    : null;

  const candidates = [
    manualTier ? { ...manualTier, source: 'manual' } : null,
    purchasedTier,
    autoTier ? { ...autoTier, source: 'auto' } : null
  ].filter(Boolean);

  const currentTier = candidates.sort((a, b) => b.discountPercent - a.discountPercent)[0] || null;

  const nextAutoTier = !manualTier
    ? (vipTiers.slice().sort((a, b) => a.minSpent - b.minSpent).find(t => totalSpent < t.minSpent) || null)
    : null;

  return { currentTier, nextAutoTier, purchasedPercent };
}

module.exports = { computeVip };
