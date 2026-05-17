const API_BASE = (typeof window !== "undefined" && window.location && window.location.origin && String(window.location.origin).startsWith("http")) ? "" : "http://127.0.0.1:8000";

const PAGE_META = {
    dashboard: { title: "Dashboard", desc: "Overview of uploads and stored assets" },
    upload: { title: "Upload", desc: "Scan for sensitive data, then encrypt and store" },
    assets: { title: "Assets", desc: "Stored encrypted files and integrity hashes" },
    logs: { title: "Audit Logs", desc: "History of all upload attempts" },
    about: { title: "About", desc: "Project overview, modules, and tech stack" },
    architecture: { title: "Architecture", desc: "System design and data flow" },
    policies: { title: "Policies", desc: "Active DLP detection rules" },
    settings: { title: "Settings", desc: "Server configuration (read-only)" },
};

// --- Toast ---
function toast(message, type = "success") {
    const container = document.getElementById("toastContainer");
    if (!container) return;
    const el = document.createElement("div");
    el.className = "toast " + (type === "error" ? "error" : "success");
    el.textContent = message;
    container.appendChild(el);
    setTimeout(() => {
        el.remove();
    }, 3000);
}

// --- Navigation ---
function showPage(page) {
    const links = document.querySelectorAll(".nav-link[data-page]");
    const pages = document.querySelectorAll(".page[data-page]");
    const pageTitle = document.getElementById("pageTitle");
    const pageDesc = document.getElementById("pageDesc");
    const meta = PAGE_META[page] || {};
    pageTitle.textContent = meta.title || page;
    pageDesc.textContent = meta.desc || "";
    links.forEach((l) => l.classList.toggle("active", l.getAttribute("data-page") === page));
    pages.forEach((p) => {
        p.classList.toggle("active", p.getAttribute("data-page") === page);
    });
    if (page === "dashboard") loadStats();
    if (page === "assets") loadAssets();
    if (page === "logs") loadLogs();
    if (page === "policies") loadPolicies();
    if (page === "settings") loadSettings();
}

function initNav() {
    document.querySelectorAll(".nav-link[data-page]").forEach((link) => {
        link.addEventListener("click", (e) => {
            e.preventDefault();
            showPage(link.getAttribute("data-page"));
        });
    });
    document.querySelectorAll("[data-goto]").forEach((btn) => {
        btn.addEventListener("click", () => showPage(btn.getAttribute("data-goto")));
    });
}

// --- Health ---
async function checkHealth() {
    const dot = document.getElementById("healthDot");
    const label = document.getElementById("healthLabel");
    try {
        const r = await fetch(`${API_BASE}/health`, { method: "GET" });
        if (r.ok) {
            dot.className = "health-dot online";
            label.textContent = "Connected";
        } else {
            dot.className = "health-dot offline";
            label.textContent = "Error";
        }
    } catch {
        dot.className = "health-dot offline";
        label.textContent = "Offline";
    }
}

// --- Dashboard stats ---
const CHART_MAX_HEIGHT = 120;

async function loadStats() {
    const els = {
        total: document.getElementById("statTotal"),
        allowed: document.getElementById("statAllowed"),
        blocked: document.getElementById("statBlocked"),
        errors: document.getElementById("statErrors"),
        assets: document.getElementById("statAssets"),
    };
    try {
        const r = await fetch(`${API_BASE}/stats`);
        if (!r.ok) throw new Error();
        const s = await r.json();
        els.total.textContent = s.total_uploads ?? "—";
        els.allowed.textContent = s.allowed ?? "—";
        els.blocked.textContent = s.blocked ?? "—";
        els.errors.textContent = s.errors ?? "—";
        els.assets.textContent = s.stored_assets ?? "—";
        updateChart(s);
    } catch {
        Object.values(els).forEach((el) => { if (el) el.textContent = "—"; });
        updateChart(null);
    }
}

