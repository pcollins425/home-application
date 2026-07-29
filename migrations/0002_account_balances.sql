-- Store Plaid balances on accounts (loan = outstanding current, etc.)

ALTER TABLE accounts ADD COLUMN balance_available REAL;
ALTER TABLE accounts ADD COLUMN balance_current REAL;
ALTER TABLE accounts ADD COLUMN balance_limit REAL;
ALTER TABLE accounts ADD COLUMN balance_iso_currency TEXT;
ALTER TABLE accounts ADD COLUMN balance_updated_at TEXT;
