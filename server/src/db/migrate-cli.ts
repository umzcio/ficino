import { migrate } from './migrate.js';
import { createSql } from './sql.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}
const sql = createSql(url, { max: 2 });
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'up to date');
} finally {
  await sql.end();
}
