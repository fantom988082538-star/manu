// Периодическая сверка заказов "в процессе" с Pers Shop — подстраховка на
// случай, если вебхук не дошёл (наш сервер был недоступен в момент отправки,
// у поставщика кончились попытки доставки и т.п.). Вебхук делает этот опрос
// редким, а не ненужным — см. ТЗ п.13 ("оставь polling/reconciliation").
//
// Переживает перезапуск backend: состояние ("какие заказы ещё не завершены")
// хранится в базе (order.status === 'fulfilling'), а не в памяти процесса.

const { readDB } = require('./db');
const persshop = require('./persshop');
const { applySupplierCompletion, applySupplierFailure, markSupplierFulfilling } = require('./actions');

const INTERVAL_MS = 3 * 60 * 1000; // 3 минуты

async function reconcileOnce() {
  const db = await readDB();
  const pending = db.orders.filter(o => o.provider === 'persshop' && o.status === 'fulfilling' && o.supplierOrderId);
  if (pending.length === 0) return;

  for (const order of pending) {
    try {
      const data = await persshop.getOrder(order.supplierOrderId);
      const supplierOrder = data.order || data;
      const fresh = await readDB(); // перечитываем — статус мог обновиться вебхуком параллельно
      if (supplierOrder.status === 'fulfilled') {
        await applySupplierCompletion(fresh, order.id);
      } else if (supplierOrder.status === 'refunded' || supplierOrder.status === 'failed') {
        await applySupplierFailure(fresh, order.id, supplierOrder.status);
      } else {
        await markSupplierFulfilling(fresh, order.id, supplierOrder.status);
      }
    } catch (e) {
      console.error('[persshop reconcile]', order.id, e.response?.data?.error || e.message);
    }
  }
}

function start() {
  setInterval(() => {
    reconcileOnce().catch(e => console.error('[persshop reconcile] сбой цикла:', e.message));
  }, INTERVAL_MS);
  console.log(`[persshop reconcile] сверка статусов запущена, каждые ${INTERVAL_MS / 60000} мин`);
}

module.exports = { start, reconcileOnce };
