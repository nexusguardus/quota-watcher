CREATE TABLE IF NOT EXISTS subscriptions (
    user_id TEXT PRIMARY KEY,
    stripe_customer_id TEXT,
    plan_name TEXT DEFAULT 'free', -- 'free', 'pro', 'team'
    status TEXT DEFAULT 'inactive', -- 'active', 'past_due', 'canceled'
    current_period_end INTEGER,
    created_at INTEGER
);
