import { loadConfig } from '../config.js';
import { connectDb, ensureSchema } from './client.js';

/**
 * AI: Применить миграции без запуска API: `npm run db:migrate -w @helpdesk/api`. Удобно перед
 * деплоем новой версии или для проверки на копии базы. Сам API делает то же самое при старте.
 */
const config = loadConfig();
const handle = await connectDb({ url: config.DATABASE_URL, pgliteDir: config.PGLITE_DIR });
try {
  const { applied } = await ensureSchema(handle.db, { info: (m) => console.log(m) });
  console.log(
    applied.length ? `applied ${applied.length}: ${applied.join(', ')}` : 'schema is up to date',
  );
} finally {
  await handle.close();
}
