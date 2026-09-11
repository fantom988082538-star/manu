const express = require('express');
const rateLimit = require('express-rate-limit');
const { readDB } = require('../services/db');
const { checkFreeFireNickname } = require('../services/ffNicknameCheck');
const { toLegacyGameShape, isPubliclyVisible } = require('../services/persshopCatalogSync');
const persshop = require('../services/persshop');

const router = express.Router();

// Товары Pers Shop подмешиваются к статическому data/games.json в том же
// формате (key/title/packs/...), поэтому старому фронтенду не нужно ничего
// менять для обычных игр (1-2 поля на заказ, как у текущих Free Fire/PUBG/MLBB).
// Игры с 3+ полями (unsupportedFields) сюда не попадают — для них нужна
// доработка формы заказа на фронте, см. итоговый отчёт.
router.get('/', async (req, res) => {
  const db = await readDB();
  const supplierGames = (db.supplierGames || [])
    .filter(isPubliclyVisible)
    .map(toLegacyGameShape);
  res.json([...db.games, ...supplierGames]);
});

// Ограничиваем частоту — это прокси к стороннему бесплатному API,
// не хотим положить его (и получить бан по IP) при накрутке кликов.
const checkLimiter = rateLimit({ windowMs: 60 * 1000, max: 12 });

// GET /api/games/ff/check-nickname?uid=123456789
// Обязательно ДО '/:key' — иначе Express попытается искать игру с key="ff"
// и всё равно свернёт на этот путь из-за двух сегментов, но для ясности
// держим специфичный маршрут выше.
router.get('/ff/check-nickname', checkLimiter, async (req, res) => {
  const uid = String(req.query.uid || '').trim();
  if (!/^\d{5,15}$/.test(uid)) {
    return res.status(400).json({ error: 'Некорректный UID — введите только цифры (5–15 символов)' });
  }
  try {
    const result = await checkFreeFireNickname(uid);
    if (!result.nickname) {
      if (!result.serviceReachable) {
        return res.status(503).json({ error: 'Сервис проверки временно недоступен. Введите UID вручную.' });
      }
      return res.status(404).json({ error: 'Игрок не найден. Проверьте UID и введите его вручную.' });
    }
    res.json({ nickname: result.nickname });
  } catch (e) {
    if (e.code === 'NO_API_KEY') {
      console.error('[ff nickname check]', e.message);
      return res.status(503).json({ error: 'Проверка ника временно не настроена. Введите UID вручную.' });
    }
    console.error('[ff nickname check]', e.message);
    res.status(503).json({ error: 'Сервис проверки временно недоступен. Введите UID вручную.' });
  }
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
router.post('/:key/check-id', async (req, res) => {
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
