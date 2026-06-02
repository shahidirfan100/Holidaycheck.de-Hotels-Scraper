# API Discovery

## Selected API

- Endpoint: `https://www.holidaycheck.de/api/hwo/hotelsWithOffer`
- Method: `POST`
- Auth: None
- Pagination: `offset` + `limit`
- Fields available:
  `id`, `name`, `stars`, `starsSource`, `geo`, `parents`, `reviewCalculations.uniqueSellingPoints`, `reviewCalculations.overall`, `reviewCalculations.perTraveledWith`, `latestAward`, `fingerprints`, `shouldIndex`, `campaigns`, `facilities`, `offer`
- Fields added compared with the old actor:
  destination hierarchy, offer context, coordinates, fingerprints, awards, campaigns, travel details, cashback labels
- Field count: materially larger than the original Remote.co HTML actor

## Why This API Won

- Returns JSON directly
- No authentication required
- Supports pagination with `offset` and `limit`
- Supports both `package` and `hotelonly` listing contexts
- Returns the richest hotel record among the discovered HolidayCheck endpoints

## Supporting Discovery Notes

- Direct hotel listing pages under `/dh/` load `hwo/hotelsWithOffer`
- Destination pages such as `/urlaub/...` expose a `showMoreHref` that resolves to a `/dh/` hotel listing page
- `hotel-reviews` is useful for review excerpts but is not required for the main hotel dataset
- `destinationBestsellerHotels` returns a smaller landing-page subset and was rejected as the primary extraction source

## Rejected Candidates

- `hwo/destinationBestsellerHotels`
  Rejected because it only returns a landing-page subset and is not the main paginated destination listing.
- `hotel-reviews`
  Rejected because it is an enrichment endpoint, not the hotel listing source.
- HTML extraction
  Rejected because the actor should stay API-first and avoid scraping rendered hotel cards.
