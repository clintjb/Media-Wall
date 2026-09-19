const express = require("express");
const fs = require("fs");
const path = require("path");
const {
    getPortainerStatus,
    getCronjobStatus,
    getWifiStatus
} = require("./status");

const app = express();

const PORT = process.env.PORT || 3000;
const PHOTOS_DIR = process.env.PHOTOS_DIR || "/photos";

/*
 * ------------------------------------------------------------
 * Configuration
 *
 * Jellyfin and Jellyseerr/Overseerr are both optional, but at
 * least one media source (Jellyfin or Seerr) is recommended so
 * the "now showing" slide has something to display. Photos work
 * standalone regardless.
 * ------------------------------------------------------------
 */

const JELLYFIN_URL = process.env.JELLYFIN_URL || "";
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY || "";
const JELLYFIN_ENABLED = Boolean(JELLYFIN_URL && JELLYFIN_API_KEY);

// Works with either Jellyseerr or Overseerr - same API shape.
const SEERR_URL = process.env.SEERR_URL || "";
const SEERR_API_KEY = process.env.SEERR_API_KEY || "";
const SEERR_ENABLED = Boolean(SEERR_URL && SEERR_API_KEY);

// How many photo slides appear before a movie slide is inserted.
const MOVIE_EVERY = Math.max(
    1,
    parseInt(process.env.MOVIE_EVERY || "5", 10) || 5
);

// Where movie data comes from when both are configured:
// "jellyfin", "seerr", or "both" (interleaved).
const MOVIE_SOURCE = (process.env.MOVIE_SOURCE || "both").toLowerCase();

if (!JELLYFIN_ENABLED && !SEERR_ENABLED) {
    console.warn(
        "Neither Jellyfin nor Seerr (Jellyseerr/Overseerr) is configured. " +
        "Media Wall will run in photos-only mode."
    );
}

console.log(
    `Media Wall starting. Jellyfin: ${JELLYFIN_ENABLED ? "enabled" : "disabled"}, ` +
    `Seerr: ${SEERR_ENABLED ? "enabled" : "disabled"}, ` +
    `movieEvery: ${MOVIE_EVERY}, movieSource: ${MOVIE_SOURCE}`
);

app.use(express.json());

/*
 * ------------------------------------------------------------
 * Static frontend
 * ------------------------------------------------------------
 */

app.use(express.static(path.join(__dirname, "public")));

/*
 * ------------------------------------------------------------
 * Config endpoint - lets the frontend know what's available
 * and how often to insert a movie slide, without hardcoding it.
 * ------------------------------------------------------------
 */

app.get("/api/config", (req, res) => {
    res.json({
        movieEvery: MOVIE_EVERY,
        jellyfinEnabled: JELLYFIN_ENABLED,
        seerrEnabled: SEERR_ENABLED
    });
});

/*
 * ------------------------------------------------------------
 * Photos
 * ------------------------------------------------------------
 */

const PHOTO_EXTENSIONS = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".webp"
]);

function findPhotos(directory, base = "") {
    let results = [];

    let entries;

    try {
        entries = fs.readdirSync(directory, {
            withFileTypes: true
        });
    } catch (error) {
        console.error("Unable to read photo directory:", error);
        return [];
    }

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        const relativePath = path.join(base, entry.name);

        if (entry.isDirectory()) {
            results = results.concat(
                findPhotos(fullPath, relativePath)
            );

            continue;
        }

        const extension = path.extname(entry.name).toLowerCase();

        if (PHOTO_EXTENSIONS.has(extension)) {
            results.push(
                relativePath
                    .split(path.sep)
                    .map(encodeURIComponent)
                    .join("/")
            );
        }
    }

    return results;
}

app.get("/api/photos", (req, res) => {
    const photos = findPhotos(PHOTOS_DIR);

    // Randomise the starting order.
    for (let i = photos.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [photos[i], photos[j]] = [photos[j], photos[i]];
    }

    res.json({
        count: photos.length,
        photos
    });
});

app.use(
    "/photos",
    express.static(PHOTOS_DIR, {
        maxAge: "1h"
    })
);

/*
 * ------------------------------------------------------------
 * Jellyfin
 * ------------------------------------------------------------
 */

const JELLYFIN_BASE_URL = JELLYFIN_URL.replace(/\/+$/, "");

function jellyfinHeaders() {
    return {
        "Authorization":
            `MediaBrowser Client="Media Wall", Device="Media Wall", ` +
            `DeviceId="media-wall", Version="1.0.0", Token="${JELLYFIN_API_KEY}"`,
        "Accept": "application/json"
    };
}

