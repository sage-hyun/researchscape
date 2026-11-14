"""Local-only PDF inspection, layout extraction, and region rendering.

OpenDataLoader detects layout; PDFium renders the full region, including vectors,
labels, and multipart panels. No hybrid service or LLM is used.
"""
import argparse
import hashlib
import json
import math
import pathlib
import re
import sys
import time

sys.stdout.reconfigure(encoding="utf-8")
VERSION = 2
FIGURE = re.compile(r"^\s*(?:fig(?:ure)?\.?)[\s\u00a0]*(\d+[a-z]?)(?=[\s.:)\-–—]|$)", re.I)


def open_pdf(filename):
    import pypdfium2 as pdfium
    return pdfium.PdfDocument(str(filename))


def inspect_pdf(filename):
    doc = open_pdf(filename)
    try:
        if not len(doc):
            raise ValueError("PDF has no pages")
        page = doc[0]
        textpage = page.get_textpage()
        text = textpage.get_text_range()[:16000]
        textpage.close()
        page.close()
        return {"pages": len(doc), "metadata": doc.get_metadata_dict(), "firstPageText": text, "pageSizes": [list(doc[i].get_size()) for i in range(min(len(doc), 500))]}
    finally:
        doc.close()


def flatten(element):
    if isinstance(element, list):
        for child in element:
            yield from flatten(child)
    elif isinstance(element, dict):
        if "type" in element and "bounding box" in element:
            yield element
        for key in ("kids", "rows", "cells", "list items"):
            yield from flatten(element.get(key, []))


def box_of(element):
    value = element.get("bounding box")
    if not isinstance(value, list) or len(value) != 4 or not all(isinstance(v, (int, float)) and math.isfinite(v) for v in value):
        return None
    return list(map(float, value)) if value[2] > value[0] and value[3] > value[1] else None


def overlap(a, b):
    return max(0, min(a[2], b[2]) - max(a[0], b[0])) / max(1, min(a[2]-a[0], b[2]-b[0]))


def union(boxes):
    return [min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)]


