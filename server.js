javascript
const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = 3000;
const PHOTOS_DIR = process.env.PHOTOS_DIR || "/photos";

const JELLYFIN_URL = process.env.JELLYFIN_URL;
const JELLYFIN_API_KEY = process.env.JELLYFIN_API_KEY;

if (!JELLYFIN_URL || !JELLYFIN_API_KEY) {
    console.error("Missing JELLYFIN_URL or JELLYFIN_API_KEY");
    process.exit(1);
}

app.use(express.json());

/*
 * ------------------------------------------------------------
 * Static frontend
 * ------------------------------------------------------------
 */

app.use(express.static(path.join(__dirname, "public")));

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

async function jellyfinRequest(endpoint) {
    const response = await fetch(
        `${JELLYFIN_URL}${endpoint}`,
        {
            headers: {
                "X-Emby-Token": JELLYFIN_API_KEY,
                "Accept": "application/json"
            }
        }
    );

    if (!response.ok) {
        throw new Error(
            `Jellyfin returned ${response.status}`
        );
    }

    return response.json();
}

app.get("/api/movies", async (req, res) => {
    try {
        const params = new URLSearchParams({
            IncludeItemTypes: "Movie",
            Recursive: "true",
            SortBy: "DateCreated",
            SortOrder: "Descending",
            Limit: "10",
            Fields: "PrimaryImageAspectRatio,ProductionYear,Overview"
        });

        const data = await jellyfinRequest(
            `/Items?${params.toString()}`
        );

        const movies = (data.Items || []).map(movie => ({
            id: movie.Id,
            name: movie.Name,
            year: movie.ProductionYear || null,
            overview: movie.Overview || "",
            image: `/jellyfin-image/${movie.Id}`
        }));

        res.json({
            count: movies.length,
            movies
        });

    } catch (error) {
        console.error("Jellyfin error:", error);

        res.status(502).json({
            error: "Unable to retrieve movies from Jellyfin"
        });
    }
});

/*
 * Proxy Jellyfin artwork so the API key never reaches
 * the browser.
 */

app.get("/jellyfin-image/:id", async (req, res) => {
    try {
        const response = await fetch(
            `${JELLYFIN_URL}/Items/${req.params.id}/Images/Primary`,
            {
                headers: {
                    "X-Emby-Token": JELLYFIN_API_KEY
                }
            }
        );

        if (!response.ok) {
            return res.sendStatus(response.status);
        }

        res.setHeader(
            "Content-Type",
            response.headers.get("content-type") ||
            "image/jpeg"
        );

        const buffer = Buffer.from(
            await response.arrayBuffer()
        );

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
    console.log(
        `Media Wall listening on port ${PORT}`
    );
});
