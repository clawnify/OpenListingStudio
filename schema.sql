-- OpenListingStudio — canonical schema.
-- Brand kits set the voice + visual system; products carry the catalog facts;
-- reviews are the raw customer evidence; a LAUNCH is the first-class object —
-- one packaged workflow run (insights → listing copy → image stack) with a
-- lifecycle. Assets are the launch's renderable image stack plus any
-- directed-edit outputs from the Tools workspace (launch_id NULL for those).

CREATE TABLE IF NOT EXISTS brand_kits (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT 'Untitled Brand',
  colors TEXT NOT NULL DEFAULT '{}',   -- JSON { primary, secondary, accent, background, palette?: [hex] }
  fonts TEXT NOT NULL DEFAULT '{}',    -- JSON { heading, body } — web-safe or Google fonts
  tone TEXT NOT NULL DEFAULT '[]',     -- JSON array of voice chips, e.g. ["bold","punchy","direct"]
  notes TEXT NOT NULL DEFAULT '',
  logo_r2_key TEXT,
  mood_board_r2_keys TEXT NOT NULL DEFAULT '[]', -- JSON array of pinned inspiration image keys
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  brand_kit_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  asin TEXT,
  marketplace TEXT NOT NULL DEFAULT 'amazon.com',
  category TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '[]',      -- JSON array of feature strings
  specs TEXT NOT NULL DEFAULT '{}',         -- JSON { key: value }
  image_r2_keys TEXT NOT NULL DEFAULT '[]', -- JSON array of uploaded photo keys
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_brand ON products(brand_kit_id);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'paste',  -- paste | csv | serpapi
  rating REAL,
  title TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews(product_id);

CREATE TABLE IF NOT EXISTS launches (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'launch',     -- launch | optimize
  status TEXT NOT NULL DEFAULT 'draft',    -- draft | generating | ready | failed | exported
  insights TEXT,       -- JSON { source, review_insights[], product_features[], conversion_drivers[] } — quotes verbatim
  listing_copy TEXT,   -- JSON { title, bullets[5], description, backend_keywords }
  steps TEXT,          -- JSON [{ step, label, status: pending|active|done|failed, meta: [chips] }] — workflow timeline
  config TEXT,         -- JSON { image_type: listing|aplus|full, qty: 1-3, format: "1:1" } — generation config
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_launches_product ON launches(product_id);

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  launch_id TEXT,             -- NULL for directed-edit outputs from the Tools workspace
  product_id TEXT NOT NULL,
  template_id TEXT NOT NULL,  -- templates.ts id, 'main_image', or 'tool:<tool_id>'
  size_label TEXT NOT NULL DEFAULT '',
  width INTEGER NOT NULL DEFAULT 0,
  height INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | rendering | done | failed
  r2_key TEXT,
  error TEXT,
  qa TEXT,                    -- JSON { status: pass|fail, issues: [..], checked_at } — optional vision QA verdict
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_assets_launch ON assets(launch_id);
CREATE INDEX IF NOT EXISTS idx_assets_product ON assets(product_id);
