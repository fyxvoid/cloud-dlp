import time
from pathlib import Path
from typing import Any, Dict, List

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from config import ALLOWED_MIME_TYPES, API_VERSION, MAX_FILE_SIZE
from database.models import StoredAsset, UploadLog, get_db_session
from dlp_engine.detector import DLPDetector
from services.crypto import encrypt_and_hash, verify_hash
from services.logger import log_event
from services.storage import store_encrypted

app = FastAPI(
    title="Cloud DLP System",
    description="Upload files for DLP scanning; allowed files are stored and all events are logged.",
    version=API_VERSION,
)
detector = DLPDetector()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def _risk_level(findings: list) -> str:
    if not findings:
        return "LOW"
    return "HIGH" if len(findings) >= 3 else "MEDIUM"


async def _process_file(file: UploadFile) -> Dict[str, Any]:
    """Core DLP pipeline: validate → scan → encrypt → store. Returns a result dict (no exceptions)."""
    t0 = time.perf_counter()
    content = await file.read()
    filename = file.filename or "unknown"

    if len(content) > MAX_FILE_SIZE:
        log_event(filename, "ERROR", ["File too large"])
        return {
            "filename": filename, "status": "ERROR",
            "reason": ["File too large (Max 5MB)"], "risk": "HIGH",
            "scan_ms": int((time.perf_counter() - t0) * 1000),
        }

    content_type = file.content_type or ""
    if content_type not in ALLOWED_MIME_TYPES:
        log_event(filename, "ERROR", [f"Unsupported type: {content_type or 'unknown'}"])
        return {
            "filename": filename, "status": "ERROR",
            "reason": [f"Unsupported file type: {content_type or 'unknown'}"], "risk": "MEDIUM",
            "scan_ms": int((time.perf_counter() - t0) * 1000),
        }

    text = content.decode(errors="ignore")
    try:
        findings = detector.scan(text)
    except Exception as e:
        log_event(filename, "ERROR", [f"Scan error: {str(e)}"])
        return {
            "filename": filename, "status": "ERROR",
            "reason": [f"Scan error: {str(e)}"], "risk": "MEDIUM",
            "scan_ms": int((time.perf_counter() - t0) * 1000),
        }

    if findings:
        log_event(filename, "BLOCKED", findings)
        return {
            "filename": filename, "status": "BLOCKED",
            "reason": findings, "risk": _risk_level(findings),
            "violations": len(findings),
            "scan_ms": int((time.perf_counter() - t0) * 1000),
        }

    log_event(filename, "ALLOWED", [])

    try:
        encrypted, file_hash = encrypt_and_hash(content)
        storage_path = store_encrypted(encrypted)
    except ValueError as e:
        log_event(filename, "ERROR", [f"Invalid filename: {str(e)}"])
        return {
            "filename": filename, "status": "ERROR",
            "reason": [f"Invalid filename: {str(e)}"], "risk": "MEDIUM",
            "scan_ms": int((time.perf_counter() - t0) * 1000),
        }
    except Exception as e:
        log_event(filename, "ERROR", [f"Storage error: {str(e)}"])
        return {
            "filename": filename, "status": "ERROR",
            "reason": [f"Storage error: {str(e)}"], "risk": "MEDIUM",
            "scan_ms": int((time.perf_counter() - t0) * 1000),
        }

    with get_db_session() as db:
        asset = StoredAsset(filename=filename, file_hash=file_hash, storage_path=storage_path)
        db.add(asset)
        db.flush()
        asset_id = asset.id

    return {
        "filename": filename, "status": "ALLOWED",
        "message": "Encrypted and stored",
        "asset_id": asset_id, "file_hash": file_hash,
        "storage_path": storage_path, "risk": "LOW",
        "violations": 0,
        "scan_ms": int((time.perf_counter() - t0) * 1000),
    }


@app.get("/health")
def health() -> Dict[str, str]:
    """Health check for load balancers and monitoring."""
    return {"status": "ok"}


@app.get("/config")
def get_config() -> Dict[str, Any]:
    """Public config for UI: limits and allowed types (read-only)."""
    return {
        "max_file_size_mb": MAX_FILE_SIZE // (1024 * 1024),
        "allowed_mime_types": sorted(ALLOWED_MIME_TYPES),
        "version": API_VERSION,
    }


@app.get("/policies")
def get_policies() -> Dict[str, str]:
    """Return active DLP detection rules (name → regex pattern). Read-only."""
    return dict(detector.rules)