function updateChart(stats) {
    const barAllowed = document.getElementById("barAllowed");
    const barBlocked = document.getElementById("barBlocked");
    const barErrors = document.getElementById("barErrors");
    if (!barAllowed || !barBlocked || !barErrors) return;
    const total = stats && stats.total_uploads > 0 ? stats.total_uploads : 0;
    if (total === 0) {
        barAllowed.style.height = barBlocked.style.height = barErrors.style.height = "8px";
        return;
    }
    const pct = (v) => Math.max(8, Math.round((v / total) * CHART_MAX_HEIGHT));
    barAllowed.style.height = pct(stats.allowed) + "px";
    barBlocked.style.height = pct(stats.blocked) + "px";
    barErrors.style.height = pct(stats.errors) + "px";
}

// --- Upload: Multi-file queue ---
const fileInput = document.getElementById("fileInput");
const fileNameDisplay = document.getElementById("fileNameDisplay");
const dropZone = document.getElementById("dropZone");
const uploadResult = document.getElementById("uploadResult");
const btnUpload = document.getElementById("btnUpload");

// State
let fileQueue = []; // [{file, status, result}]
let isScanning = false;
let scanReport = [];
let batchStartTime = 0;

const ALLOWED_EXTS = new Set([".txt", ".json", ".csv", ".pdf"]);

function extOf(name) {
    const dot = name.lastIndexOf(".");
    return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1048576).toFixed(1) + " MB";
}

function formatMs(ms) {
    return ms >= 1000 ? (ms / 1000).toFixed(2) + "s" : ms + "ms";
}

function addFilesToQueue(files) {
    let added = 0;
    Array.from(files).forEach((f) => {
        if (!ALLOWED_EXTS.has(extOf(f.name))) {
            toast(`Skipped ${f.name} — unsupported type`, "error");
            return;
        }
        const dup = fileQueue.find((q) => q.file.name === f.name && q.file.size === f.size && q.status === "pending");
        if (dup) return;
        fileQueue.push({ file: f, status: "pending", result: null });
        added++;
    });
    if (added > 0) {
        renderQueue();
        document.getElementById("fileQueue").style.display = "block";
        document.getElementById("batchSummary").style.display = "none";
        uploadResult.className = "result";
    }
    updateDropZoneLabel();
}

function updateDropZoneLabel() {
    const pending = fileQueue.filter((i) => i.status === "pending").length;
    if (pending === 0) {
        fileNameDisplay.textContent = "Click or drag files to scan";
        fileNameDisplay.style.color = "";
    } else {
        fileNameDisplay.textContent = pending + " file" + (pending === 1 ? "" : "s") + " ready";
        fileNameDisplay.style.color = "var(--primary)";
    }
}

function renderQueue() {
    const list = document.getElementById("queueList");
    const countEl = document.getElementById("queueCount");
    if (countEl) countEl.textContent = fileQueue.length;

    const ICON = { pending: "○", scanning: "◌", allowed: "✓", blocked: "✗", error: "⚠" };
    const fragment = document.createDocumentFragment();

    fileQueue.forEach((item, idx) => {
        const div = document.createElement("div");
        div.className = "queue-item queue-status-" + item.status;
        div.id = "queue-item-" + idx;

        const icon = ICON[item.status] || "○";
        const sizeStr = formatBytes(item.file.size);
        const risk = item.result && item.result.risk ? item.result.risk : null;
        const riskHtml = risk ? `<span class="risk-badge risk-${risk.toLowerCase()}">${risk}</span>` : "";
        const timeHtml = item.result && item.result.scan_ms != null
            ? `<span class="scan-time">${formatMs(item.result.scan_ms)}</span>` : "";

        let detailHtml = "";
        if (item.status === "blocked" && item.result && item.result.reason) {
            detailHtml = `<div class="queue-detail queue-detail-blocked">Violations: ${escapeHtml(arrayOrString(item.result.reason))}</div>`;
        } else if (item.status === "allowed" && item.result && item.result.file_hash) {
            detailHtml = `<div class="queue-detail queue-detail-allowed">Hash: <code>${escapeHtml(item.result.file_hash.slice(0, 20))}…</code></div>`;
        } else if (item.status === "error" && item.result && item.result.reason) {
            detailHtml = `<div class="queue-detail queue-detail-error">${escapeHtml(arrayOrString(item.result.reason))}</div>`;
        }

        const removeBtn = item.status === "pending"
            ? `<button type="button" class="btn-remove-file" data-idx="${idx}" title="Remove file" aria-label="Remove ${escapeHtml(item.file.name)}">×</button>`
            : "";

        div.innerHTML =
            `<div class="queue-item-row">` +
            `<span class="queue-icon queue-icon-${item.status}" aria-hidden="true">${icon}</span>` +
            `<span class="queue-filename" title="${escapeHtml(item.file.name)}">${escapeHtml(item.file.name)}</span>` +
            `<span class="queue-size">${sizeStr}</span>` +
            riskHtml + timeHtml + removeBtn +
            `</div>` + detailHtml;

        fragment.appendChild(div);
    });

    list.innerHTML = "";
    list.appendChild(fragment);

    list.querySelectorAll(".btn-remove-file").forEach((btn) => {
        btn.addEventListener("click", () => {
            const idx = parseInt(btn.getAttribute("data-idx"), 10);
            fileQueue.splice(idx, 1);
            renderQueue();
            if (!fileQueue.length) {
                document.getElementById("fileQueue").style.display = "none";
            }
            updateDropZoneLabel();
        });
    });
}

function updateProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById("progressCurrent").textContent = done;
    document.getElementById("progressTotal").textContent = total;
    document.getElementById("progressPct").textContent = pct + "%";
    document.getElementById("progressBarFill").style.width = pct + "%";
}

async function scanAllFiles() {
    if (isScanning) return;
    const pending = fileQueue.filter((i) => i.status === "pending");
    if (!pending.length) {
        toast("No pending files to scan", "error");
        return;
    }

    isScanning = true;
    btnUpload.disabled = true;
    scanReport = [];
    batchStartTime = Date.now();
    uploadResult.className = "result";

    document.getElementById("scanProgress").style.display = "block";
    document.getElementById("batchSummary").style.display = "none";
    updateProgress(0, pending.length);

    let done = 0;
    for (const item of pending) {
        item.status = "scanning";
        renderQueue();

        const formData = new FormData();
        formData.append("file", item.file);
        try {
            const response = await fetch(`${API_BASE}/upload`, { method: "POST", body: formData });
            const data = await response.json().catch(() => ({}));

            if (!response.ok) {
                item.status = "error";
                item.result = { status: "ERROR", reason: getErrorMsg(data, response), risk: "MEDIUM", scan_ms: 0 };
            } else if (data.status === "BLOCKED") {
                item.status = "blocked";
                item.result = data;
            } else if (data.status === "ERROR") {
                item.status = "error";
                item.result = data;
            } else {
                item.status = "allowed";
                item.result = data;
            }
        } catch {
            item.status = "error";
            item.result = { status: "ERROR", reason: "Connection error", risk: "MEDIUM", scan_ms: 0 };
        }

        scanReport.push({
            filename: item.file.name,
            size_bytes: item.file.size,
            status: item.result.status,
            risk: item.result.risk || "—",
            violations: item.result.violations || 0,
            reason: item.result.reason || [],
            file_hash: item.result.file_hash || null,
            scan_ms: item.result.scan_ms || 0,
            scanned_at: new Date().toISOString(),
        });

        done++;
        renderQueue();
        updateProgress(done, pending.length);
    }

    isScanning = false;
    btnUpload.disabled = false;
    fileInput.value = "";
    updateDropZoneLabel();
    loadStats();
    loadLogs();
    loadAssets();
    showBatchSummary();
}

function showBatchSummary() {
    const allowed = fileQueue.filter((i) => i.status === "allowed").length;
    const blocked = fileQueue.filter((i) => i.status === "blocked").length;
    const errors = fileQueue.filter((i) => i.status === "error").length;
    const totalMs = Date.now() - batchStartTime;

    document.getElementById("summaryAllowed").textContent = allowed;
    document.getElementById("summaryBlocked").textContent = blocked;
    document.getElementById("summaryError").textContent = errors;
    document.getElementById("summaryTime").textContent = formatMs(totalMs);
    document.getElementById("batchSummary").style.display = "block";
    document.getElementById("scanProgress").style.display = "none";

    if (blocked > 0 || errors > 0) {
        toast(`${blocked} blocked, ${errors} error(s) — check the queue below`, "error");
    } else {
        toast(`All ${allowed} file(s) passed and stored securely`);
    }
}