async function jellyfinRequest(endpoint) {
    const url = `${JELLYFIN_BASE_URL}${endpoint}`;

    let response;

    try {
        response = await fetch(url, { headers: jellyfinHeaders() });
    } catch (error) {
        console.error(
            `Jellyfin request failed (network error) for ${url}:`,
            error.message
        );
        throw new Error(`Unable to reach Jellyfin at ${url}: ${error.message}`);
    }

    if (!response.ok) {
        let body = "";

        try {
            body = await response.text();
        } catch (_) {
            // ignore
        }

        console.error(
            `Jellyfin returned ${response.status} for ${url}. Body: ${body.slice(0, 500)}`
        );

        throw new Error(`Jellyfin returned ${response.status}`);
    }

    return response.json();
}

function formatRuntime(ticks) {
    if (!ticks) {
        return null;
    }

    const totalMinutes = Math.round(ticks / 10000 / 1000 / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours <= 0) {
        return `${minutes}m`;
    }

    return `${hours}h ${minutes}m`;
}

async function fetchJellyfinMovies() {
    const params = new URLSearchParams({
        IncludeItemTypes: "Movie",
        Recursive: "true",
        SortBy: "DateCreated",
        SortOrder: "Descending",
        Limit: "24",
        Fields: "PrimaryImageAspectRatio,ProductionYear,Overview,CommunityRating,OfficialRating,RunTimeTicks,Genres,BackdropImageTags"
    });

    const data = await jellyfinRequest(`/Items?${params.toString()}`);

    return (data.Items || []).map(movie => ({
        source: "jellyfin",
        id: movie.Id,
        name: movie.Name,
        year: movie.ProductionYear || null,
        overview: movie.Overview || "",
        rating: movie.CommunityRating || null,
        officialRating: movie.OfficialRating || null,
        runtime: formatRuntime(movie.RunTimeTicks),
        genres: movie.Genres || [],
        poster: `/api/image/jellyfin/${movie.Id}/poster`,
        backdrop:
            movie.BackdropImageTags && movie.BackdropImageTags.length
                ? `/api/image/jellyfin/${movie.Id}/backdrop`
                : `/api/image/jellyfin/${movie.Id}/poster`,
        status: "New On Birdflix"
    }));
}

/*
 * ------------------------------------------------------------
 * Jellyseerr / Overseerr
 *
 * Both projects share the same REST API shape (Overseerr's API
 * was forked into Jellyseerr), so one integration covers both.
 * ------------------------------------------------------------
 */

const SEERR_BASE_URL = SEERR_URL.replace(/\/+$/, "");

function seerrHeaders() {
    return {
        "X-Api-Key": SEERR_API_KEY,
        "Accept": "application/json"
    };
}

async function seerrRequest(endpoint) {
    const url = `${SEERR_BASE_URL}/api/v1${endpoint}`;

    let response;

    try {
        response = await fetch(url, { headers: seerrHeaders() });
    } catch (error) {
        console.error(
            `Seerr request failed (network error) for ${url}:`,
            error.message
        );
        throw new Error(`Unable to reach Seerr at ${url}: ${error.message}`);
    }

    if (!response.ok) {
        let body = "";

        try {
            body = await response.text();
        } catch (_) {
            // ignore
        }

        console.error(
            `Seerr returned ${response.status} for ${url}. Body: ${body.slice(0, 500)}`
        );

        throw new Error(`Seerr returned ${response.status}`);
    }

    return response.json();
}

const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p";

