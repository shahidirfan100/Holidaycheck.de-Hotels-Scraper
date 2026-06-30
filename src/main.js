/* eslint import-x/no-default-export: "off" */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { Actor, log } from 'apify';
import { load as cheerioLoad } from 'cheerio';
import { gotScraping } from 'got-scraping';

const DEFAULT_RESULTS_WANTED = 20;
const DEFAULT_MAX_PAGES = 3;
const PAGE_SIZE = 12;
const DEFAULT_ADVANCE_DAYS = 30;
const HOLIDAYCHECK_ORIGIN = 'https://www.holidaycheck.de';
const HOLIDAYCHECK_HOST = 'www.holidaycheck.de';
const HOLIDAYCHECK_HOSTS = new Set([HOLIDAYCHECK_HOST, 'holidaycheck.de']);
const HOTELS_WITH_OFFER_ENDPOINT = `${HOLIDAYCHECK_ORIGIN}/api/hwo/hotelsWithOffer`;
const LISTING_SELECT = [
    'id',
    'name',
    'stars',
    'starsSource',
    'geo',
    'parents',
    'reviewCalculations.uniqueSellingPoints',
    'reviewCalculations.overall',
    'reviewCalculations.perTraveledWith',
    'latestAward',
    'fingerprints',
    'shouldIndex',
    'campaigns',
].join(',');

const DEFAULT_HEADERS = {
    'accept': 'application/json, text/plain, */*',
    'content-type': 'application/json',
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36',
    'x-requested-with': 'XMLHttpRequest',
};

const ALLOWED_INPUT_ALIASES = ['urls', 'startUrls', 'startUrl', 'url'];
const PRESERVED_SEARCH_PARAMS = [
    'duration',
    'rooms',
    'travelkind',
    'departuredate',
    'departureDate',
    'returndate',
    'returnDate',
];

const wait = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
let apiDiscoveryNotesPromise;

function getUrlKind(urlString) {
    try {
        const { pathname } = new URL(urlString);
        if (pathname.startsWith('/dh/')) return 'listing';
        if (pathname.startsWith('/urlaub/')) return 'urlaub';
        if (pathname.startsWith('/ferien/')) return 'ferien';
        return 'other';
    } catch {
        return 'invalid';
    }
}

function toArray(value) {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
}

function normalizeInputUrls(input) {
    const urls = [];
    for (const key of ALLOWED_INPUT_ALIASES) {
        for (const candidate of toArray(input[key])) {
            const rawValue = typeof candidate === 'string' ? candidate : candidate?.url;
            if (typeof rawValue !== 'string') continue;
            const normalized = normalizeHolidayCheckUrl(rawValue);
            if (normalized) urls.push(normalized);
        }
    }

    return [...new Set(urls)];
}

function toAbsoluteUrl(value, baseUrl = HOLIDAYCHECK_ORIGIN) {
    try {
        return new URL(value, baseUrl).href;
    } catch {
        return null;
    }
}

