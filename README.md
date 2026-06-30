# HolidayCheck Hotels Scraper

Extract HolidayCheck hotel listings from destination hotel pages and destination landing pages. Collect hotel names, destination hierarchy, review summaries, selling points, pricing context, travel details, and offer metadata in a structured dataset that is ready for research, travel monitoring, and market analysis.

## Features

- **Destination hotel extraction** - Collect hotel listings from HolidayCheck destination hotel pages
- **Multiple URL patterns** - Accept direct hotel listing URLs and destination pages that lead to hotel listings
- **Package and hotel-only support** - Preserve the search mode already encoded in the source URL
- **Rich hotel records** - Return pricing context, destination hierarchy, ratings, awards, compact fingerprint summaries, and offer details
- **Clean datasets** - Skip empty and null fields so exported data stays compact and usable

## Use Cases

### Travel Market Research
Compare hotel supply, pricing context, and review signals across destinations. Use the dataset to monitor which destinations have stronger recommendation rates or stronger offer positioning.

### Hotel Discovery Workflows
Build destination-specific hotel lists for content, planning, or internal travel tooling. Use one or more HolidayCheck URLs as seeds and export the results to downstream systems.

### Competitive Monitoring
Track how featured hotels, review strength, and offer details change for the same destination over time. Run the actor on a schedule and compare snapshots.

### Enrichment for Analytics
Join HolidayCheck hotel IDs, destination hierarchy, and pricing context with your internal travel data. The output works well in spreadsheet, BI, and warehouse pipelines.

---

## Input Parameters

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `urls` | Array | Yes | - | One or more HolidayCheck URLs. Direct `/dh/` hotel listing URLs are preferred, but destination pages are also supported. |
| `results_wanted` | Integer | No | `20` | Maximum number of hotels to collect across all provided URLs. |
| `max_pages` | Integer | No | `3` | Safety cap for how many result pages to request per URL. |
| `proxyConfiguration` | Object | No | `{"useApifyProxy": false}` | Optional proxy configuration for more reliable access. |

---

## Output Data

Each dataset item can contain the following fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | String | HolidayCheck hotel ID |
| `name` | String | Hotel name |
| `hotel_url` | String | HolidayCheck hotel detail URL |
| `stars` | Number | Hotel star rating |
| `stars_source` | String | Source of the star classification |
| `destination_id` | String | Destination ID from the source page |
| `destination_name` | String | Destination name |
| `destination_type` | String | Destination type such as continent, country, region, or city |
| `destination_page_path` | String | Destination path on HolidayCheck |
| `listing_url` | String | Listing page used for extraction |
| `source_url` | String | Original URL provided as input |
| `locale` | String | Locale of the extracted page |
| `travelkind` | String | Search mode such as `package` or `hotelonly` |
| `position` | Number | Position in the collected dataset |
| `coordinates` | Object | Latitude and longitude |
| `parents` | Array | Parent destination hierarchy |
| `fingerprint_tags` | Array | Positive fingerprint tags returned for the hotel |
| `fingerprint_filters` | Array | Fingerprint filters attached to the hotel |
| `fingerprint_scores` | Object | Fingerprint scores keyed by fingerprint name |
| `review` | Object | Rating, recommendation rate, ranking, trend, counts, and selling points |
| `latest_award` | Object | Latest known HolidayCheck award information |
| `campaigns` | Array | Campaign tags attached to the listing |
| `should_index` | Boolean | Indexing flag returned for the hotel |
| `offer` | Object | Price, dates, room, meal, airports, cashback labels, flights, and travel details for the current search context |

---

## Usage Examples

### Direct Hotel Listing URL

Use a HolidayCheck destination hotel listing page directly:

```json
{
  "urls": [
    {
      "url": "https://www.holidaycheck.de/dh/hotels-afrika/7de062f4-676c-3e2b-ad4a-12fd69afbeb6?duration=7&rooms=a-a&travelkind=package"
    }
  ],
  "results_wanted": 20,
  "max_pages": 3
}
```

### Hotel-Only Search Context

Keep the `hotelonly` search mode from the input URL:

```json
{
  "urls": [
    {
      "url": "https://www.holidaycheck.de/dh/hotels-afrika/7de062f4-676c-3e2b-ad4a-12fd69afbeb6?duration=7&rooms=a-a&travelkind=hotelonly"
    }
  ],
  "results_wanted": 12,
  "max_pages": 2
}
```

### Destination Page Input