async function fetchSeerrMovies() {
    // Recently requested titles first, this is the "what's coming"
    // feel; fall back to trending if there aren't many requests yet.
    const [requestsData, trendingData] = await Promise.allSettled([
        seerrRequest("/request?take=20&filter=all&sort=added"),
        seerrRequest("/discover/trending?page=1")
    ]);

    const items = [];
    const seenTmdbIds = new Set();

    if (requestsData.status === "fulfilled") {
        const results = requestsData.value.results || [];

        for (const request of results) {
            const media = request.media;

            if (!media || media.mediaType !== "movie") {
                continue;
            }

            const tmdbId = media.tmdbId;

            if (!tmdbId || seenTmdbIds.has(tmdbId)) {
                continue;
            }

            seenTmdbIds.add(tmdbId);

            items.push({
                tmdbId,
                statusLabel: seerrStatusLabel(media.status),
                requestedAt: request.createdAt || null
            });
        }
    }

    if (trendingData.status === "fulfilled") {
        const results = trendingData.value.results || [];

        for (const item of results) {
            if (item.mediaType !== "movie") {
                continue;
            }

            if (seenTmdbIds.has(item.id)) {
                continue;
            }

            seenTmdbIds.add(item.id);

            items.push({
                tmdbId: item.id,
                statusLabel: "Trending",
                trendingPayload: item
            });
        }
    }

    // Resolve full details for request-derived items (trending
    // items already carry enough detail from the discover payload).
    const detailed = await Promise.all(
        items.slice(0, 24).map(async entry => {
            if (entry.trendingPayload) {
                return seerrItemFromTrending(entry.trendingPayload, entry.statusLabel);
            }

            try {
                const detail = await seerrRequest(`/movie/${entry.tmdbId}`);
                return seerrItemFromDetail(detail, entry.statusLabel);
            } catch (error) {
                console.error(
                    `Unable to resolve Seerr movie ${entry.tmdbId}:`,
                    error.message
                );
                return null;
            }
        })
    );

    return detailed.filter(Boolean);
}

function seerrStatusLabel(status) {
    // Overseerr/Jellyseerr media status codes:
    // 1 unknown, 2 pending, 3 processing, 4 partially available, 5 available
    switch (status) {
        case 5:
            return "Available";
        case 4:
            return "Partially available";
        case 3:
            return "Requested \u2014 processing";
        case 2:
            return "Requested";
        default:
            return "Coming soon";
    }
}

function seerrItemFromDetail(detail, statusLabel) {
    return {
        source: "seerr",
        id: `tmdb-${detail.id}`,
        name: detail.title,
        year: detail.releaseDate ? detail.releaseDate.slice(0, 4) : null,
        overview: detail.overview || "",
        rating: detail.voteAverage || null,
        officialRating: null,
        runtime: detail.runtime ? `${detail.runtime}m` : null,
        genres: (detail.genres || []).map(g => g.name),
        poster: detail.posterPath
            ? `${TMDB_IMAGE_BASE}/w780${detail.posterPath}`
            : null,
        backdrop: detail.backdropPath
            ? `${TMDB_IMAGE_BASE}/w1280${detail.backdropPath}`
            : (detail.posterPath ? `${TMDB_IMAGE_BASE}/w780${detail.posterPath}` : null),
        status: statusLabel
    };
}

function seerrItemFromTrending(item, statusLabel) {
    return {
        source: "seerr",
        id: `tmdb-${item.id}`,
        name: item.title,
        year: item.releaseDate ? item.releaseDate.slice(0, 4) : null,
        overview: item.overview || "",
        rating: item.voteAverage || null,
        officialRating: null,
        runtime: null,
        genres: [],
        poster: item.posterPath
            ? `${TMDB_IMAGE_BASE}/w780${item.posterPath}`
            : null,
        backdrop: item.backdropPath
            ? `${TMDB_IMAGE_BASE}/w1280${item.backdropPath}`
            : (item.posterPath ? `${TMDB_IMAGE_BASE}/w780${item.posterPath}` : null),
        status: statusLabel
    };
}

/*
 * ------------------------------------------------------------
 * Combined movies endpoint
 * ------------------------------------------------------------
 */

app.get("/api/movies", async (req, res) => {
    const sourcesToTry = [];

    if (MOVIE_SOURCE === "jellyfin") {
        if (JELLYFIN_ENABLED) sourcesToTry.push("jellyfin");
    } else if (MOVIE_SOURCE === "seerr") {
        if (SEERR_ENABLED) sourcesToTry.push("seerr");
    } else {
        if (JELLYFIN_ENABLED) sourcesToTry.push("jellyfin");
        if (SEERR_ENABLED) sourcesToTry.push("seerr");
    }

    if (sourcesToTry.length === 0) {
        return res.json({ count: 0, movies: [] });
    }

    const results = await Promise.allSettled(
        sourcesToTry.map(source =>
            source === "jellyfin" ? fetchJellyfinMovies() : fetchSeerrMovies()
        )
    );

    let movies = [];

    results.forEach((result, index) => {
        if (result.status === "fulfilled") {
            movies = movies.concat(result.value);
        } else {
            console.error(
                `Failed to load movies from ${sourcesToTry[index]}:`,
                result.reason && result.reason.message
            );
        }
    });

    // Interleave sources so it's not "all Jellyfin, then all Seerr".
    if (sourcesToTry.length > 1) {
        const bySource = {};

        for (const movie of movies) {
            if (!bySource[movie.source]) bySource[movie.source] = [];
            bySource[movie.source].push(movie);
        }

        const interleaved = [];
        const lists = Object.values(bySource);
        let i = 0;

        while (interleaved.length < movies.length) {
            for (const list of lists) {
                if (list[i]) interleaved.push(list[i]);
            }
            i++;
        }

        movies = interleaved;
    }

    res.json({
        count: movies.length,
        movies
    });
});

