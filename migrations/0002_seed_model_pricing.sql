-- Seed baseline pricing (USD per 1M tokens)
-- Last manual review: 2026-05-24
INSERT OR REPLACE INTO model_pricing (model_id, provider, input_cost_per_1m, output_cost_per_1m) VALUES
  -- OpenAI
  ('gpt-4o',                 'openai', 2.50,   10.00),
  ('gpt-4o-mini',            'openai', 0.15,    0.60),
  ('gpt-4-turbo',            'openai', 10.00,   30.00),
  ('gpt-4',                  'openai', 30.00,   60.00),
  ('o1-preview',             'openai', 15.00,   60.00),
  ('o1-mini',                'openai', 3.00,    12.00),
  ('o3-mini',                'openai', 1.10,     4.40),
  ('o3',                     'openai', 10.00,   40.00),
  ('text-embedding-3-small', 'openai', 0.02,     0.00),
  ('text-embedding-3-large', 'openai', 0.13,     0.00),
  -- Anthropic
  ('claude-sonnet-4-20250514',    'anthropic',  3.00,  15.00),
  ('claude-opus-4-20230301',      'anthropic', 15.00,  75.00),
  ('claude-haiku-3-20240307',     'anthropic',  0.25,   1.25),
  -- Groq
  ('llama-3.3-70b-versatile',     'groq',       0.59,   0.79),
  ('mixtral-8x7b-32768',          'groq',       0.27,   0.27),
  -- ElevenLabs (credits-based, price shown per 1M credits for reference)
  ('eleven_monolingual_v1',       'elevenlabs', 0.00, 500.00);