function normalizeHolidayCheckUrl(value, baseUrl = HOLIDAYCHECK_ORIGIN) {
    if (typeof value !== 'string') return null;

    const compacted = value
        .trim()
        .replace(/^<|>$/g, '')
        .replace(/\s+/g, '')
        .replace(/^http:\/\//i, 'https://');
    if (!compacted) return null;

    const withScheme = compacted.startsWith('//')
        ? `https:${compacted}`
        : compacted;
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(withScheme) || withScheme.startsWith('/')
        ? withScheme
        : `https://${withScheme}`;

    let parsed;
    try {
        parsed = new URL(candidate, baseUrl);
    } catch {
        return null;
    }

    if (!HOLIDAYCHECK_HOSTS.has(parsed.hostname.toLowerCase())) {
        return null;
    }

    parsed.protocol = 'https:';
    parsed.hostname = HOLIDAYCHECK_HOST;
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');

    for (const [from, to] of [
        ['departureDate', 'departuredate'],
        ['returnDate', 'returndate'],
    ]) {
        if (parsed.searchParams.has(from) && !parsed.searchParams.has(to)) {
            parsed.searchParams.set(to, parsed.searchParams.get(from));
        }
        parsed.searchParams.delete(from);
    }

    return parsed.href;
}

function mergeSearchParams(targetUrl, sourceUrl) {
    const target = normalizeHolidayCheckUrl(targetUrl);
    const source = normalizeHolidayCheckUrl(sourceUrl);
    if (!target || !source) return target;

    const targetParsed = new URL(target);
    const sourceParsed = new URL(source);
    for (const key of PRESERVED_SEARCH_PARAMS) {
        if (!targetParsed.searchParams.has(key) && sourceParsed.searchParams.has(key)) {
            targetParsed.searchParams.set(key, sourceParsed.searchParams.get(key));
        }
    }

    return normalizeHolidayCheckUrl(targetParsed.href);
}

function isListingUrl(urlString) {
    try {
        const { pathname, hostname } = new URL(urlString);
        return HOLIDAYCHECK_HOSTS.has(hostname.toLowerCase()) && pathname.startsWith('/dh/');
    } catch {
        return false;
    }
}

function parseScriptAssignment(html, variableName) {
    const $ = cheerioLoad(html);
    const scriptNode = $('script')
        .toArray()
        .find((script) => ($(script).html() || '').includes(`window.${variableName}`));
    if (!scriptNode) return null;

    const scriptBody = $(scriptNode).html() || '';
    const marker = `window.${variableName}`;
    const startIndex = scriptBody.indexOf(marker);
    if (startIndex < 0) return null;

    const equalsIndex = scriptBody.indexOf('=', startIndex);
    if (equalsIndex < 0) return null;

    const expression = extractAssignedExpression(scriptBody, equalsIndex + 1);
    const sandbox = {};
    return vm.runInNewContext(`(${expression})`, sandbox, { timeout: 1000 });
}

function extractAssignedExpression(source, startIndex) {
    let depthCurly = 0;
    let depthSquare = 0;
    let depthParen = 0;
    let inString = false;
    let stringQuote = '';
    let escaped = false;
    let expression = '';

    for (let index = startIndex; index < source.length; index++) {
        const character = source[index];
        expression += character;

        if (escaped) {
            escaped = false;
            continue;
        }

        if (inString) {
            if (character === '\\') {
                escaped = true;
            } else if (character === stringQuote) {
                inString = false;
                stringQuote = '';
            }
            continue;
        }

        if (character === '"' || character === '\'' || character === '`') {
            inString = true;
            stringQuote = character;
            continue;
        }

        if (character === '{') depthCurly++;
        else if (character === '}') depthCurly--;
        else if (character === '[') depthSquare++;
        else if (character === ']') depthSquare--;
        else if (character === '(') depthParen++;
        else if (character === ')') depthParen--;
        else if (character === ';' && depthCurly === 0 && depthSquare === 0 && depthParen === 0) {
            return expression.slice(0, -1).trim();
        }
    }

    return expression.trim();
}

function extractShowMoreHref(html) {
    const showMoreMatch = html.match(/"showMoreHref":"([^"]+)"/);
    if (showMoreMatch) {
        return toAbsoluteUrl(showMoreMatch[1].replace(/\\u002F/g, '/'));
    }

    const $ = cheerioLoad(html);
    const candidate = $('a[href*="/dh/hotels-"]').first().attr('href');
    return candidate ? toAbsoluteUrl(candidate) : null;
}

async function fetchText(url, proxyConfiguration) {
    const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
    const response = await gotScraping.get(url, {
        proxyUrl,
        headers: {
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'user-agent': DEFAULT_HEADERS['user-agent'],
        },
        timeout: { request: 60000 },
        retry: { limit: 2 },
    });

    return response.body;
}

async function readApiDiscoveryNotes() {
    apiDiscoveryNotesPromise ??= readFile(new URL('../API_DISCOVERY.md', import.meta.url), 'utf8')
        .catch(() => 'API discovery notes unavailable.');
    return apiDiscoveryNotesPromise;
}