function downloadReport() {
    if (!scanReport.length) {
        toast("No scan data to export", "error");
        return;
    }
    const report = {
        generated_at: new Date().toISOString(),
        tool: "Cloud DLP System",
        total_files: scanReport.length,
        total_scan_ms: scanReport.reduce((s, r) => s + r.scan_ms, 0),
        summary: {
            allowed: scanReport.filter((r) => r.status === "ALLOWED").length,
            blocked: scanReport.filter((r) => r.status === "BLOCKED").length,
            errors: scanReport.filter((r) => r.status === "ERROR").length,
        },
        results: scanReport,
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cloud_dlp_scan_report_" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Scan report downloaded");
}

// File input / drag-and-drop
fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) addFilesToQueue(e.target.files);
});

["dragenter", "dragover", "dragleave", "drop"].forEach((ev) => {
    dropZone.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); });
});
["dragenter", "dragover"].forEach((ev) => {
    dropZone.addEventListener(ev, () => dropZone.classList.add("dragover"));
});
["dragleave", "drop"].forEach((ev) => {
    dropZone.addEventListener(ev, () => dropZone.classList.remove("dragover"));
});
dropZone.addEventListener("drop", (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) addFilesToQueue(files);
});

btnUpload.addEventListener("click", scanAllFiles);

document.getElementById("clearQueue").addEventListener("click", () => {
    fileQueue = fileQueue.filter((i) => i.status !== "pending");
    renderQueue();
    if (!fileQueue.length) document.getElementById("fileQueue").style.display = "none";
    updateDropZoneLabel();
});

document.getElementById("downloadReport").addEventListener("click", downloadReport);
document.getElementById("scanMore").addEventListener("click", () => {
    fileQueue = [];
    scanReport = [];
    document.getElementById("fileQueue").style.display = "none";
    document.getElementById("batchSummary").style.display = "none";
    document.getElementById("scanProgress").style.display = "none";
    uploadResult.className = "result";
    updateDropZoneLabel();
});

// --- Demo uploads ---
const DEMO_SAFE = "This is a safe document with no sensitive information.\nIt contains project notes and meeting summaries.\nAll content is cleared for storage.";
const DEMO_SENSITIVE = "Contact: john@example.com\nPhone: 9876543210\nPassword: mySecret123\nSSN: 123-45-6789";

function uploadDemo(content, filename) {
    const file = new File([content], filename, { type: "text/plain" });
    addFilesToQueue([file]);
    toast(`Added ${filename} to queue — click Scan to run`);
}

document.getElementById("demoSafe").addEventListener("click", () => uploadDemo(DEMO_SAFE, "demo_safe.txt"));
document.getElementById("demoSensitive").addEventListener("click", () => uploadDemo(DEMO_SENSITIVE, "demo_sensitive.txt"));

// --- Policies ---
async function loadPolicies() {
    const el = document.getElementById("policiesList");
    if (!el) return;
    try {
        const r = await fetch(`${API_BASE}/policies`);
        if (!r.ok) throw new Error();
        const policies = await r.json();
        const names = Object.keys(policies);
        if (names.length === 0) {
            el.innerHTML = "<p class=\"muted\">No policies configured.</p>";
            return;
        }
        el.innerHTML = names.map((name) =>
            "<div class=\"policy-item\"><div class=\"policy-name\">" + escapeHtml(name) + "</div><div class=\"policy-pattern\">" + escapeHtml(policies[name]) + "</div></div>"
        ).join("");
    } catch {
        el.innerHTML = "<p class=\"muted\">Failed to load policies. Is the backend running?</p>";
    }
}
document.getElementById("refreshPolicies").addEventListener("click", () => loadPolicies());