def detect_figures(layout, sizes):
    elements = [e for e in flatten(layout.get("kids", [])) if box_of(e) and isinstance(e.get("page number"), int) and 1 <= e["page number"] <= len(sizes)]
    images = [e for e in elements if e["type"] in ("image", "figure")]
    by_id = {e.get("id"): e for e in elements if e.get("id") is not None}
    figures, seen, used = [], set(), set()
    for cap in elements:
        text = re.sub(r"\s+", " ", cap.get("content", "")).strip()
        match = FIGURE.match(text)
        if not match or len(text) > 5000 or (cap["type"] not in ("caption", "paragraph", "text block", "list item")):
            continue
        if cap["type"] != "caption" and not re.match(r"^\s*fig(?:ure)?\.?\s*\d+[a-z]?\s*[.:)]", text, re.I):
            continue
        number, page = match[1].lower(), cap["page number"]
        key = (number, page)
        if key in seen:
            continue
        seen.add(key)
        c = box_of(cap)
        width, height = sizes[page-1]
        linked = by_id.get(cap.get("linked content id"))
        if linked and linked.get("page number") == page and linked["type"] in ("image", "figure"):
            boxes, method = [box_of(linked)], "linked-caption"
            used.add(linked.get("id"))
        else:
            boxes, method = [], "caption-region-heuristic"
        candidates = [e for e in images if e["page number"] == page and overlap(box_of(e), c) >= .3 and box_of(e)[1] >= c[1]-8 and (box_of(e)[1]+box_of(e)[3])/2 > c[3] and box_of(e)[1]-c[3] < min(180, height*.25)]
        if candidates:
            # Keep panels on the same row; don't accidentally join a preceding figure.
            nearest = min(box_of(e)[1] for e in candidates)
            candidates = [e for e in candidates if box_of(e)[1] <= nearest+45]
            for e in candidates:
                boxes.append(box_of(e)); used.add(e.get("id"))
            if method != "linked-caption":
                method = "caption-nearby-images"
        if boxes:
            b = union(boxes)
            if (b[1]+b[3])/2 > (c[1]+c[3])/2:
                b[1] = max(b[1], c[3]+2)
        else:
            # Vector diagrams may not have an image object. Bound the region above
            # the caption by body paragraphs and earlier captions, then rasterize it.
            upper = min(height-24, c[3]+height*.52)
            for e in elements:
                if e["page number"] != page or e is cap:
                    continue
                eb = box_of(e)
                body = e["type"] in ("paragraph", "heading") and len(e.get("content", "")) > 160
                if (body or e["type"] == "caption") and overlap(eb, c) > .4 and eb[1] > c[3]+22:
                    upper = min(upper, eb[1]-4)
            b = [max(0, c[0]-3), c[3]+3, min(width, c[2]+3), upper]
            if b[3]-b[1] < 25:
                continue
        b = [max(0, b[0]-3), max(0, b[1]-3), min(width, b[2]+3), min(height, b[3]+3)]
        figures.append({"id": f"figure-{number}-p{page}", "number": number, "page": page, "caption": text, "captionBox": c, "bbox": b, "method": method, "needsReview": method != "linked-caption", "kind": "figure"})
    for image in images:
        b, page = box_of(image), image["page number"]
        w, h = sizes[page-1]
        b = [max(0,b[0]),max(0,b[1]),min(w,b[2]),min(h,b[3])]
        if image.get("id") in used or b[2]-b[0] < 75 or b[3]-b[1] < 40:
            continue
        figures.append({"id": f"image-p{page}-{image.get('id', len(figures))}", "number": None, "page": page, "caption": "Unnumbered image candidate", "bbox": b, "method": "image-object", "needsReview": True, "kind": "image"})
    figures.sort(key=lambda f: (f["number"] is None, int(re.match(r"\d+", f["number"])[0]) if f["number"] else 99999, f["page"]))
    return figures


def refine_vector_regions(filename, figures):
    doc = open_pdf(filename)
    try:
        cache = {}
        for f in figures:
            if f["method"] != "caption-region-heuristic":
                continue
            page_number = f["page"]
            if page_number not in cache:
                page = doc[page_number-1]
                boxes = []
                for obj in page.get_objects(filter=[2, 3, 4, 5]):
                    b = obj.get_bounds()
                    container = obj.container
                    # Bounds inside nested Form XObjects need their parent transforms.
                    while container:
                        b = container.get_matrix().on_rect(*b)
                        container = container.container
                    boxes.append((obj.type, list(b)))
                cache[page_number] = boxes
                page.close()
            region, cap = f["bbox"], f["captionBox"]
            boxes = []
            for kind, b in cache[page_number]:
                if b[0] < region[0]-5 or b[2] > region[2]+5 or b[1] < cap[3]-5 or b[3] > region[3]+1:
                    continue
                if b[3]-b[1] < 3 and b[2]-b[0] > (region[2]-region[0])*.8:
                    continue  # Running header/footer rules.
                if b[2]-b[0] > 3 or b[3]-b[1] > 3:
                    boxes.append(b)
            if boxes:
                graphic = union(boxes)
                if graphic[2]-graphic[0] > 30 and graphic[3]-graphic[1] > 20:
                    f["bbox"] = [max(region[0], graphic[0]-8), max(cap[3]+2, graphic[1]-8), min(region[2], graphic[2]+8), min(region[3], graphic[3]+8)]
                    f["method"] = "caption-vector-region"
        return figures
    finally:
        doc.close()


