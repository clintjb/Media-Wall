/*
 * ------------------------------------------------------------
 * Status checks: Portainer container health, cron-job.org job
 * history, and simple network ping checks.
 *
 * Each function here returns a small flat JSON object designed
 * to be consumed by Homepage's `customapi` widget, one field per
 * value shown on the card. See README.md for the matching
 * services.yaml snippets.
 * ------------------------------------------------------------
 */

const { execFile } = require("child_process");

/*
 * ------------------------------------------------------------
 * Portainer — container health
 *
 * Reports how many containers (in a given Portainer "endpoint" /
 * environment) are running, unhealthy, or stopped, plus a top
 * level "ok" / "issues" summary and a short list of the
 * problem containers.
 * ------------------------------------------------------------
 */

const PORTAINER_URL = (process.env.PORTAINER_URL || "").replace(/\/+$/, "");
const PORTAINER_API_KEY = process.env.PORTAINER_API_KEY || "";
const PORTAINER_ENDPOINT_ID = process.env.PORTAINER_ENDPOINT_ID || "1";
const PORTAINER_ENABLED = Boolean(PORTAINER_URL && PORTAINER_API_KEY);

async function fetchPortainerContainers() {
    const url =
        `${PORTAINER_URL}/api/endpoints/${PORTAINER_ENDPOINT_ID}` +
        `/docker/containers/json?all=true`;

    const response = await fetch(url, {
        headers: {
            "X-API-Key": PORTAINER_API_KEY,
            "Accept": "application/json"
        }
    });

    if (!response.ok) {
        let body = "";
        try {
            body = await response.text();
        } catch (_) {
            // ignore
        }
        throw new Error(
            `Portainer returned ${response.status}. Body: ${body.slice(0, 300)}`
        );
    }

    return response.json();
}

// Docker's container "Status" string looks like:
//   "Up 2 hours (healthy)"
//   "Up 5 minutes (unhealthy)"
//   "Up 3 days"                <- no healthcheck defined, but running
//   "Exited (1) 2 hours ago"
function classifyContainer(container) {
    const state = (container.State || "").toLowerCase();
    const status = container.Status || "";
    const name = (container.Names && container.Names[0]) || container.Id;

    if (/\(unhealthy\)/i.test(status)) {
        return { name, bucket: "unhealthy" };
    }

    if (state === "running") {
        return { name, bucket: "running" };
    }

    if (state === "restarting") {
        return { name, bucket: "restarting" };
    }

    // exited, dead, paused, created, removing, etc.
    return { name, bucket: "stopped" };
}