// --- Settings ---
async function loadSettings() {
    const el = document.getElementById("settingsContent");
    if (!el) return;
    try {
        const r = await fetch(`${API_BASE}/config`);
        if (!r.ok) throw new Error();
        const c = await r.json();
        el.innerHTML =
            "<div class=\"settings-row\"><label>Max file size</label><span>" + (c.max_file_size_mb ?? "—") + " MB</span></div>" +
            "<div class=\"settings-row\"><label>Allowed MIME types</label><span>" + escapeHtml((c.allowed_mime_types || []).join(", ")) + "</span></div>" +
            "<div class=\"settings-row\"><label>API version</label><span>" + escapeHtml(c.version || "—") + "</span></div>";
    } catch {
        el.innerHTML = "<p class=\"muted\">Failed to load config.</p>";
    }
}

// --- Footer version ---
async function setFooterVersion() {
    const el = document.getElementById("footerVersion");
    if (!el) return;
    try {
        const r = await fetch(`${API_BASE}/config`);
        if (r.ok) {
            const c = await r.json();
            el.textContent = "v" + (c.version || "—");
        }
    } catch {
        el.textContent = "—";
    }
}

function getErrorMsg(data, response) {
    if (data.detail == null) return response.statusText;
    if (Array.isArray(data.detail.reason)) return data.detail.reason.join(", ");
    if (typeof data.detail.reason === "string") return data.detail.reason;
    if (Array.isArray(data.detail) && data.detail[0]?.msg) return data.detail.map((e) => e.msg).join("; ");
    if (typeof data.detail === "string") return data.detail;
    return response.statusText;
}

function arrayOrString(v) {
    return Array.isArray(v) ? v.join(", ") : String(v ?? "");
}

function escapeHtml(str) {
    if (str == null) return "";
    const div = document.createElement("div");
    div.textContent = String(str);
    return div.innerHTML;
}

// --- Assets ---
let allAssets = [];

async function loadAssets() {
    const tbody = document.getElementById("assetsBody");
    const emptyEl = document.getElementById("assetsEmpty");
    const tableWrap = tbody && tbody.closest(".table-container");
    try {
        const response = await fetch(`${API_BASE}/assets`);
        const assets = await response.json().catch(() => []);
        const list = Array.isArray(assets) ? assets : [];
        allAssets = list;

        if (!response.ok) {
            tbody.innerHTML = '<tr><td colspan="4" class="muted">Failed to load (' + response.status + ")</td></tr>";
            if (emptyEl) emptyEl.style.display = "none";
            if (tableWrap) tableWrap.style.display = "block";
            return;
        }

        renderAssetsFiltered();
    } catch {
        tbody.innerHTML = '<tr><td colspan="4" class="muted">Failed to load assets</td></tr>';
        if (emptyEl) emptyEl.style.display = "none";
    }
}

async function verifyAsset(id) {
    const el = document.getElementById("verify-" + id);
    if (!el) return;
    el.textContent = "…";
    el.className = "verify-result";
    try {
        const response = await fetch(`${API_BASE}/assets/${id}/verify`);
        const data = await response.json().catch(() => ({}));
        if (data.verified) {
            el.textContent = "✓ OK";
            el.className = "verify-result verify-ok";
        } else {
            el.textContent = data.reason || "Mismatch";
            el.className = "verify-result verify-fail";
        }
    } catch {
        el.textContent = "Error";
        el.className = "verify-result verify-fail";
    }
}

async function deleteAsset(id, filename) {
    if (!confirm('Delete stored asset "' + filename + '"? This cannot be undone.')) return;
    try {
        const r = await fetch(`${API_BASE}/assets/${id}`, { method: "DELETE" });
        if (r.ok) {
            toast("Asset deleted");
            loadAssets();
            loadStats();
        } else {
            const d = await r.json().catch(() => ({}));
            toast(d.detail || "Delete failed", "error");
        }
    } catch {
        toast("Delete failed", "error");
    }
}

document.getElementById("refreshAssets").addEventListener("click", () => loadAssets());

