# ONYX LeadHunter v4.2

This Chrome extension collects Google Maps businesses one at a time and saves
each completed lead to ONYX before opening the next result.

## Install or update

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. If LeadHunter is already installed, click its **Reload** button. Otherwise,
   click **Load unpacked** and select this `extensionfiles` folder.
4. Reload the Google Maps tab once after reloading the extension.
5. Use **Collect complete leads** for configured searches, or open a Maps
   results list and use **Collect this Maps search**.

## Collection behavior

- Accepts only real `/maps/place/` result cards inside the Maps results feed.
- Discovers and opens one visible card at a time; it no longer races through
  the results list collecting names before opening the business panels.
- Opens and name-verifies every business before reading it.
- Waits up to 15 seconds for a late phone number instead of abandoning the
  detail panel after roughly 1.8 seconds.
- Slowly scrolls the detail pane so lazy detail rows are rendered.
- Keeps each business panel open for at least eight seconds and waits for its
  rating/review count before saving.
- Saves each accepted lead locally and to ONYX immediately, before advancing.
- Queues every unique business before upload and retries the queue every ten
  seconds until the Cloudflare database confirms it.
- Uploads unique businesses even when Google does not publish a phone,
  website, rating, or another optional field.
- Uses deduplication as the only upload gate. Phone, chain, rating, and
  laser-context settings may label research records but do not block a unique
  Google business from being stored.

Each ONYX record contains the standard lead fields plus full address, hours,
plus code, containing location, description, price level, booking/menu URLs,
coordinates, Google place ID, and an ordered `mapDetails` collection of the
labeled Google Maps rows that were available.
