# xocs-imgs

Images and part data for [XO Craft Solution](https://github.com/nanosabo/XO-Craft-Solution), served via GitHub Pages:

- `images/items/<id>.webp` — item icons from `crossoutcore.ru`
- `images/parts/<id>.png` — part icons (the site serves WebP bytes under the `.png` name, which browsers handle fine)
- `actual_parts.json` — part stats used by the crafting solver and required-parts picker

## Automatic sync

The repository is synced with `https://crossoutcore.ru` by
[`.github/workflows/sync.yml`](.github/workflows/sync.yml) every day at 03:17 UTC,
and can be triggered manually from the **Actions** tab.

The workflow runs `scripts/sync.mjs`, which:

1. Loads the full parts list from `/building/` (`initialPartsData`) and regenerates `actual_parts.json`.
2. Loads item ids from `/sitemap.xml`.
3. Downloads missing or changed item/part images.
4. Commits and pushes only when something actually changed.

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
| `XOCS_MIRROR` | `https://cross.vas-matrizza.workers.dev` | Fallback mirror used on network errors / 5xx |
| `INCLUDE_FRAMES` | `0` | `1` to sync category 2 (`Рамы`) |
| `PRUNE` | `0` | `1` to delete images that no longer exist on the site |
| `CONCURRENCY` | `8` | Parallel image downloads |
| `TIMEOUT_MS` | `20000` | Per-request timeout |

## Integrity report

`node scripts/sync.mjs --check` prints a summary of:

- new / removed / changed parts in `actual_parts.json`;
- added / updated / unchanged images;
- images that return 404 on the site;
- invalid image files;
- extra local images that are no longer on the site.
