const jwt = require('jsonwebtoken');
const { readDB } = require('../services/db');

const ROLES = ['super_admin', 'checker_admin', 'manager', 'user'];

async function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Нет токена авторизации' });
  }
  try {
    const token = header.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Токен криптографически валиден (подпись совпадает), НО сам
    // пользователь мог больше не существовать в базе — например, после
    // переноса с MongoDB на SQLite старые токены в браузерах остались
    // технически "рабочими", а самих пользователей в новой базе уже нет.
    // Без этой проверки роуты падали с "Cannot read properties of undefined"
    // при попытке find() несуществующего пользователя.
    const db = await readDB();
    const user = db.users.find(u => u.id === payload.id);
    if (!user) {
      return res.status(401).json({ error: 'Сессия устарела, войдите заново' });
    }

    req.user = payload;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Недействительный токен' });
  }
}

function requireRole(...allowed) {
  return (req, res, next) => {
    if (!req.user || !allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'Недостаточно прав для этого действия' });
    }
    next();
  };
}

function requireAdmin(req, res, next) {
  if (!req.user || !['super_admin', 'checker_admin', 'manager'].includes(req.user.role)) {
    return res.status(403).json({ error: 'Доступ только для администратора' });
  }
  next();
}

module.exports = { requireAuth, requireAdmin, requireRole, ROLES };
