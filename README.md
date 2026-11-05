# xocs-imgs

Images and part data for [XO Craft Solution](https://github.com/nanosabo/XO-Craft-Solution), served via GitHub Pages:

- `images/items/<id>.webp` — item icons from `crossoutcore.ru`
- `images/parts/<id>.png` — part icons (the site serves WebP bytes under the `.png` name, which browsers handle fine)
- `actual_parts.json` — part stats used by the crafting solver and required-parts picker
- `market_items.json` — market catalogue (Russian names) used when the site itself is unreachable
- `market_items_en.json` — the same catalogue with English names

## Automatic sync

The repository is synced with `https://crossoutcore.ru` by
[`.github/workflows/sync.yml`](.github/workflows/sync.yml) every day at 03:17 UTC,
and can be triggered manually from the **Actions** tab.

The workflow runs `scripts/sync.mjs`, which:

1. Loads the full parts list from `/building/` (`initialPartsData`) and regenerates `actual_parts.json`.
2. Loads the market catalogues from `/market/` and `/en/market/` (`initialData`) and regenerates `market_items.json` and `market_items_en.json`.
3. Loads item ids from `/sitemap.xml`.
4. Downloads missing or changed item/part images.
5. Commits and pushes only when something actually changed.

The market catalogues intentionally contain no prices: they change every few
minutes and would make every sync produce a commit. The desktop app fetches the
current price table through the site's `checkUpdateStatus` server action, which
is fast even when the full market page is not reachable.

Commits made with the built-in `GITHUB_TOKEN` do not trigger the automatic
`pages build and deployment` workflow, so after a sync commit the workflow
explicitly requests a Pages rebuild (`POST /repos/{owner}/{repo}/pages/builds`)
and waits for it to finish. That is why the workflow declares `pages: write`.

The workflow also runs when `scripts/**` or `.github/workflows/sync.yml` is
pushed, which makes it possible to test changes to the automation itself.

Category 2 (`Рамы`) is excluded from `actual_parts.json`, matching the previous
contents of the repository and the solver's behaviour. Set `INCLUDE_FRAMES=1` to
include frames as well.

Parts whose names end in `СХ` (Cyrillic) or `CX` (Latin) are never published:
they are skipped both in `actual_parts.json` and in the part-image sync.

## Manual corrections (overrides)

The site sometimes has wrong data or broken images. Manual fixes must survive the
daily sync, so they live in `overrides/` and are applied **after** the site data.
Nothing under `overrides/` is ever downloaded or overwritten by the sync.

### Fixed values in `actual_parts.json`

`overrides/parts.json` maps a part id to the fields that should always win over
the site:

```json
{
  "100f624e": {
    "maxCount": 12,
    "build_hp": 32
  }
}
```

Rules:

- only fields that already exist on the part can be overridden; a typo fails the
  sync instead of silently doing nothing;
- the value type must match the field type (`number` for `maxCount`, `string`
  for `name`, and so on);
- `id` cannot be overridden;
- overrides for parts that no longer exist on the site are reported as
  `overrides for missing parts` so stale entries can be cleaned up.

### Pinned images

Put the correct file in `overrides/images/parts/<id>.png` or
`overrides/images/items/<id>.webp`. While a pinned file exists:

- it always wins over the site, even with `--force`;
- the site copy in `images/` is replaced by the pinned file;
- the id is protected from `PRUNE`.

The same extensions and formats as the normal images are required (WebP or PNG
for parts, WebP for items); an invalid pinned file fails the sync.

To go back to the site version, delete the file from `overrides/images/…` and run
the sync again.

## Manual usage

Requires Node.js 20 or newer. There are no dependencies to install.

```bash
# Check what would change, without writing anything
node scripts/sync.mjs --check

# Apply changes
node scripts/sync.mjs

# Re-download every image even if the hash matches
node scripts/sync.mjs --force
```

### Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `XOCS_SITE` | `https://crossoutcore.ru` | Primary source |
| `XOCS_MIRROR` | — | Optional fallback mirror used on network errors / 5xx |
| `INCLUDE_FRAMES` | `0` | `1` to sync category 2 (`Рамы`) |
| `PRUNE` | `0` | `1` to delete images that no longer exist on the site |
| `CONCURRENCY` | `8` | Parallel image downloads |
| `TIMEOUT_MS` | `20000` | Per-request timeout |
| `MARKET_TIMEOUT_MS` | `120000` | Timeout for the market page (it is much slower than static files) |

## Integrity report

`node scripts/sync.mjs --check` prints a summary of:

- new / removed / changed parts in `actual_parts.json`;
- pinned part fields taken from `overrides/parts.json`;
- added / updated / unchanged images;
- pinned images taken from `overrides/images/…`;
- images that return 404 on the site;
- invalid image files;
- extra local images that are no longer on the site.