async function resolveListingUrl(startUrl, proxyConfiguration) {
    const normalizedStartUrl = normalizeHolidayCheckUrl(startUrl);
    if (!normalizedStartUrl) {
        throw new Error(`Invalid HolidayCheck URL: ${startUrl}`);
    }

    if (isListingUrl(normalizedStartUrl)) {
        return { listingUrl: normalizedStartUrl, landingUrl: normalizedStartUrl, resolution: 'listing-url' };
    }

    const html = await fetchText(normalizedStartUrl, proxyConfiguration);
    const listingUrl = mergeSearchParams(extractShowMoreHref(html), normalizedStartUrl);
    if (!listingUrl) {
        throw new Error(`Could not resolve a HolidayCheck hotel listing URL from ${normalizedStartUrl}`);
    }

    return { listingUrl, landingUrl: normalizedStartUrl, resolution: 'landing-url' };
}

function getStoresFromHtml(html) {
    const fluxibleState = parseScriptAssignment(html, '__FLUXIBLE_STATE__');
    const stores = fluxibleState?.dispatcher?.stores;
    if (!stores?.SearchParamsStore || !stores?.DestinationStore) {
        throw new Error('HolidayCheck page state is missing SearchParamsStore or DestinationStore');
    }

    return {
        stores,
    };
}

function parseIsoDateParts(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        throw new Error(`Invalid HolidayCheck date value: ${value}`);
    }

    return {
        year: date.getUTCFullYear(),
        monthOfYear: date.getUTCMonth() + 1,
        dayOfMonth: date.getUTCDate(),
    };
}

function formatDateOnly(date) {
    return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
    const nextDate = new Date(date);
    nextDate.setUTCDate(nextDate.getUTCDate() + days);
    return nextDate;
}

function normalizeDateRange(settings, sourceUrl) {
    const normalized = { ...settings };
    const url = toAbsoluteUrl(sourceUrl);
    const params = url ? new URL(url).searchParams : new URLSearchParams();
    const today = new Date();
    const todayUtc = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
    const fallbackDeparture = addDays(todayUtc, DEFAULT_ADVANCE_DAYS);
    const queryDuration = params.get('duration');
    const queryDepartureDate = params.get('departuredate') || params.get('departureDate');
    const queryReturnDate = params.get('returndate') || params.get('returnDate');
    const duration = Number(queryDuration ?? normalized.duration ?? 7) || 7;

    normalized.duration = String(duration);
    normalized.departureDate = queryDepartureDate || normalized.departureDate;
    normalized.returnDate = queryReturnDate || normalized.returnDate;

    const originalDepartureDate = normalized.departureDate;
    const originalReturnDate = normalized.returnDate;
    let repaired = false;
    let departureDate = new Date(normalized.departureDate || fallbackDeparture);
    if (Number.isNaN(departureDate.getTime()) || departureDate < todayUtc) {
        departureDate = fallbackDeparture;
        repaired = true;
    }

    let returnDate = new Date(normalized.returnDate || addDays(departureDate, duration));
    if (Number.isNaN(returnDate.getTime()) || returnDate <= departureDate) {
        returnDate = addDays(departureDate, duration);
        repaired = true;
    }

    normalized.departureDate = formatDateOnly(departureDate);
    normalized.returnDate = formatDateOnly(returnDate);

    if (repaired) {
        log.warning('Auto-healed HolidayCheck search dates', {
            original_departure_date: originalDepartureDate,
            original_return_date: originalReturnDate,
            normalized_departure_date: normalized.departureDate,
            normalized_return_date: normalized.returnDate,
        });
    }

    return normalized;
}

function mergeSearchSettings(listingUrl, searchParamsStore, destinationStore) {
    const defaultSearchSettings = searchParamsStore.defaultSearchSettings || {};
    const userSearchSettings = searchParamsStore.userSearchSettings || {};
    const travelkind = userSearchSettings.travelkind
        || defaultSearchSettings.travelkind
        || destinationStore.defaultTravelkind
        || 'package';
    const defaultTravelkindSettings = defaultSearchSettings[travelkind] || {};
    const userTravelkindSettings = userSearchSettings[travelkind] || {};
    const mergedTravelkindSettings = normalizeDateRange({
        ...defaultTravelkindSettings,
        ...userTravelkindSettings,
    }, listingUrl);

    return {
        ...defaultSearchSettings,
        ...userSearchSettings,
        travelkind,
        [travelkind]: mergedTravelkindSettings,
    };
}

