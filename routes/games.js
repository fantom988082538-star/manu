const express = require('express');
const rateLimit = require('express-rate-limit');
const { readDB } = require('../services/db');
const { checkFreeFireNickname } = require('../services/ffNicknameCheck');

const router = express.Router();

router.get('/', async (req, res) => {
  const db = await readDB();
  res.json(db.games);
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
  if (!game) return res.status(404).json({ error: 'Игра не найдена' });
  res.json(game);
});

module.exports = router;
