# OpenListingStudio — agent guide

AI listing-content studio for e-commerce sellers (Amazon-first). Brand kits + product library + review-grounded Launch workflow (insights → compliant listing copy → branded image stack + A+ modules) + directed-edit image tools.

## Pages

- `/` — Product library table (screenshot-friendly overview). Add products here.
- `/products/{id}` — Product detail: reviews (paste / CSV / live Amazon import), photos with roles (main/angle/detail), features, launches list. Start a launch here.
- `/launches/{id}` — Launch detail: agentic-workflow timeline, Review Insights / Product Features / Conversion Drivers tables (CSV/JSON export), listing-copy editor with per-field Amazon-limit counters, image-stack grid with per-asset render + vision QA. Best screenshot page once a launch is `ready`.
- `/brands` — Brand kits: typography, voice chips, mood board, color palette.
- `/tools` — Directed-edit image workspace (upload or pick a product photo, run edits).

## Agent API (also discoverable at /api/openapi.json and /llms.txt)

- `GET /api/v1/products?limit=&offset=&search=` — bounded product page `{items, total, limit, offset}`. Use `search` to narrow.
- `POST /api/v1/launches` `{product_id, kind?: "launch"|"optimize"}` — runs the full text workflow synchronously (~20s) and returns the launch with insights, copy, and pending assets.
- `GET /api/v1/launches/{id}` — launch state: `status`, `steps` (workflow timeline), `insights`, `listing_copy`, `assets`.
- `POST /api/assets/{id}/render` — render ONE pending asset (fire these in parallel after a launch; each runs in its own request).
- `POST /api/assets/{id}/qa` — optional vision QA on a rendered asset → `qa: {status: pass|fail, issues}`.
- `GET /api/v1/tools` — directed-edit tool registry (inputs per tool).
- `POST /api/v1/render` `{tool_id, source_image_url, params?, product_id?}` — run a directed edit, returns the finished asset (`r2_key` is the image URL).

## Facts an agent should know

- Insights quotes are verified verbatim server-side; `insights.source: "ai"` means no reviews existed (estimated tier — labelled, quote-free).
- Listing copy is validated against Amazon limits: title ≤200 chars, exactly 5 bullets ≤250 chars, description ≤2000 chars, backend keywords ≤249 bytes.
- Reviews in: `POST /api/products/{id}/reviews/paste` `{text}` (verbatim AI split), `.../reviews/csv` (multipart file), `.../reviews/import-live` (needs SERPAPI_API_KEY).
- Product photos: `POST /api/products/{id}/photos` (multipart, optional `role`), `PUT`/`DELETE` same path with `{r2_key, role?}`. The `main`-role photo drives generations.
- Cutouts (transparent product for template compositing, cached as `cutout_r2_key` on the photo): auto-generated via BiRefNet on first templated render (FAL key), or a source upload with real alpha is its own cutout. `POST /api/products/{id}/photos/cutout` `{r2_key}` regenerates; `PUT` same path (multipart `file` + `r2_key`) sets your own — rejected unless the file truly has an alpha channel.
