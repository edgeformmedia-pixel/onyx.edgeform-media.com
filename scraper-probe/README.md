# Scraper Probe

A separate, read-only extension that opens **one** Google Maps business in slow
motion and writes down everything that happens, in order, so the reason a phone
number is missing can be read off the record instead of guessed at.

It does not scrape, does not sync to ONYX, and does not touch the LeadHunter
extension. Load them side by side.

## Install

1. This `scraper-probe/` folder lives next to `extensionfiles/` in the repo.
2. `chrome://extensions` → Developer mode on → **Load unpacked** → pick `scraper-probe/`.
3. Open a Google Maps search, e.g. `laser hair removal Miami FL`.
4. A panel appears at the bottom: pick a result number, press **Record this lead**.
5. It runs for about 40 seconds and downloads two files.

Turn LeadHunter off while probing, or its panel and this one will both be on screen.

## What comes out

`scraper-probe-<business>-<timestamp>.html` — read this first. Top to bottom:

- **Verdict** — one of `phone-present`, `phone-arrives-late`,
  `info-region-missing`, `info-region-name-mismatch`,
  `phone-outside-info-region`, `selector-shape-miss`, `no-phone-in-dom`,
  plus what each means for `content.js`.
- **Timeline** — every 300 ms from the click, expandable. Each step shows the
  heading, whether the `Information for …` region exists and whether its name
  matched, every `div[role="region"]` on the page, every `[data-item-id]` on the
  page, and the result of all 13 extraction strategies with the full `outerHTML`
  of whatever each one matched.
- **DOM revisions** — the complete markup of the detail pane, re-saved every
  time it actually changed. Reading these in order shows the panel assembling
  itself field by field.
- **Mutation log** — every DOM change inside the pane with a CSS path and a
  timestamp. Rows containing a phone-shaped string are highlighted.
- **Full `document.body`** before the click and at the end, unabridged.

`scraper-probe-<business>-<timestamp>.json` — the same data, for a model to parse.

Both files also include a **Complete lead snapshot**: name, category, phone,
address, website, rating, review count, open status, plus code, coordinates,
Maps URL, and every labeled/detail row found in DOM order. The raw timeline
remains the source of truth if a normalized field is blank or ambiguous.

## The 13 strategies

| id | field | scope | what it is |
|----|-------|-------|------------|
| p1 | phone | `Information for …` region | **exactly what `readCoreFields()` uses today** |
| p2 | phone | whole document | same selector, unscoped |
| p3 | phone | `div[role=main]` | same selector, pane-scoped |
| p4 | phone | document | `[data-item-id^="phone:tel:"]` |
| p5 | phone | document | copy-phone tooltip button |
| p6 | phone | document | any `a[href^="tel:"]` |
| p7 | phone | document | any aria-label that looks like a number |
| p8 | phone | pane | leaf text nodes that look like a number |
| n1 | name | document | `h1.DUwDvf` |
| a1 / a2 | address | region / document | production vs unscoped |
| w1 / w2 | website | region / document | production vs unscoped |

p1 versus p2–p8 is the whole point: if p1 is empty and the others are not, the
production scraper is looking in the wrong place, and the report says exactly
where the element actually was.

## Prompt to hand to GPT with the files

> Attached is a DOM probe of a single Google Maps business, captured with
> deliberate 300 ms polling over 30 seconds plus a slow scroll pass.
> `verdict.cause` is my diagnosis; check it against the evidence rather than
> trusting it. The production scraper reads the phone with
> `infoRegion(name).querySelector('button[aria-label^="Phone:"],button[data-item-id^="phone:"]')`
> where `infoRegion` selects `div[role="region"][aria-label^="Information for "]`
> and name-matches it against `h1.DUwDvf`, and it stops waiting via
> `waitForDetail()` roughly 520 ms after two of three fields land, capped at
> 1800 ms. Using `timeline[].state.strategies`, `timeline[].state.regions`,
> `revisions[].html` and `mutations[]`, tell me the earliest millisecond at
> which a correct phone selector could have succeeded, which container the
> phone element actually lives in, and the minimal change to `readCoreFields`
> and `waitForDetail` that makes it reliable.

## Timings

In `probe.js`, `CFG` at the top: `tickMs` 300, `maxWatchMs` 30000,
`quietStopMs` 6000, plus six 700 ms scroll steps. Raise `maxWatchMs` if a
panel is slower than 30 s; it stops early anyway once a phone is found and the
pane goes quiet.
