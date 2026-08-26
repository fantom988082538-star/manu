const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const { OAuth2Client } = require('google-auth-library');
const { readDB, writeDB } = require('../services/db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
const googleClient = process.env.GOOGLE_CLIENT_ID ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID) : null;

// Короткий читаемый реферальный код (6 символов, буквы+цифры)
function generateReferralCode() {
  return uuid().replace(/-/g, '').slice(0, 6).toUpperCase();
}

router.post('/register', async (req, res) => {
  const { name, phone, password, ref } = req.body;
  if (!name || !phone || !password) {
    return res.status(400).json({ error: 'Заполните имя, телефон и пароль' });
  }
  const db = await readDB();
  if (db.users.find(u => u.phone === phone)) {
    return res.status(409).json({ error: 'Пользователь с таким телефоном уже существует' });
  }
  const passwordHash = await bcrypt.hash(password, 10);

  let referredBy = null;
  if (ref) {
    const referrer = db.users.find(u => u.referralCode === String(ref).toUpperCase());
    if (referrer) referredBy = referrer.id;
  }

  let referralCode = generateReferralCode();
  while (db.users.find(u => u.referralCode === referralCode)) referralCode = generateReferralCode();

  const user = {
    id: uuid(), name, phone, passwordHash,
    role: 'user', balance: 0,
    referralCode, referredBy, referralBonusPaid: false, referralEarnings: 0,
    telegramChatId: null,
    createdAt: new Date().toISOString()
  };
  db.users.push(user);
  await writeDB(db);

  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, balance: user.balance } });
});

router.post('/login', async (req, res) => {
  const { phone, password } = req.body;
  const db = await readDB();
  const user = db.users.find(u => u.phone === phone);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Неверный телефон или пароль' });
  }
  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, name: user.name, phone: user.phone, role: user.role, balance: user.balance } });
});

// Вход/регистрация через Google — фронтенд присылает готовый ID-токен от Google,
// мы проверяем его подлинность через саму Google, и если это первый вход — создаём аккаунт
router.post('/google', async (req, res) => {
  if (!googleClient) {
    return res.status(500).json({ error: 'Вход через Google не настроен на сервере' });
  }
  const { credential, ref } = req.body;
  if (!credential) return res.status(400).json({ error: 'Нет токена Google' });

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: process.env.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (e) {
    return res.status(401).json({ error: 'Не удалось подтвердить аккаунт Google' });
  }

  const db = await readDB();
  let user = db.users.find(u => u.googleId === payload.sub);
  let isNewUser = false;

  if (!user) {
    // Если человек раньше уже регистрировался обычным способом с этой же почтой — привязываем Google к тому же аккаунту
    user = db.users.find(u => u.email && u.email === payload.email);
  }

  if (!user) {
    isNewUser = true;
    let referredBy = null;
    if (ref) {
      const referrer = db.users.find(u => u.referralCode === String(ref).toUpperCase());
      if (referrer) referredBy = referrer.id;
    }
    let referralCode = generateReferralCode();
    while (db.users.find(u => u.referralCode === referralCode)) referralCode = generateReferralCode();

    user = {
      id: uuid(), name: payload.name || 'Пользователь Google', phone: null,
      email: payload.email, googleId: payload.sub, passwordHash: null,
      role: 'user', balance: 0,
      referralCode, referredBy, referralBonusPaid: false, referralEarnings: 0,
      telegramChatId: null,
      createdAt: new Date().toISOString()
    };
    db.users.push(user);
  } else if (!user.googleId) {
    user.googleId = payload.sub; // привязываем Google к уже существующему аккаунту
  }
  await writeDB(db);

  const token = jwt.sign({ id: user.id, role: user.role, name: user.name }, process.env.JWT_SECRET, { expiresIn: '30d' });
  res.json({
    token,
    user: { id: user.id, name: user.name, phone: user.phone, role: user.role, balance: user.balance },
    isNewUser,
    needsProfile: isNewUser || !user.phone
  });
});

// Дозаполнить/изменить имя и телефон текущего аккаунта
router.patch('/profile', requireAuth, async (req, res) => {
  const { name, phone } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Укажите имя' });
  const db = await readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  if (phone && phone.trim()) {
    const taken = db.users.find(u => u.phone === phone.trim() && u.id !== user.id);
    if (taken) return res.status(409).json({ error: 'Этот телефон уже привязан к другому аккаунту' });
    user.phone = phone.trim();
  }
  user.name = name.trim();
  await writeDB(db);
  res.json({ id: user.id, name: user.name, phone: user.phone });
});

router.get('/me', requireAuth, async (req, res) => {
  const db = await readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  // На случай если пользователь зарегистрировался ДО появления реферальной системы
  if (!user.referralCode) {
    let code = generateReferralCode();
    while (db.users.find(u => u.referralCode === code)) code = generateReferralCode();
    user.referralCode = code;
    await writeDB(db);
  }

  const vipTiers = (db.settings?.vipTiers || []).slice().sort((a, b) => b.minSpent - a.minSpent);
  const totalSpent = user.totalSpent || 0;
  const autoTier = vipTiers.find(t => totalSpent >= t.minSpent) || null;
  const currentTier = user.manualVipTier || autoTier;
  const nextTier = user.manualVipTier ? null : (vipTiers.slice().sort((a, b) => a.minSpent - b.minSpent).find(t => totalSpent < t.minSpent) || null);

  res.json({
    id: user.id, name: user.name, phone: user.phone, role: user.role, balance: user.balance,
    referralCode: user.referralCode,
    telegramLinked: !!user.telegramChatId,
    totalSpent,
    vipTier: currentTier,
    nextVipTier: nextTier
  });
});

module.exports = router;