function buildRoomsAndTravellers(settings) {
    const travellers = Array.isArray(settings.travellers) && settings.travellers.length
        ? settings.travellers.map((traveller) => ({
            age: traveller.age,
            travellerRefId: traveller.travellerRefId,
        }))
        : [
            { age: 25, travellerRefId: 1 },
            { age: 25, travellerRefId: 2 },
        ];

    const rooms = Array.isArray(settings.rooms) && settings.rooms.length
        ? settings.rooms.map((room) => ({
            travellerRefIds: room.travellerRefIds,
        }))
        : [{ travellerRefIds: travellers.map((traveller) => traveller.travellerRefId) }];

    return { travellers, rooms };
}

function buildMpgSearchSpec(searchSettings) {
    const travelkind = searchSettings?.travelkind || 'package';
    const settings = searchSettings?.[travelkind];
    if (!settings) {
        throw new Error(`HolidayCheck search settings missing travelkind payload for "${travelkind}"`);
    }

    const { travellers, rooms } = buildRoomsAndTravellers(settings);
    const common = {
        specials: [{ specialType: 'NON_LOGGED_IN_MEMBER_RATES', code: 'NON_LOGGED_IN_MEMBER_RATES', scope: 'SHOULD_HAVE' }],
        rooms,
        travellers,
    };

    if (travelkind === 'hotelonly') {
        return [
            'com.holidaycheck.mpg.searchspec.HotelOfferSearchSpec',
            {
                adults: settings.adults ?? travellers.length,
                numberOfRooms: settings.numberOfRooms ?? rooms.length,
                children: Array.isArray(settings.children) && settings.children.length ? settings.children : null,
                tourOperatorIds: [],
                room: null,
                preciseTravelDate: {
                    checkIn: parseIsoDateParts(settings.departureDate),
                    checkOut: parseIsoDateParts(settings.returnDate),
                },
                meal: null,
                priceRange: null,
                offerAttributeList: { offerAttributeIds: null },
                cancellationStatus: null,
                flex: false,
                deal: false,
                ...common,
            },
        ];
    }

    return [
        'com.holidaycheck.mpg.searchspec.PackageSearchSpec',
        {
            whitelistedTourOperatorIds: [],
            journey: {
                flight: {
                    departureAirPorts: settings.airport ?? [],
                    destinationAirPorts: [],
                    directFlight: false,
                },
                travelDate: [
                    'com.holidaycheck.mpg.model.hotel.UnpreciseTravelDate',
                    {
                        from: parseIsoDateParts(settings.departureDate),
                        to: parseIsoDateParts(settings.returnDate),
                        minDuration: Number(settings.duration ?? 7),
                        maxDuration: Number(settings.duration ?? 7),
                    },
                ],
                adults: settings.adults ?? travellers.length,
                numberOfRooms: settings.numberOfRooms ?? rooms.length,
                children: Array.isArray(settings.children) && settings.children.length ? settings.children : null,
                priceRange: null,
            },
            accommodation: [
                'com.holidaycheck.mpg.model.packageholiday.HotelAccommodation',
                {
                    transfer: null,
                    roomTypes: null,
                    meals: null,
                },
            ],
            offerAttributeList: { offerAttributeIds: null },
            cancellationStatus: null,
            flex: false,
            deal: false,
            ...common,
        },
    ];
}

function buildContextFromStores(listingUrl, landingUrl, stores) {
    const searchParamsStore = stores.SearchParamsStore;
    const destinationStore = stores.DestinationStore;
    const searchSettings = mergeSearchSettings(listingUrl, searchParamsStore, destinationStore);
    const travelkind = searchSettings?.travelkind || destinationStore.defaultTravelkind || 'package';
    const activeSettings = searchSettings?.[travelkind];

    return {
        landingUrl,
        listingUrl,
        destinationId: destinationStore.id,
        destinationName: destinationStore.name,
        destinationType: destinationStore.type,
        destinationPagePath: destinationStore.pagePaths?.de || destinationStore.pagePaths?.at || destinationStore.pagePaths?.ch || null,
        centroid: destinationStore.centroid?.coordinates
            ? `${destinationStore.centroid.coordinates[0]};${destinationStore.centroid.coordinates[1]}`
            : null,
        locale: stores.ApplicationStore?.locale || 'de-DE',
        travelkind,
        searchSettings,
        activeSettings,
        totalHotelsOnDestination: destinationStore.hotelCalculations?.overall?.count ?? null,
        totalReviewsOnDestination: destinationStore.hotelReviewCalculations?.overall?.countUnarchived ?? null,
    };
}

