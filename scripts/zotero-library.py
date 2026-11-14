"""Read a Zotero library without modifying its database or attachment files."""
import argparse
import json
import pathlib
import shutil
import sqlite3
import time
import sys
sys.stdout.reconfigure(encoding="utf-8")


def snapshot_database(root, destination):
    source = root / "zotero.sqlite"
    destination.parent.mkdir(parents=True, exist_ok=True)
    mode = "sqlite-backup"
    try:
        with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True, timeout=1) as conn:
            conn.execute("SELECT count(*) FROM items").fetchone()
            start = time.monotonic()
            def progress(status, remaining, total):
                if time.monotonic() - start > 5:
                    raise TimeoutError("Zotero snapshot timed out")
            with sqlite3.connect(destination) as target:
                conn.backup(target, pages=256, progress=progress, sleep=0.1)
    except (sqlite3.OperationalError, TimeoutError):
        # Zotero uses an exclusive SQLite lock. A stable main file with an empty WAL
        # can be copied read-only. Never ignore a nonempty live WAL.
        wal = pathlib.Path(str(source) + "-wal")
        before = source.stat()
        if wal.exists() and wal.stat().st_size:
            raise RuntimeError("Zotero DB is busy with pending writes. Retry after sync finishes or close Zotero briefly.")
        shutil.copyfile(source, destination)
        after = source.stat()
        if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or (wal.exists() and wal.stat().st_size):
            raise RuntimeError("Zotero changed during snapshot. Please retry.")
        mode = "stable-read-only-copy"
    conn = sqlite3.connect(destination.as_uri() + "?mode=ro&immutable=1", uri=True)
    if conn.execute("PRAGMA quick_check").fetchone()[0] != "ok":
        conn.close()
        raise RuntimeError("Zotero snapshot validation failed")
    return conn, mode


def inventory(root, cache):
    root = pathlib.Path(root).resolve()
    conn, mode = snapshot_database(root, pathlib.Path(cache).resolve() / "zotero-snapshot.sqlite")
    conn.row_factory = sqlite3.Row
    try:
        fields = {}
        for row in conn.execute("SELECT d.itemID,f.fieldName,v.value FROM itemData d JOIN fields f USING(fieldID) JOIN itemDataValues v USING(valueID) WHERE f.fieldName IN ('title','DOI','url','extra','archiveID')"):
            fields.setdefault(row["itemID"], {})[row["fieldName"]] = row["value"]
        rows = conn.execute("SELECT a.itemID,a.parentItemID,a.path,a.linkMode,i.key attachmentKey,p.key parentKey,i.libraryID FROM itemAttachments a JOIN items i ON i.itemID=a.itemID LEFT JOIN items p ON p.itemID=a.parentItemID WHERE a.contentType='application/pdf' AND NOT EXISTS(SELECT 1 FROM deletedItems d WHERE d.itemID=a.itemID OR d.itemID=a.parentItemID)")
        result = []
        storage = (root / "storage").resolve()
        for row in rows:
            attachment, parent = fields.get(row["itemID"], {}), fields.get(row["parentItemID"], {})
            raw = row["path"] or ""
            filepath = (storage / row["attachmentKey"] / raw[8:]).resolve() if raw.startswith("storage:") else None
            # Linked files outside the supplied storage root require explicit import.
            if filepath and not filepath.is_relative_to(storage):
                filepath = None
            exists = bool(filepath and filepath.is_file())
            stat = filepath.stat() if exists else None
            result.append({"id": "zotero:" + row["attachmentKey"], "source": "zotero", "attachmentKey": row["attachmentKey"], "itemKey": row["parentKey"], "libraryId": row["libraryID"], "title": parent.get("title") or attachment.get("title") or "", "attachmentTitle": attachment.get("title", ""), "doi": parent.get("DOI", ""), "url": parent.get("url", ""), "extra": parent.get("extra", ""), "archiveId": parent.get("archiveID", ""), "path": str(filepath) if filepath else None, "exists": exists, "size": stat.st_size if stat else None, "mtime": stat.st_mtime_ns if stat else None, "missingReason": None if exists else "outside-storage-or-missing"})
        return {"records": result, "snapshotMode": mode, "sourceModified": (root / "zotero.sqlite").stat().st_mtime, "storageRoot": str(storage), "available": sum(r["exists"] for r in result), "total": len(result)}
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True)
    parser.add_argument("--cache", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(inventory(args.root, args.cache), ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
