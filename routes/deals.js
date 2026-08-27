const express = require('express');
const { readDB } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const {
  buyListing, deliverCredentials, confirmDeal, disputeDeal,
  resolveDisputeToBuyer, resolveDisputeToSeller, sweepAutoCompleteDeals
} = require('../services/listingActions');

const router = express.Router();

// Скрываем данные для входа от всех, кроме покупателя (и админа) —
// продавцу они тоже не нужны второй раз показывать, он их сам вводил.
function safeDeal(deal, viewerId, isAdmin) {
  const canSeeCredentials = isAdmin || deal.buyerId === viewerId;
  return { ...deal, credentials: canSeeCredentials ? deal.credentials : (deal.credentials ? '••••••' : null) };
}

// --- Купить объявление ---
router.post('/:listingId/buy', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    await sweepAutoCompleteDeals(db);
    const result = await buyListing(db, req.params.listingId, req.user.id);
    if (result.error) return res.status(409).json({ error: result.error });
    res.json(result.deal);
  } catch (e) {
    console.error('[deals] POST /:listingId/buy', e);
    res.status(500).json({ error: 'Не удалось оформить покупку, попробуйте ещё раз' });
  }
});

// --- Мои сделки (и как покупатель, и как продавец) ---
router.get('/', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    await sweepAutoCompleteDeals(db);
    const mine = db.accountDeals
      .filter(d => d.buyerId === req.user.id || d.sellerId === req.user.id)
      .reverse()
      .map(d => safeDeal(d, req.user.id, false));
    res.json(mine);
  } catch (e) {
    console.error('[deals] GET /', e);
    res.status(500).json({ error: 'Не удалось загрузить сделки' });
  }
});

router.get('/:id', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    await sweepAutoCompleteDeals(db);
    const deal = db.accountDeals.find(d => d.id === req.params.id);
    if (!deal) return res.status(404).json({ error: 'Сделка не найдена' });
    const isAdmin = ['super_admin', 'checker_admin'].includes(req.user.role);
    if (!isAdmin && deal.buyerId !== req.user.id && deal.sellerId !== req.user.id) {
      return res.status(403).json({ error: 'Нет доступа к этой сделке' });
    }
    res.json(safeDeal(deal, req.user.id, isAdmin));
  } catch (e) {
    console.error('[deals] GET /:id', e);
    res.status(500).json({ error: 'Не удалось загрузить сделку' });
  }
});

// --- Продавец передаёт данные аккаунта ---
router.post('/:id/deliver', requireAuth, async (req, res) => {
  try {
    const { credentials } = req.body;
    const db = await readDB();
    const result = await deliverCredentials(db, req.params.id, req.user.id, credentials);
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[deals] POST /:id/deliver', e);
    res.status(500).json({ error: 'Не удалось отправить данные, попробуйте ещё раз' });
  }
});

// --- Покупатель подтверждает получение ---
router.post('/:id/confirm', requireAuth, async (req, res) => {
  try {
    const db = await readDB();
    const result = await confirmDeal(db, req.params.id, req.user.id, 'buyer');
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[deals] POST /:id/confirm', e);
    res.status(500).json({ error: 'Не удалось подтвердить, попробуйте ещё раз' });
  }
});

// --- Открыть спор (покупатель или продавец) ---
router.post('/:id/dispute', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;
    const db = await readDB();
    const result = await disputeDeal(db, req.params.id, req.user.id, reason);
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[deals] POST /:id/dispute', e);
    res.status(500).json({ error: 'Не удалось отправить жалобу, попробуйте ещё раз' });
  }
});

// --- Админ: список споров ---
router.get('/admin/list', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  try {
    const db = await readDB();
    await sweepAutoCompleteDeals(db);
    const status = req.query.status || 'disputed';
    const list = db.accountDeals
      .filter(d => status === 'all' ? true : d.status === status)
      .reverse()
      .map(d => {
        const buyer = db.users.find(u => u.id === d.buyerId);
        const seller = db.users.find(u => u.id === d.sellerId);
        return { ...d, buyerName: buyer?.name, sellerName: seller?.name, sellerPhone: seller?.phone, buyerPhone: buyer?.phone };
      });
    res.json(list);
  } catch (e) {
    console.error('[deals] GET /admin/list', e);
    res.status(500).json({ error: 'Не удалось загрузить список' });
  }
});

router.post('/admin/:id/resolve-buyer', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  try {
    const db = await readDB();
    const result = await resolveDisputeToBuyer(db, req.params.id, req.user.id);
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[deals] POST /admin/:id/resolve-buyer', e);
    res.status(500).json({ error: 'Не удалось решить спор, попробуйте ещё раз' });
  }
});

router.post('/admin/:id/resolve-seller', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  try {
    const db = await readDB();
    const result = await resolveDisputeToSeller(db, req.params.id, req.user.id);
    if (result.error) return res.status(409).json({ error: result.error });
    res.json({ ok: true });
  } catch (e) {
    console.error('[deals] POST /admin/:id/resolve-seller', e);
    res.status(500).json({ error: 'Не удалось решить спор, попробуйте ещё раз' });
  }
});

module.exports = router;
