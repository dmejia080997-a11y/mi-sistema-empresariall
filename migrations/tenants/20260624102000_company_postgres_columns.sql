ALTER TABLE companies ADD COLUMN IF NOT EXISTS commercial_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS legal_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_address TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS country TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS base_currency TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS allowed_currencies TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_rate REAL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_name TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_payable_account_id BIGINT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS tax_credit_account_id BIGINT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS costing_method TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS multi_currency_enabled INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS accounting_method TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS accounting_framework TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS allowed_modules TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS theme_icon_frame INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_negative_stock_allowed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_auto_deduct_stock INTEGER NOT NULL DEFAULT 1;

UPDATE companies
SET base_currency = COALESCE(base_currency, currency, 'GTQ'),
    allowed_currencies = COALESCE(allowed_currencies, 'GTQ,USD'),
    multi_currency_enabled = COALESCE(multi_currency_enabled, 1),
    tax_rate = COALESCE(tax_rate, 12),
    tax_name = COALESCE(tax_name, 'IVA'),
    accounting_method = COALESCE(accounting_method, 'accrual'),
    accounting_framework = COALESCE(accounting_framework, 'NIF');
