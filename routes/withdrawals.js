const express = require('express');
const { v4: uuid } = require('uuid');
const { readDB, writeDB } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyAdmin, sendToChat } = require('../services/telegram');

const router = express.Router();

const MIN_WITHDRAWAL_AMOUNT = 20;

// Вывод средств временно отключён — пользователи не могут создать новую
// заявку. История и обработка уже существующих старых заявок (approve/reject
// ниже) не тронуты, чтобы то, что уже было в очереди, можно было закрыть.
router.post('/', requireAuth, async (req, res) => {
  return res.status(403).json({ error: 'Вывод средств временно недоступен' });
});

// История выводов текущего пользователя
router.get('/', requireAuth, async (req, res) => {
  const db = await readDB();
  const mine = db.withdrawals.filter(w => w.userId === req.user.id).reverse();
  res.json(mine);
});

// --- Админские роуты ---

router.get('/admin/list', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const status = req.query.status || 'pending';
  const list = db.withdrawals
    .filter(w => status === 'all' || w.status === status)
    .reverse()
    .map(w => {
      const user = db.users.find(u => u.id === w.userId);
      return { ...w, userName: user?.name, userPhone: user?.phone };
    });
  res.json(list);
});

// Подтвердить — значит "деньги реально переведены человеку вручную"
router.post('/admin/:id/approve', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const db = await readDB();
  const withdrawal = db.withdrawals.find(w => w.id === req.params.id);
  if (!withdrawal) return res.status(404).json({ error: 'Заявка не найдена' });
  if (withdrawal.status !== 'pending') return res.status(409).json({ error: 'Заявка уже обработана' });

  withdrawal.status = 'approved';
  withdrawal.reviewedBy = req.user.id;
  withdrawal.reviewedAt = new Date().toISOString();
  await writeDB(db);
  const user = db.users.find(u => u.id === withdrawal.userId);
  if (user?.telegramChatId) {
    sendToChat(user.telegramChatId, `💸 Деньги отправлены! ${withdrawal.amount} сомони переведены на ${withdrawal.requisite}.`);
  }
  res.json({ ok: true });
});

// Отклонить — деньги возвращаются на баланс пользователя
router.post('/admin/:id/reject', requireAuth, requireRole('super_admin', 'checker_admin'), async (req, res) => {
  const { reason } = req.body;
  const db = await readDB();
  const withdrawal = db.withdrawals.find(w => w.id === req.params.id);
  if (!withdrawal) return res.status(404).json({ error: 'Заявка не найдена' });
  if (withdrawal.status !== 'pending') return res.status(409).json({ error: 'Заявка уже обработана' });

  const user = db.users.find(u => u.id === withdrawal.userId);
  if (user) user.balance = (user.balance || 0) + withdrawal.amount;

  withdrawal.status = 'rejected';
  withdrawal.reviewedBy = req.user.id;
  withdrawal.reviewedAt = new Date().toISOString();
  withdrawal.rejectReason = reason || null;
  await writeDB(db);
  if (user?.telegramChatId) {
    sendToChat(user.telegramChatId, `⚠️ Заявка на вывод ${withdrawal.amount} сомони отклонена.${reason ? '\nПричина: ' + reason : ''}\nДеньги возвращены на баланс.`);
  }
  res.json({ ok: true });
});

module.exports = router;