async function getPortainerStatus() {
    if (!PORTAINER_ENABLED) {
        return {
            enabled: false,
            summary: "Not configured",
            running: 0,
            unhealthy: 0,
            stopped: 0,
            total: 0,
            issues: ""
        };
    }

    let containers;

    try {
        containers = await fetchPortainerContainers();
    } catch (error) {
        console.error("Portainer status check failed:", error.message);
        return {
            enabled: true,
            summary: "Error",
            running: 0,
            unhealthy: 0,
            stopped: 0,
            total: 0,
            issues: error.message.slice(0, 200)
        };
    }

    const buckets = { running: [], unhealthy: [], restarting: [], stopped: [] };

    for (const container of containers) {
        const { name, bucket } = classifyContainer(container);
        buckets[bucket].push(
            typeof name === "string" ? name.replace(/^\//, "") : name
        );
    }

    const problemNames = [
        ...buckets.unhealthy,
        ...buckets.restarting,
        ...buckets.stopped
    ];

    const hasIssues = problemNames.length > 0;

    return {
        enabled: true,
        summary: hasIssues ? "Issues found" : "All healthy",
        running: buckets.running.length,
        unhealthy: buckets.unhealthy.length + buckets.restarting.length,
        stopped: buckets.stopped.length,
        total: containers.length,
        issues: hasIssues ? problemNames.slice(0, 5).join(", ") : "None"
    };
}

/*
 * ------------------------------------------------------------
 * cron-job.org — last N runs across all jobs
 *
 * Reports whether the most recent executions (across every job
 * in the account, or a specific job if CRONJOB_JOB_ID is set)
 * succeeded, plus which ones failed.
 * ------------------------------------------------------------
 */

const CRONJOB_API_KEY = process.env.CRONJOB_API_KEY || "";
const CRONJOB_JOB_ID = process.env.CRONJOB_JOB_ID || ""; // optional: single job
const CRONJOB_LOOKBACK = Math.max(
    1,
    parseInt(process.env.CRONJOB_LOOKBACK || "5", 10) || 5
);
const CRONJOB_ENABLED = Boolean(CRONJOB_API_KEY);

const CRONJOB_BASE_URL = "https://api.cron-job.org";

function cronjobHeaders() {
    return {
        "Authorization": `Bearer ${CRONJOB_API_KEY}`,
        "Content-Type": "application/json"
    };
}

async function cronjobRequest(endpoint) {
    const response = await fetch(`${CRONJOB_BASE_URL}${endpoint}`, {
        headers: cronjobHeaders()
    });

    if (!response.ok) {
        let body = "";
        try {
            body = await response.text();
        } catch (_) {
            // ignore
        }
        throw new Error(
            `cron-job.org returned ${response.status}. Body: ${body.slice(0, 300)}`
        );
    }

    return response.json();
}

// JobStatus: 1 = OK, everything else (2-9) is a failure of some kind.
function isFailureStatus(status) {
    return typeof status === "number" && status !== 0 && status !== 1;
}

async function getCronjobStatus() {
    if (!CRONJOB_ENABLED) {
        return {
            enabled: false,
            summary: "Not configured",
            checked: 0,
            failed: 0,
            lastRun: "",
            issues: ""
        };
    }

    try {
        let jobIds = [];
        let jobsData = { jobs: [] };

        if (CRONJOB_JOB_ID) {
            jobIds = [CRONJOB_JOB_ID];
        } else {
            jobsData = await cronjobRequest("/jobs");
            jobIds = (jobsData.jobs || []).map(job => job.jobId);
        }

        if (jobIds.length === 0) {
            return {
                enabled: true,
                summary: "No jobs found",
                checked: 0,
                failed: 0,
                lastRun: "",
                issues: ""
            };
        }

        // Tag entries with the job's title so failures are identifiable.
        const titleById = {};
        if (!CRONJOB_JOB_ID) {
            for (const job of jobsData.jobs || []) {
                titleById[job.jobId] = job.title || `Job ${job.jobId}`;
            }
        }

        const histories = await Promise.allSettled(
            jobIds.map(id => cronjobRequest(`/jobs/${id}/history`))
        );

        let allEntries = [];

        histories.forEach((result, index) => {
            if (result.status !== "fulfilled") {
                return;
            }
            const jobId = jobIds[index];
            const title = titleById[jobId] || `Job ${jobId}`;
            const items = (result.value.history || []).map(item => ({
                title,
                date: item.date,
                status: item.status,
                statusText: item.statusText
            }));
            allEntries = allEntries.concat(items);
        });

        // Most recent first, then take the last N overall.
        allEntries.sort((a, b) => b.date - a.date);
        const recent = allEntries.slice(0, CRONJOB_LOOKBACK);

        const failed = recent.filter(entry => isFailureStatus(entry.status));

        const lastRunDate = recent.length
            ? new Date(recent[0].date * 1000).toISOString()
            : "";

        return {
            enabled: true,
            summary: failed.length ? "Issues found" : "All OK",
            checked: recent.length,
            failed: failed.length,
            lastRun: lastRunDate,
            issues: failed.length
                ? failed
                    .map(f => `${f.title}: ${f.statusText}`)
                    .slice(0, 5)
                    .join(", ")
                : "None"
        };

    } catch (error) {
        console.error("cron-job.org status check failed:", error.message);
        return {
            enabled: true,
            summary: "Error",
            checked: 0,
            failed: 0,
            lastRun: "",
            issues: error.message.slice(0, 200)
        };
    }
}

/*
 * ------------------------------------------------------------
 * Wifi points — simple ICMP ping checks
 *
 * Reports up/down for each configured host. Configure via
 * WIFI_POINTS as a comma separated list of name=host pairs, e.g.
 *   WIFI_POINTS=Lounge=192.168.178.112,Office=192.168.178.113
 * ------------------------------------------------------------
 */

function parseWifiPoints() {
    const raw = process.env.WIFI_POINTS || "";

    return raw
        .split(",")
        .map(pair => pair.trim())
        .filter(Boolean)
        .map(pair => {
            const [name, host] = pair.split("=").map(s => (s || "").trim());
            return { name: name || host, host };
        })
        .filter(entry => entry.host);
}

const WIFI_POINTS = parseWifiPoints();
const WIFI_ENABLED = WIFI_POINTS.length > 0;

function pingHost(host, timeoutSeconds = 2) {
    return new Promise(resolve => {
        // -c 1: one packet, -W: timeout in seconds (Linux/iputils syntax,
        // matches the node:22-alpine base image's busybox ping as well).
        execFile(
            "ping",
            ["-c", "1", "-W", String(timeoutSeconds), host],
            (error) => {
                resolve(!error);
            }
        );
    });
}

async function getWifiStatus() {
    if (!WIFI_ENABLED) {
        return {
            enabled: false,
            summary: "Not configured",
            up: 0,
            down: 0,
            total: 0,
            issues: ""
        };
    }

    const results = await Promise.all(
        WIFI_POINTS.map(async point => ({
            name: point.name,
            up: await pingHost(point.host)
        }))
    );

    const down = results.filter(r => !r.up);

    return {
        enabled: true,
        summary: down.length ? "Issues found" : "All up",
        up: results.length - down.length,
        down: down.length,
        total: results.length,
        issues: down.length ? down.map(r => r.name).join(", ") : "None"
    };
}

module.exports = {
    getPortainerStatus,
    getCronjobStatus,
    getWifiStatus,
    PORTAINER_ENABLED,
    CRONJOB_ENABLED,
    WIFI_ENABLED
};