def render_region(filename, page_number, bbox, output, max_width=1600):
    doc = open_pdf(filename)
    try:
        if not 1 <= page_number <= len(doc):
            raise ValueError("Invalid page")
        page = doc[page_number-1]
        width, height = page.get_size()
        b = bbox or [0, 0, width, height]
        if len(b) != 4 or not all(isinstance(v, (float, int)) and math.isfinite(v) for v in b) or not (0 <= b[0] < b[2] <= width and 0 <= b[1] < b[3] <= height):
            raise ValueError("Crop rectangle is outside the page")
        scale = min(2.5, max_width/max(1, b[2]-b[0]), math.sqrt(5000000/max(1, (b[2]-b[0])*(b[3]-b[1]))))
        bitmap = page.render(scale=scale, crop=(b[0], b[1], width-b[2], height-b[3]))
        image = bitmap.to_pil().convert("RGB")
        image.save(output, format="WEBP", quality=87)
        result = {"width": image.width, "height": image.height, "bbox": b, "pageSize": [width, height]}
        image.close(); bitmap.close(); page.close()
        return result
    finally:
        doc.close()


def extract(filename, output, force=False):
    import opendataloader_pdf
    from importlib.metadata import version
    filename, output = pathlib.Path(filename).resolve(), pathlib.Path(output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    digest = hashlib.file_digest(filename.open("rb"), "sha256").hexdigest()
    cached = output / "figures.json"
    if cached.exists() and not force:
        prior = json.loads(cached.read_text(encoding="utf-8"))
        if prior.get("pdfHash") == digest and prior.get("version") == VERSION and all((output/f["file"]).is_file() for f in prior.get("figures", [])):
            return {**prior, "cached": True}
    info = inspect_pdf(filename)
    if info["pages"] > 500:
        raise ValueError("PDF exceeds the 500-page processing limit")
    layout_dir = output / "layout"
    layout_dir.mkdir(exist_ok=True)
    # A subprocess JVM is bounded by the SDK timeout. Hybrid is explicitly off.
    opendataloader_pdf.convert(input_path=str(filename), output_dir=str(layout_dir), format="json", image_output="off", hybrid="off", quiet=True, threads="1", timeout=150)
    layout_file = layout_dir / (filename.stem + ".json")
    if not layout_file.exists():
        raise RuntimeError("OpenDataLoader did not produce layout JSON")
    layout = json.loads(layout_file.read_text(encoding="utf-8"))
    figures = refine_vector_regions(filename, detect_figures(layout, info["pageSizes"]))
    rendered, warnings = [], []
    for figure in figures:
        figure["file"] = figure["id"] + ".webp"
        w, h = info["pageSizes"][figure["page"]-1]
        b = figure["bbox"]
        figure["bbox"] = [max(0,b[0]),max(0,b[1]),min(w,b[2]),min(h,b[3])]
        try:
            figure.update(render_region(filename, figure["page"], figure["bbox"], output/figure["file"]))
            rendered.append(figure)
        except (ValueError, RuntimeError) as exc:
            warnings.append({"figureId":figure["id"],"reason":str(exc)})
    figures = rendered
    preview = {"id": "page-1", "number": None, "page": 1, "caption": "First page preview", "kind": "page", "method": "page-preview", "needsReview": False, "file": "page-1.webp"}
    preview.update(render_region(filename, 1, None, output/preview["file"], max_width=1000))
    figures.append(preview)
    preferred = next((f for f in figures if f["number"] == "1"), None) or next((f for f in figures if f["kind"] == "figure"), None) or preview
    result = {"version": VERSION, "pdfHash": digest, "pages": info["pages"], "pageSizes": info["pageSizes"], "figures": figures, "defaultFigureId": preferred["id"], "warnings":warnings,"engine": "OpenDataLoader PDF " + version("opendataloader-pdf") + " + PDFium", "hybrid": "off", "extractedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    temporary = output / "figures.json.tmp"
    temporary.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    temporary.replace(cached)
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["inspect", "extract", "render"])
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--output")
    parser.add_argument("--page", type=int, default=1)
    parser.add_argument("--bbox")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "inspect":
            result = inspect_pdf(args.pdf)
        elif args.command == "extract":
            result = extract(args.pdf, args.output, args.force)
        else:
            result = render_region(args.pdf, args.page, json.loads(args.bbox) if args.bbox else None, args.output)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
