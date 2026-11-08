import { testDatabaseUrl } from './testDb';

// Route handlers read DATABASE_URL lazily through getDb(); point them at the test database.
process.env.DATABASE_URL = testDatabaseUrl();
process.env.LIVE_ORDER_TRANSPORT = 'disabled';
