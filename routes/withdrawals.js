const express = require('express');
const { v4: uuid } = require('uuid');
const { readDB, writeDB } = require('../services/db');
const { requireAuth, requireRole } = require('../middleware/auth');
const { notifyAdmin, sendToChat } = require('../services/telegram');

const router = express.Router();

// Пользователь создаёт заявку на вывод. Деньги списываются с баланса СРАЗУ
// (чтобы нельзя было потратить их дважды, пока заявка ждёт обработки).
// Если админ отклонит — баланс возвращается.
router.post('/', requireAuth, async (req, res) => {
  const { amount, method, requisite } = req.body;
  const amountNum = Number(amount);
  if (!amountNum || amountNum <= 0) return res.status(400).json({ error: 'Укажите сумму вывода' });
  if (!method || !['alif', 'dc'].includes(method)) return res.status(400).json({ error: 'Выберите способ вывода' });
  if (!requisite || !requisite.trim()) return res.status(400).json({ error: 'Укажите номер, куда перевести деньги' });

  const db = await readDB();
  const user = db.users.find(u => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
  if (user.balance < amountNum) return res.status(402).json({ error: 'Недостаточно средств на балансе' });

  user.balance -= amountNum;

  const withdrawal = {
    id: uuid(),
    userId: req.user.id,
    amount: amountNum,
    method, // 'alif' | 'dc'
    requisite: requisite.trim(),
    status: 'pending', // pending -> approved / rejected
    reviewedBy: null,
    reviewedAt: null,
    rejectReason: null,
    createdAt: new Date().toISOString()
  };
  db.withdrawals.push(withdrawal);
  await writeDB(db);

  notifyAdmin(
    `💸 <b>Заявка на вывод средств</b>\n` +
    `Пользователь: ${user.name} (${user.phone})\n` +
    `Сумма: <b>${amountNum} сомони</b>\n` +
    `Способ: ${method === 'alif' ? 'Alif Mobi' : 'Душанбе Сити'}\n` +
    `Куда перевести: <b>${withdrawal.requisite}</b>\n` +
    `Проверь в админ-панели: вкладка «Выводы»`
  );

  res.json(withdrawal);
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