@app.get("/stats")
def get_stats() -> Dict[str, Any]:
    """Dashboard stats: total uploads, by status, and stored assets count."""
    with get_db_session() as db:
        logs = db.query(UploadLog).all()
        total = len(logs)
        allowed = sum(1 for l in logs if l.status == "ALLOWED")
        blocked = sum(1 for l in logs if l.status == "BLOCKED")
        errors = sum(1 for l in logs if l.status == "ERROR")
        assets_count = db.query(StoredAsset).count()
    return {
        "total_uploads": total,
        "allowed": allowed,
        "blocked": blocked,
        "errors": errors,
        "stored_assets": assets_count,
    }


@app.post("/upload")
async def upload_file(file: UploadFile = File(...)) -> Dict[str, Any]:
    """
    Handle file upload: validate, run DLP scan, and store if allowed.

    Returns:
        Dict with "status" ("ALLOWED" | "BLOCKED" | "ERROR"), optional "reason",
        "risk" level, and "scan_ms" performance metric.
    """
    result = await _process_file(file)
    status = result.get("status")
    if status == "ERROR":
        reason = result.get("reason", [])
        code = 400 if any("large" in r or "type" in r or "filename" in r for r in reason) else 500
        raise HTTPException(status_code=code, detail={"status": "ERROR", "reason": reason})
    return result


@app.post("/upload/batch")
async def upload_files_batch(files: List[UploadFile] = File(...)) -> Dict[str, Any]:
    """
    Batch DLP scan: accepts up to 20 files, returns per-file results and aggregate summary.
    Useful for bulk compliance checks and audit workflows.
    """
    if len(files) > 20:
        raise HTTPException(status_code=400, detail="Maximum 20 files per batch request.")
    results = []
    for file in files:
        results.append(await _process_file(file))
    allowed = sum(1 for r in results if r["status"] == "ALLOWED")
    blocked = sum(1 for r in results if r["status"] == "BLOCKED")
    errors = sum(1 for r in results if r["status"] == "ERROR")
    high_risk = sum(1 for r in results if r.get("risk") == "HIGH")
    total_scan_ms = sum(r.get("scan_ms", 0) for r in results)
    return {
        "results": results,
        "summary": {
            "total": len(files),
            "allowed": allowed,
            "blocked": blocked,
            "errors": errors,
            "high_risk": high_risk,
            "total_scan_ms": total_scan_ms,
        },
    }


@app.get("/assets")
def list_assets() -> List[Dict[str, Any]]:
    """List all stored (encrypted) assets with id, filename, hash, created_at."""
    with get_db_session() as db:
        assets = db.query(StoredAsset).order_by(StoredAsset.created_at.desc()).all()
        return [
            {
                "id": a.id,
                "filename": a.filename,
                "file_hash": a.file_hash,
                "storage_path": a.storage_path,
                "created_at": a.created_at,
            }
            for a in assets
        ]


@app.delete("/assets/{asset_id}")
def delete_asset(asset_id: int) -> Dict[str, str]:
    """Remove stored asset from DB and delete file from disk."""
    with get_db_session() as db:
        asset = db.query(StoredAsset).filter(StoredAsset.id == asset_id).first()
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")
        storage_path = asset.storage_path
        db.delete(asset)
    path = Path(storage_path)
    if path.exists():
        try:
            path.unlink()
        except OSError:
            pass
    return {"status": "deleted", "message": "Asset removed"}


@app.get("/assets/{asset_id}/verify")
def verify_asset(asset_id: int) -> Dict[str, Any]:
    """Recompute hash of stored file and compare to DB. Returns verified: true/false."""
    with get_db_session() as db:
        asset = db.query(StoredAsset).filter(StoredAsset.id == asset_id).first()
        if not asset:
            raise HTTPException(status_code=404, detail="Asset not found")
        storage_path = asset.storage_path
        file_hash = asset.file_hash
    path = Path(storage_path)
    if not path.exists():
        return {"verified": False, "reason": "File missing on storage"}
    content = path.read_bytes()
    ok = verify_hash(content, file_hash)
    return {"verified": ok, "reason": "Hash matches" if ok else "Hash mismatch"}


@app.get("/logs")
def get_logs() -> List[Dict[str, Any]]:
    """
    Retrieves security audit logs from the database.

    Returns:
        A list of log entries (filename, status, reason, timestamp).
    """
    with get_db_session() as db:
        logs = db.query(UploadLog).all()
        return [
            {
                "filename": log.filename,
                "status": log.status,
                "reason": log.reason,
                "timestamp": log.timestamp,
            }
            for log in logs
        ]


# Serve frontend static files (must be last so API routes take precedence)
_FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
if _FRONTEND_DIR.is_dir():
    from fastapi.staticfiles import StaticFiles
    @app.get("/", response_class=FileResponse)
    def serve_index():
        return FileResponse(_FRONTEND_DIR / "index.html")
    app.mount("/", StaticFiles(directory=str(_FRONTEND_DIR), html=True), name="frontend")