function buildHotelsWithOfferPayload(context, offset, limit) {
    return {
        body: null,
        context: {},
        operation: 'create',
        params: {
            select: LISTING_SELECT,
            filter: `destinations.id:${context.destinationId}`,
            sort: 'bookingCalculations.overall.ranking:desc,reviewCalculations.overall.ranking:desc,mediaCalculations.overall.count:desc',
            offset: String(offset),
            limit: String(limit),
            currency: 'EUR',
            destinationId: context.destinationId,
            withAds: false,
            withFacets: offset === 0 ? '1' : '0',
            withMlDeals: '0',
            centroid: context.centroid,
            mpgSearchSpec: buildMpgSearchSpec(context.searchSettings),
        },
        resource: 'hwo/hotelsWithOffer',
    };
}

async function fetchHotelsPage(context, offset, limit, proxyConfiguration) {
    const payload = buildHotelsWithOfferPayload(context, offset, limit);
    const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
    const response = await gotScraping.post(HOTELS_WITH_OFFER_ENDPOINT, {
        proxyUrl,
        headers: {
            ...DEFAULT_HEADERS,
            referer: context.listingUrl,
        },
        json: payload,
        timeout: { request: 60000 },
        retry: { limit: 2 },
    });

    const body = JSON.parse(response.body);
    if (!Array.isArray(body?.data?.items)) {
        throw new Error(`HolidayCheck API did not return hotel items for ${context.listingUrl}`);
    }

    return body.data;
}

async function refreshContext(context, proxyConfiguration) {
    const listingHtml = await fetchText(context.listingUrl, proxyConfiguration);
    const { stores } = getStoresFromHtml(listingHtml);
    return buildContextFromStores(context.listingUrl, context.landingUrl, stores);
}

async function diagnoseApiFailure(context, payload, proxyConfiguration, error) {
    const notes = await readApiDiscoveryNotes();
    log.warning('HolidayCheck API request failed. Reviewing API_DISCOVERY.md before retrying.', {
        destinationId: context.destinationId,
        travelkind: context.travelkind,
        error: error.message,
        notes_excerpt: notes.split('\n').slice(0, 8).join(' ').slice(0, 280),
    });

    try {
        const proxyUrl = proxyConfiguration ? await proxyConfiguration.newUrl() : undefined;
        const response = await gotScraping.post(HOTELS_WITH_OFFER_ENDPOINT, {
            proxyUrl,
            headers: {
                ...DEFAULT_HEADERS,
                referer: context.listingUrl,
            },
            json: payload,
            timeout: { request: 30000 },
            retry: { limit: 0 },
        });

        return {
            statusCode: response.statusCode,
            bodyPreview: response.body.slice(0, 300),
        };
    } catch (diagnosticError) {
        return {
            diagnosticError: diagnosticError.message,
        };
    }
}

async function fetchHotelsPageWithRecovery(context, offset, limit, proxyConfiguration) {
    const payload = buildHotelsWithOfferPayload(context, offset, limit);

    try {
        const data = await fetchHotelsPage(context, offset, limit, proxyConfiguration);
        if (offset === 0 && (!Array.isArray(data.items) || data.items.length === 0)) {
            throw new Error('HolidayCheck API returned no items on the first page');
        }

        return { data, context };
    } catch (error) {
        const diagnostic = await diagnoseApiFailure(context, payload, proxyConfiguration, error);
        log.warning('HolidayCheck API diagnostic result', {
            destinationId: context.destinationId,
            travelkind: context.travelkind,
            diagnostic,
        });

        const refreshedContext = await refreshContext(context, proxyConfiguration);
        const retriedData = await fetchHotelsPage(refreshedContext, offset, limit, proxyConfiguration);
        return { data: retriedData, context: refreshedContext };
    }
}