/*
 * ------------------------------------------------------------
 * Status endpoints
 *
 * Each returns a small flat JSON object intended for Homepage's
 * `customapi` widget. See README.md for matching services.yaml
 * snippets.
 * ------------------------------------------------------------
 */

app.get("/api/status/portainer", async (req, res) => {
    try {
        res.json(await getPortainerStatus());
    } catch (error) {
        console.error("Portainer status endpoint error:", error);
        res.status(502).json({
            enabled: true,
            summary: "Error",
            running: 0,
            unhealthy: 0,
            stopped: 0,
            total: 0,
            issues: "Internal error"
        });
    }
});

// Plain 200/503 endpoint for Homepage's `siteMonitor`, which only
// checks the HTTP status code (2xx = up) and doesn't read JSON
// fields. Returns 200 when every container is healthy/running,
// 503 otherwise (including when Portainer itself is unreachable).
app.get("/api/health/portainer", async (req, res) => {
    try {
        const status = await getPortainerStatus();

        if (!status.enabled) {
            // Not configured - report healthy so it doesn't show as
            // down on a dashboard where this check is optional.
            return res.status(200).send("Portainer check not configured");
        }

        if (status.summary === "All healthy") {
            return res.status(200).send("OK");
        }

        return res.status(503).send(status.issues || status.summary);
    } catch (error) {
        console.error("Portainer health endpoint error:", error);
        res.status(503).send("Internal error");
    }
});

app.get("/api/status/cronjob", async (req, res) => {
    try {
        res.json(await getCronjobStatus());
    } catch (error) {
        console.error("cron-job.org status endpoint error:", error);
        res.status(502).json({
            enabled: true,
            summary: "Error",
            checked: 0,
            failed: 0,
            lastRun: "",
            issues: "Internal error"
        });
    }
});

app.get("/api/status/wifi", async (req, res) => {
    try {
        res.json(await getWifiStatus());
    } catch (error) {
        console.error("Wifi status endpoint error:", error);
        res.status(502).json({
            enabled: true,
            summary: "Error",
            up: 0,
            down: 0,
            total: 0,
            issues: "Internal error"
        });
    }
});

/*
 * ------------------------------------------------------------
 * Image proxying
 *
 * Keeps Jellyfin API keys off the client and gives the frontend
 * one consistent image path scheme regardless of source.
 * ------------------------------------------------------------
 */

app.get("/api/image/jellyfin/:id/:kind", async (req, res) => {
    const { id, kind } = req.params;
    const imageType = kind === "backdrop" ? "Backdrop" : "Primary";

    try {
        const response = await fetch(
            `${JELLYFIN_BASE_URL}/Items/${id}/Images/${imageType}`,
            { headers: jellyfinHeaders() }
        );

        if (!response.ok) {
            console.error(
                `Jellyfin image fetch for ${id} (${imageType}) returned ${response.status}`
            );
            return res.sendStatus(response.status);
        }

        res.setHeader(
            "Content-Type",
            response.headers.get("content-type") || "image/jpeg"
        );
        res.setHeader("Cache-Control", "public, max-age=3600");

        const buffer = Buffer.from(await response.arrayBuffer());
        res.send(buffer);

    } catch (error) {
        console.error("Jellyfin image error:", error);
        res.sendStatus(502);
    }
});

/*
 * ------------------------------------------------------------
 * Start
 * ------------------------------------------------------------
 */

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Media Wall listening on port ${PORT}`);
    if (JELLYFIN_ENABLED) {
        console.log(`Using Jellyfin base URL: ${JELLYFIN_BASE_URL}`);
    }
    if (SEERR_ENABLED) {
        console.log(`Using Seerr base URL: ${SEERR_BASE_URL}`);
    }
    console.log(
        `Status checks - Portainer: ${require("./status").PORTAINER_ENABLED ? "enabled" : "disabled"}, ` +
        `cron-job.org: ${require("./status").CRONJOB_ENABLED ? "enabled" : "disabled"}, ` +
        `Wifi: ${require("./status").WIFI_ENABLED ? "enabled" : "disabled"}`
    );
});