function renderAssetsFiltered() {
    const tbody = document.getElementById("assetsBody");
    const emptyEl = document.getElementById("assetsEmpty");
    const tableWrap = tbody && tbody.closest(".table-container");
    const searchInput = document.getElementById("assetSearch");
    const term = searchInput ? searchInput.value.trim().toLowerCase() : "";

    const list = term
        ? allAssets.filter((a) => {
              const name = (a.filename || "").toLowerCase();
              const hash = (a.file_hash || "").toLowerCase();
              return name.includes(term) || hash.includes(term);
          })
        : allAssets.slice();

    if (!list.length) {
        tbody.innerHTML = "";
        if (tableWrap) tableWrap.style.display = allAssets.length ? "block" : "none";
        if (emptyEl) emptyEl.style.display = "block";
        if (allAssets.length && term) {
            tbody.innerHTML = '<tr><td colspan="4" class="muted">No assets match the search</td></tr>';
            if (tableWrap) tableWrap.style.display = "block";
        }
        return;
    }

    if (emptyEl) emptyEl.style.display = "none";
    if (tableWrap) tableWrap.style.display = "block";

    const fragment = document.createDocumentFragment();
    tbody.innerHTML = "";
    list.forEach((a) => {
        const tr = document.createElement("tr");
        const dateStr = a.created_at ? new Date(a.created_at).toLocaleString() : "—";
        const hashShort = (a.file_hash || "").slice(0, 12) + "…";
        tr.innerHTML =
            "<td>" + escapeHtml(a.filename) + "</td>" +
            '<td class="hash-cell"><code class="hash-code" data-hash="' + escapeHtml(a.file_hash || "") + '" title="' + escapeHtml(a.file_hash || "") + '">' + escapeHtml(hashShort) + "</code> <button type=\"button\" class=\"btn-sm btn-copy\" title=\"Copy hash\">Copy</button></td>" +
            "<td>" + escapeHtml(dateStr) + "</td>" +
            "<td class=\"actions-cell\">" +
            "<button type=\"button\" class=\"btn-sm\" data-verify-id=\"" + a.id + "\">Verify</button> " +
            "<span class=\"verify-result\" id=\"verify-" + a.id + "\"></span> " +
            "<button type=\"button\" class=\"btn-sm btn-danger\" data-delete-id=\"" + a.id + "\" data-filename=\"" + escapeHtml(a.filename) + "\">Delete</button>" +
            "</td>";
        tr.querySelector("[data-verify-id]").addEventListener("click", () => verifyAsset(a.id));
        tr.querySelector("[data-delete-id]").addEventListener("click", () => deleteAsset(a.id, a.filename));
        const copyBtn = tr.querySelector(".btn-copy");
        const hashCode = tr.querySelector(".hash-code");
        if (copyBtn && hashCode) {
            copyBtn.addEventListener("click", () => {
                const h = hashCode.getAttribute("data-hash");
                if (h && navigator.clipboard && navigator.clipboard.writeText) {
                    navigator.clipboard.writeText(h).then(() => toast("Hash copied"));
                }
            });
        }
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

// --- Logs ---
let allLogs = [];

async function loadLogs() {
    const tbody = document.getElementById("logsBody");
    const emptyEl = document.getElementById("logsEmpty");
    const tableWrap = tbody && tbody.closest(".table-container");
    const filter = document.getElementById("logFilter");
    try {
        const response = await fetch(`${API_BASE}/logs`);
        const data = await response.json().catch(() => []);
        allLogs = Array.isArray(data) ? data : [];

        if (!response.ok) {
            tbody.innerHTML = '<tr><td colspan="4" class="muted">Failed to load (' + response.status + ")</td></tr>";
            if (emptyEl) emptyEl.style.display = "none";
            if (tableWrap) tableWrap.style.display = "block";
            return;
        }

        const statusFilter = filter ? filter.value : "";
        const list = statusFilter
            ? allLogs.filter((l) => (l.status || "").toUpperCase() === statusFilter)
            : allLogs.slice();

        if (list.length === 0) {
            tbody.innerHTML = "";
            if (tableWrap) tableWrap.style.display = allLogs.length === 0 ? "none" : "block";
            if (emptyEl) emptyEl.style.display = "block";
            if (allLogs.length > 0) {
                tbody.innerHTML = '<tr><td colspan="4" class="muted">No logs match the filter</td></tr>';
                if (tableWrap) tableWrap.style.display = "block";
            }
            return;
        }

        if (emptyEl) emptyEl.style.display = "none";
        if (tableWrap) tableWrap.style.display = "block";

        const fragment = document.createDocumentFragment();
        list.slice().reverse().forEach((log) => {
            const status = log.status ?? "";
            const statusClass = "status-" + String(status).toLowerCase();
            const ts = log.timestamp != null ? new Date(log.timestamp) : new Date(NaN);
            const timeStr = Number.isNaN(ts.getTime()) ? "—" : ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
            const tr = document.createElement("tr");
            tr.innerHTML =
                "<td>" + escapeHtml(log.filename) + "</td>" +
                '<td><span class="status-badge ' + escapeHtml(statusClass) + '">' + escapeHtml(status) + "</span></td>" +
                "<td>" + escapeHtml(log.reason) + "</td>" +
                "<td>" + escapeHtml(timeStr) + "</td>";
            fragment.appendChild(tr);
        });
        tbody.innerHTML = "";
        tbody.appendChild(fragment);
    } catch {
        tbody.innerHTML = '<tr><td colspan="4" class="muted">Failed to load logs</td></tr>';
        if (emptyEl) emptyEl.style.display = "none";
    }
}

document.getElementById("refreshLogs").addEventListener("click", () => loadLogs());
document.getElementById("exportLogsCsv").addEventListener("click", exportLogsCsv);
document.getElementById("logFilter").addEventListener("change", () => renderLogsFiltered());
const logSearchInput = document.getElementById("logSearch");
if (logSearchInput) {
    logSearchInput.addEventListener("input", () => renderLogsFiltered());
}

const assetSearchInput = document.getElementById("assetSearch");
if (assetSearchInput) {
    assetSearchInput.addEventListener("input", () => renderAssetsFiltered());
}

function exportLogsCsv() {
    if (!allLogs.length) {
        toast("No logs to export", "error");
        return;
    }
    const headers = ["filename", "status", "reason", "timestamp"];
    const rows = allLogs.map((l) => headers.map((h) => (l[h] != null ? String(l[h]) : "").replace(/"/g, '""')).join(","));
    const csv = [headers.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cloud_dlp_audit_logs_" + new Date().toISOString().slice(0, 10) + ".csv";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Logs exported as CSV");
}

function renderLogsFiltered() {
    if (!allLogs.length) return;
    const filter = document.getElementById("logFilter");
    const searchInput = document.getElementById("logSearch");
    const term = searchInput ? searchInput.value.trim().toLowerCase() : "";
    const tbody = document.getElementById("logsBody");
    const statusFilter = filter ? filter.value : "";
    let list = statusFilter
        ? allLogs.filter((l) => (l.status || "").toUpperCase() === statusFilter)
        : allLogs.slice();

    if (term) {
        list = list.filter((log) => {
            const name = (log.filename || "").toLowerCase();
            const reason = (log.reason || "").toLowerCase();
            return name.includes(term) || reason.includes(term);
        });
    }
    tbody.innerHTML = "";
    if (list.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="muted">No logs match the filter</td></tr>';
        return;
    }
    const fragment = document.createDocumentFragment();
    list.slice().reverse().forEach((log) => {
        const status = log.status ?? "";
        const statusClass = "status-" + String(status).toLowerCase();
        const ts = log.timestamp != null ? new Date(log.timestamp) : new Date(NaN);
        const timeStr = Number.isNaN(ts.getTime()) ? "—" : ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        const tr = document.createElement("tr");
        tr.innerHTML =
            "<td>" + escapeHtml(log.filename) + "</td>" +
            '<td><span class="status-badge ' + escapeHtml(statusClass) + '">' + escapeHtml(status) + "</span></td>" +
            "<td>" + escapeHtml(log.reason) + "</td>" +
            "<td>" + escapeHtml(timeStr) + "</td>";
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
}

// --- Init ---
initNav();
checkHealth();
setInterval(checkHealth, 15000);
loadStats();
loadLogs();
setFooterVersion();

// PWA service worker registration (requires HTTPS in browsers on real devices)
if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
        navigator.serviceWorker.register("/sw.js").catch(() => {
            // Ignore registration errors; app still works without offline support.
        });
    });
}

setInterval(() => {
    const logsPage = document.getElementById("page-logs");
    if (logsPage && logsPage.classList.contains("active")) loadLogs();
}, 10000);