Start from a destination page and let the actor resolve the matching hotel listing:

```json
{
  "urls": [
    {
      "url": "https://www.holidaycheck.de/urlaub/afrika"
    },
    {
      "url": "https://www.holidaycheck.de/ferien/afrika"
    }
  ],
  "results_wanted": 24,
  "max_pages": 2
}
```

---

## Sample Output

```json
{
  "id": "1aa4c4ad-f9ea-3367-a163-8a3a6884d450",
  "name": "Pickalbatros Dana Beach Resort - Hurghada",
  "hotel_url": "https://www.holidaycheck.de/hi/pickalbatros-dana-beach-resort-hurghada/1aa4c4ad-f9ea-3367-a163-8a3a6884d450",
  "stars": 5,
  "destination_id": "7de062f4-676c-3e2b-ad4a-12fd69afbeb6",
  "destination_name": "Afrika",
  "travelkind": "hotelonly",
  "review": {
    "rating": 5.6567,
    "recommendation_rate": 0.9582,
    "ranking": 0.938,
    "count_unarchived": 28045,
    "unique_selling_points": [
      "FINGERPRINT_BEACH",
      "FINGERPRINT_SERVICE",
      "FINGERPRINT_VALUE_FOR_MONEY"
    ]
  },
  "fingerprint_tags": [
    "BEACH",
    "SERVICE",
    "VALUE_FOR_MONEY"
  ],
  "fingerprint_filters": [
    "BEACH",
    "SERVICE",
    "VALUE_FOR_MONEY"
  ],
  "offer": {
    "type": "package",
    "price_per_person": 657,
    "total_price": 1314,
    "currency": "EUR",
    "start_date": "2026-06-06",
    "end_date": "2026-06-13",
    "room_name": "Doppelzimmer",
    "meal_type": "GT06-AI",
    "departure_airport": "BSL",
    "destination_airport": "HRG",
    "cashback_labels": [
      "10 € Cashback",
      "35 € Cashback"
    ]
  }
}
```

---

## Tips for Best Results

### Prefer Direct Hotel Listing URLs

- Use `/dh/` destination hotel URLs when possible
- These URLs preserve the exact search context already configured on HolidayCheck

### Keep Result Size Practical

- Start with `results_wanted: 20` for quick validation
- Increase `max_pages` only when you need deeper pagination

### Use Search-Specific URLs

- If you care about a specific travel context, use a URL that already contains the right dates and travel mode
- The actor keeps that context when collecting offer details

### Use Proxies When Needed

- If you run larger jobs or schedules, add proxy configuration
- This is helpful for repeated production runs

---

## Integrations

Connect your data with:

- **Google Sheets** - Export hotel lists for review and comparison
- **Airtable** - Build searchable hotel research databases
- **Make** - Trigger downstream travel workflows
- **Zapier** - Send hotel data into business tools
- **Webhooks** - Push data to custom APIs or storage pipelines

### Export Formats

- **JSON** - For APIs and engineering workflows
- **CSV** - For spreadsheet and reporting workflows
- **Excel** - For business sharing and analysis
- **XML** - For structured system integrations

---

## Frequently Asked Questions

### Which HolidayCheck URLs work best?

Direct destination hotel listing URLs work best. Destination pages are also supported when they expose a linked hotel listing page.

### Can I use more than one URL in a single run?

Yes. Add multiple HolidayCheck URLs to `urls`, and the actor will process them in order until it reaches the requested result limit.

### Does the actor support package and hotel-only searches?

Yes. The actor keeps the search mode that is already encoded in the provided URL.

### Why do some records contain more fields than others?

HolidayCheck does not return the same data for every hotel and every search context. Empty values are removed instead of being returned as `null`.

### Can I paginate through more than the first page?

Yes. Increase `max_pages` to let the actor request more result pages for each input URL.

### What happens if I provide a destination page instead of a hotel listing page?

The actor first resolves the matching hotel listing URL and then collects hotel data from that listing.

---

## Support

For issues or feature requests, contact support through the Apify Console.

### Resources

- [Apify Documentation](https://docs.apify.com/)
- [Apify API Reference](https://docs.apify.com/api/v2)
- [Apify Schedules](https://docs.apify.com/platform/schedules)

---

## Legal Notice

This actor is designed for legitimate data collection purposes. Users are responsible for ensuring compliance with HolidayCheck terms and all applicable laws. Use collected data responsibly and at appropriate request volumes.
