-- Plaid bridge tables (cloud-only tokens; wipe on mini-PC cutover)

CREATE TABLE IF NOT EXISTS plaid_items (
  item_id TEXT PRIMARY KEY,
  access_token TEXT NOT NULL,
  institution_name TEXT,
  cursor TEXT,
  linked_at TEXT NOT NULL,
  last_sync_at TEXT,
  last_sync_status TEXT,
  last_sync_error TEXT
);

CREATE TABLE IF NOT EXISTS accounts (
  account_id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL,
  name TEXT,
  official_name TEXT,
  mask TEXT,
  subtype TEXT,
  type TEXT,
  FOREIGN KEY (item_id) REFERENCES plaid_items(item_id)
);

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  name TEXT,
  merchant_name TEXT,
  location_city TEXT,
  location_region TEXT,
  pending INTEGER NOT NULL DEFAULT 0,
  category TEXT,
  raw_json TEXT,
  FOREIGN KEY (account_id) REFERENCES accounts(account_id),
  FOREIGN KEY (item_id) REFERENCES plaid_items(item_id)
);

CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_item ON transactions(item_id);
