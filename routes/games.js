const express = require('express');
const { readDB } = require('../services/db');
const { spamGuard } = require('../middleware/spamGuard');
const { toLegacyGameShape, isPubliclyVisible } = require('../services/persshopCatalogSync');
const persshop = require('../services/persshop');

const router = express.Router();
const checkIdGuard = spamGuard('Слишком много проверок ID подряд. Попробуйте снова через 30 минут.');

// Товары Pers Shop подмешиваются к обычным играм (раньше — из статического
// data/games.json, теперь — из БД, но формат ответа тот же: key/title/packs/...),
// поэтому старому фронтенду не нужно ничего менять для обычных игр (1-2 поля
// на заказ, как у текущих Free Fire/PUBG/MLBB).
// Игры с 3+ полями (unsupportedFields) сюда не попадают — для них нужна
// доработка формы заказа на фронте, см. итоговый отчёт.
router.get('/', async (req, res) => {
  const db = await readDB();
  const supplierGames = (db.supplierGames || [])
    .filter(isPubliclyVisible)
    .map(toLegacyGameShape);
  res.json([...db.games, ...supplierGames]);
});

router.get('/:key', async (req, res) => {
  const db = await readDB();
  const game = db.games.find(g => g.key === req.params.key);
  if (game) return res.json(game);
  const supplierGame = (db.supplierGames || []).find(g => g.id === req.params.key && isPubliclyVisible(g));
  if (supplierGame) return res.json(toLegacyGameShape(supplierGame));
  return res.status(404).json({ error: 'Игра не найдена' });
});

// Проверка ID перед заказом для товаров Pers Shop, у которых это доступно
// (ТЗ п.8). Если проверка у поставщика временно недоступна — НЕ считаем
// автоматически, что ID неверный (ТЗ п.8, продолжение): возвращаем valid:null,
// а не ошибку, чтобы фронт не блокировал оформление заказа.
router.post('/:key/check-id', checkIdGuard, async (req, res) => {
  const db = await readDB();
  const supplierGame = (db.supplierGames || []).find(g => g.id === req.params.key);
  if (!supplierGame || !supplierGame.idCheckField) {
    return res.status(400).json({ error: 'Для этого товара проверка ID недоступна' });
  }
  const fieldKeys = (supplierGame.supplierFields || []).map(f => f.key);
  const fields = {};
  if (fieldKeys[0] && req.body.uid) fields[fieldKeys[0]] = req.body.uid;
  if (fieldKeys[1] && req.body.server) fields[fieldKeys[1]] = req.body.server;

  try {
    const result = await persshop.checkId({ categoryId: supplierGame.categoryId, fields });
    return res.json({ valid: result.valid, playerName: result.playerName || null, region: result.region || null });
  } catch (e) {
    const code = e.response?.data?.code;
    if (code === 'check_unavailable') {
      return res.status(400).json({ error: 'Для этого товара проверка ID недоступна' });
    }
    // check_unavailable_now и любая другая техническая ошибка — не блокируем заказ
    console.error('[persshop check-id]', code || e.message);
    return res.json({ valid: null, message: 'Проверка временно недоступна, введите ID вручную' });
  }
});

module.exports = router;