function slugifyHotelName(name) {
    return String(name || '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .replace(/-{2,}/g, '-');
}

function buildHotelUrl(name, id) {
    return `${HOLIDAYCHECK_ORIGIN}/hi/${slugifyHotelName(name)}/${id}`;
}

function roundNumber(value, digits = 4) {
    if (typeof value !== 'number' || Number.isNaN(value)) return value;
    return Number(value.toFixed(digits));
}

function mapParent(parent) {
    return cleanObject({
        id: parent.id,
        name: parent.name,
        destination_type: parent.destinationType,
        path_de: parent.pagePaths?.de,
        path_at: parent.pagePaths?.at,
        path_ch: parent.pagePaths?.ch,
    });
}

function mapFingerprints(fingerprints) {
    if (!fingerprints || typeof fingerprints !== 'object') return undefined;

    const mapped = Object.entries(fingerprints).map(([key, value]) => cleanObject({
        key,
        score: roundNumber(value?.score),
        tag: value?.tag,
        filter: value?.filter,
    }));

    return mapped.length ? mapped : undefined;
}

function summarizeFingerprints(fingerprints) {
    const mapped = mapFingerprints(fingerprints);
    if (!mapped?.length) return {};

    return cleanObject({
        fingerprint_tags: mapped.filter((fingerprint) => fingerprint.tag).map((fingerprint) => fingerprint.key),
        fingerprint_filters: mapped.filter((fingerprint) => fingerprint.filter).map((fingerprint) => fingerprint.key),
        fingerprint_scores: Object.fromEntries(
            mapped
                .filter((fingerprint) => typeof fingerprint.score === 'number' && fingerprint.score > 0)
                .map((fingerprint) => [fingerprint.key.toLowerCase(), fingerprint.score]),
        ),
    });
}

function mapRoomAttributes(attributes) {
    if (!Array.isArray(attributes)) return undefined;
    const mapped = attributes
        .map((attribute) => cleanObject({
            category: attribute.category,
            code: attribute.code,
            value: attribute.value,
            paid: attribute.paid,
            on_request: attribute.onRequest,
        }))
        .filter(Boolean);

    return mapped.length ? mapped : undefined;
}

function mapOffer(offer, travelkind) {
    if (!offer || typeof offer !== 'object') return undefined;

    return cleanObject({
        type: offer.type || travelkind,
        provider_id: offer.providerId,
        offer_id: offer.offerId,
        hotel_id: offer.hotelId,
        price_per_person: offer.pricePerPerson?.amount ?? offer.offerPrice?.price,
        total_price: offer.totalPrice?.amount ?? offer.availabilityInformation?.totalPrice?.price,
        currency: offer.pricePerPerson?.currency ?? offer.offerPrice?.currency ?? offer.totalPrice?.currency,
        original_price_per_person: offer.pricePerPerson?.original?.amount ?? offer.offerPrice?.originalPrice,
        start_date: offer.startDate ? `${offer.startDate.year}-${String(offer.startDate.monthOfYear).padStart(2, '0')}-${String(offer.startDate.dayOfMonth).padStart(2, '0')}` : undefined,
        end_date: offer.endDate ? `${offer.endDate.year}-${String(offer.endDate.monthOfYear).padStart(2, '0')}-${String(offer.endDate.dayOfMonth).padStart(2, '0')}` : undefined,
        stay_duration: offer.stayDuration,
        travel_duration_days: offer.travelDurationDays ?? offer.duration,
        room_name: offer.room?.name,
        room_description: offer.room?.description,
        room_booking_code: offer.room?.bookingCode,
        room_attributes: mapRoomAttributes(offer.room?.attributes),
        meal_type: offer.mealType || offer.meal,
        transfer: offer.transfer,
        direct_flight: offer.directFlight,
        departure_airport: offer.departureAirPort?.code,
        destination_airport: offer.destinationAirPort?.code,
        tour_operator_id: offer.tourOperator?.id || offer.tourOperatorId,
        deal_kind: offer.deal?.kind,
        deal_method: offer.deal?.method,
        deal_relative_difference: offer.deal?.relativeDifference,
        deal_absolute_difference: offer.deal?.absoluteDifference,
        cashback_labels: Array.isArray(offer.specials)
            ? offer.specials
                .flatMap((special) => toArray(special.specialTexts))
                .filter((text) => text?.key === 'label' && text?.text)
                .map((text) => text.text)
            : undefined,
        travellers: Array.isArray(offer.travellers)
            ? offer.travellers.map((traveller) => cleanObject({
                traveller_ref_id: traveller.travellerRefId,
                age: traveller.age,
                person_type: traveller.personType,
            }))
            : undefined,
        flights: offer.flightInfo ? cleanObject({
            outbound: toArray(offer.flightInfo.outBound).map((flight) => cleanObject({
                departure_airport: flight.departureAirport?.code,
                arrival_airport: flight.arrivalAirport?.code,
                departure_iso: flight.departureDateTimeISO,
                arrival_iso: flight.arrivalDateTimeISO,
                carrier_code: flight.carrierCode,
                carrier_name: flight.carrierName,
                flight_number: flight.flightNumber,
                duration_minutes: flight.flightDuration,
                cabin_class: flight.cabinClass,
            })),
            inbound: toArray(offer.flightInfo.inBound).map((flight) => cleanObject({
                departure_airport: flight.departureAirport?.code,
                arrival_airport: flight.arrivalAirport?.code,
                departure_iso: flight.departureDateTimeISO,
                arrival_iso: flight.arrivalDateTimeISO,
                carrier_code: flight.carrierCode,
                carrier_name: flight.carrierName,
                flight_number: flight.flightNumber,
                duration_minutes: flight.flightDuration,
                cabin_class: flight.cabinClass,
            })),
        }) : undefined,
    });
}

function cleanObject(value) {
    if (Array.isArray(value)) {
        const cleanedArray = value
            .map((item) => cleanObject(item))
            .filter((item) => item !== undefined);
        const seen = new Set();
        const deduped = cleanedArray.filter((item) => {
            const key = typeof item === 'object' ? JSON.stringify(item) : String(item);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        return deduped.length ? deduped : undefined;
    }

    if (value && typeof value === 'object') {
        const cleanedEntries = Object.entries(value)
            .map(([key, itemValue]) => [key, cleanObject(itemValue)])
            .filter(([, itemValue]) => itemValue !== undefined);

        return cleanedEntries.length ? Object.fromEntries(cleanedEntries) : undefined;
    }

    if (value === null || value === undefined || value === '') {
        return undefined;
    }

    return value;
}

function mapHotel(item, context, position) {
    const review = cleanObject({
        rating: roundNumber(item.reviewCalculations?.overall?.rating),
        recommendation_rate: roundNumber(item.reviewCalculations?.overall?.recommendation),
        ranking: roundNumber(item.reviewCalculations?.overall?.ranking),
        trend: roundNumber(item.reviewCalculations?.overall?.trend),
        count_unarchived: item.reviewCalculations?.overall?.countUnarchived,
        count_archived: item.reviewCalculations?.overall?.countArchived,
        per_traveled_with: item.reviewCalculations?.perTraveledWith,
        unique_selling_points: item.reviewCalculations?.uniqueSellingPoints,
    });
    const offer = mapOffer(item.offer, context.travelkind);
    const fingerprintSummary = summarizeFingerprints(item.fingerprints);

    return cleanObject({
        id: item.id,
        name: item.name,
        hotel_url: buildHotelUrl(item.name, item.id),
        stars: item.stars,
        stars_source: item.starsSource,
        destination_id: context.destinationId,
        destination_name: context.destinationName,
        destination_type: context.destinationType,
        destination_page_path: context.destinationPagePath,
        listing_url: context.listingUrl,
        source_url: context.landingUrl,
        locale: context.locale,
        travelkind: context.travelkind,
        position,
        review_rating: review?.rating,
        review_recommendation_rate: review?.recommendation_rate,
        offer_price_per_person: offer?.price_per_person,
        offer_currency: offer?.currency,
        ...fingerprintSummary,
        coordinates: item.geo?.coordinates ? cleanObject({
            longitude: item.geo.coordinates[0],
            latitude: item.geo.coordinates[1],
        }) : undefined,
        parents: Array.isArray(item.parents) ? item.parents.map(mapParent) : undefined,
        review,
        latest_award: cleanObject({
            id: item.latestAward?.id,
            category: item.latestAward?.category,
            year: item.latestAward?.year,
        }),
        campaigns: item.campaigns,
        should_index: item.shouldIndex,
        offer,
    });
}

export async function scrapeUrls(input, options = {}) {
    const {
        proxyConfiguration,
        requestDelayMs = 250,
        onBatch,
    } = options;

    const inputUrls = normalizeInputUrls(input);
    if (!inputUrls.length) {
        throw new Error('Missing input. Provide at least one HolidayCheck URL in "urls".');
    }

    const resultsWanted = Number.isFinite(Number(input.results_wanted))
        ? Math.max(1, Number(input.results_wanted))
        : DEFAULT_RESULTS_WANTED;
    const maxPages = Number.isFinite(Number(input.max_pages))
        ? Math.max(1, Number(input.max_pages))
        : DEFAULT_MAX_PAGES;

    const allItems = [];
    const seenIds = new Set();

    for (const sourceUrl of inputUrls) {
        if (allItems.length >= resultsWanted) break;

        log.debug('Preparing HolidayCheck source', {
            source_kind: getUrlKind(sourceUrl),
        });
        const { listingUrl, landingUrl, resolution } = await resolveListingUrl(sourceUrl, proxyConfiguration);
        const listingHtml = await fetchText(listingUrl, proxyConfiguration);
        const { stores } = getStoresFromHtml(listingHtml);
        let context = buildContextFromStores(listingUrl, landingUrl, stores);

        log.info('Scraping HolidayCheck destination', {
            source_kind: getUrlKind(sourceUrl),
            travelkind: context.travelkind,
            destinationName: context.destinationName,
            resolution,
        });

        for (let page = 0; page < maxPages; page++) {
            if (allItems.length >= resultsWanted) break;

            const offset = page * PAGE_SIZE;
            const limit = Math.min(PAGE_SIZE, resultsWanted - allItems.length);
            const pageResult = await fetchHotelsPageWithRecovery(context, offset, limit, proxyConfiguration);
            context = pageResult.context;
            const pageData = pageResult.data;
            const items = pageData.items || [];

            if (!items.length) break;

            const batch = [];
            for (const item of items) {
                if (seenIds.has(item.id)) continue;
                seenIds.add(item.id);
                const mappedHotel = mapHotel(item, context, allItems.length + 1);
                allItems.push(mappedHotel);
                batch.push(mappedHotel);
                if (allItems.length >= resultsWanted) break;
            }

            if (batch.length && onBatch) {
                await onBatch(batch, {
                    page: page + 1,
                    totalSaved: allItems.length,
                    destinationId: context.destinationId,
                    destinationName: context.destinationName,
                    travelkind: context.travelkind,
                });
            }

            log.debug('Processed HolidayCheck result page', {
                page: page + 1,
                saved_in_page: batch.length,
                total_saved: allItems.length,
                travelkind: context.travelkind,
            });

            const reachedLastPage = offset + items.length >= (pageData.total || 0);
            if (reachedLastPage || items.length < PAGE_SIZE) break;
            await wait(requestDelayMs);
        }
    }

    return allItems.slice(0, resultsWanted);
}

async function loadRuntimeInput() {
    const actorInput = (await Actor.getInput()) || {};
    if (normalizeInputUrls(actorInput).length || Actor.isAtHome()) {
        return actorInput;
    }

    try {
        const localInput = JSON.parse(await readFile(new URL('../INPUT.json', import.meta.url), 'utf8'));
        log.info('Using local INPUT.json fallback for development run');
        return localInput;
    } catch {
        return actorInput;
    }
}

async function run() {
    const input = await loadRuntimeInput();
    const proxyConfiguration = input.proxyConfiguration
        ? await Actor.createProxyConfiguration(input.proxyConfiguration)
        : undefined;

    const items = await scrapeUrls(input, {
        proxyConfiguration,
        onBatch: async (batch) => {
            await Actor.pushData(batch);
        },
    });

    if (!items.length) {
        throw new Error('No HolidayCheck hotels were extracted. Check the input URL or search dates.');
    }

    log.info('Finished HolidayCheck extraction', {
        total_saved: items.length,
    });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    await Actor.main(run);
}
