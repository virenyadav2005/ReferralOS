import { readConfig } from '../config.js';
import { closeDatabase, migrateDatabase, openDatabase } from '../database.js';

const config = readConfig();
const db = openDatabase(config.databasePath);
try {
  migrateDatabase(db);
  console.log(`Database is up to date: ${config.databasePath}`);
} finally {
  closeDatabase(db);
}
