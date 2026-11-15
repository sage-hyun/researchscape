"""Read-only PDFium character mapping and separate standard Highlight PDF copies."""
import argparse
import ctypes
import hashlib
import importlib.util
import json
import math
import os
import pathlib
import re
import sys
import time
import unicodedata

sys.stdout.reconfigure(encoding="utf-8")
VERSION = 2
HEADING = re.compile(r"^(?:\d+(?:\.\d+)*[.)]?\s+)?(abstract|introduction|related work|background|methods?|methodology|approach|experiments?|results?|discussion|limitations?|conclusions?|future work|references)(?:\s*[:.]?\s*)$", re.I)


def pdf_hash(filename):
    with open(filename, "rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def write_json(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def section_summary(pages):
    sections = []
    current = {"id": "section-0", "title": "Opening / Abstract", "pageStart": 1, "pageEnd": 1, "text": ""}
    for page in pages:
        for line in page["text"].splitlines(keepends=True):
            candidate = line.strip()
            if HEADING.fullmatch(candidate) and current["text"].strip():
                sections.append(current)
                current = {"id": "section-" + str(len(sections)), "title": candidate, "pageStart": page["page"], "pageEnd": page["page"], "text": ""}
            current["text"] += line
            current["pageEnd"] = page["page"]
    if current["text"].strip():
        sections.append(current)
    return sections


def layout(filename, directory):
    import pypdfium2 as pdfium
    digest = pdf_hash(filename)
    target = pathlib.Path(directory) / digest / ("pdfium-v" + str(VERSION) + ".json")
    if target.is_file():
        saved = json.loads(target.read_text(encoding="utf-8"))
        if saved.get("pdfHash") == digest and saved.get("parserVersion") == VERSION:
            return saved
    if pathlib.Path(filename).stat().st_size > 100 * 1024 * 1024:
        raise ValueError("PDF exceeds the 100MB limit")
    doc = pdfium.PdfDocument(filename)
    pages = []
    total = 0
    try:
        if not 0 < len(doc) <= 500:
            raise ValueError("PDF must contain 1 to 500 pages")
        for number in range(len(doc)):
            page = doc[number]
            textpage = page.get_textpage()
            glyphs = []
            try:
                total += textpage.count_chars()
                if total > 2000000:
                    raise ValueError("PDF character mapping exceeds the 2 million character limit")
                for i in range(textpage.count_chars()):
                    # Use the character-array Unicode API, not text-range offsets:
                    # PDFium text indices can differ for excluded/inserted chars.
                    codepoint = pdfium.raw.FPDFText_GetUnicode(textpage, i)
                    char = chr(codepoint) if 0 < codepoint <= 0x10FFFF else ""
                    if codepoint == 2 and pdfium.raw.FPDFText_IsHyphen(textpage, i) > 0:
                        char = "-\n"
                    try:
                        box = list(textpage.get_charbox(i))
                        if not all(math.isfinite(x) for x in box):
                            box = None
                    except Exception:
                        box = None
                    angle = pdfium.raw.FPDFText_GetCharAngle(textpage, i)
                    glyphs.append([char, box, round(angle, 6)])
                pages.append({"page": number + 1, "size": list(page.get_size()), "rotation": page.get_rotation(), "text": "".join(g[0] for g in glyphs), "glyphs": glyphs})
            finally:
                textpage.close()
                page.close()
    finally:
        doc.close()
    result = {"pdfHash": digest, "parserVersion": VERSION, "pages": pages, "sections": section_summary(pages)}
    write_json(target, result)
    return result


def normalized(glyphs, join_hyphen=False):
    expanded = []
    for i, glyph in enumerate(glyphs):
        for char in unicodedata.normalize("NFKC", glyph[0]):
            if char == "\u00ad":
                continue
            expanded.append(("-" if char in "\u2010\u2011" else char, i))
    output, mapping = [], []
    at = 0
    while at < len(expanded):
        char, source = expanded[at]
        if char == "-" and output and output[-1].isalpha():
            end = at + 1
            while end < len(expanded) and expanded[end][0].isspace():
                end += 1
            if end > at + 1 and any(c in "\r\n" for c, _ in expanded[at + 1:end]) and end < len(expanded) and expanded[end][0].isalpha():
                if not join_hyphen:
                    output.append("-")
                    mapping.append(source)
                at = end
                continue
        if char.isspace():
            if output and output[-1] != " ":
                output.append(" ")
                mapping.append(source)
        else:
            output.append(char)
            mapping.append(source)
        at += 1
    while output and output[-1] == " ":
        output.pop()
        mapping.pop()
    return "".join(output), mapping


def norm_quote(quote, join_hyphen=False):
    return normalized([[c, None, 0] for c in quote], join_hyphen)[0]


def normalized_rect(page, box):
    import pypdfium2 as pdfium
    points = []
    for x, y in [(box[0], box[1]), (box[0], box[3]), (box[2], box[1]), (box[2], box[3])]:
        dx, dy = ctypes.c_int(), ctypes.c_int()
        if not pdfium.raw.FPDF_PageToDevice(page, 0, 0, 1000000, 1000000, 0, x, y, dx, dy):
            raise ValueError("PDF coordinate conversion failed")
        points.append((dx.value / 1000000, dy.value / 1000000))
    return [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]


def geometry(glyphs, start, end, page):
    lines = []
    current = None
    for char, box, angle in glyphs[start:end]:
        if not char.strip():
            if "\n" in char or "\r" in char:
                current = None
            continue
        if not box or box[2] <= box[0] or box[3] <= box[1] or abs(angle) > 0.01:
            return None
        height = box[3] - box[1]
        line_height = max(height, current[3] - current[1]) if current is not None else height
        if current is not None and abs((current[1] + current[3] - box[1] - box[3]) / 2) < line_height * 0.75 and -line_height <= box[0] - current[2] <= line_height * 2.5:
            current[0] = min(current[0], box[0])
            current[1] = min(current[1], box[1])
            current[2] = max(current[2], box[2])
            current[3] = max(current[3], box[3])
        else:
            current = list(box)
            lines.append(current)
    if not lines:
        return None
    quads = [[b[0], b[3], b[2], b[3], b[0], b[1], b[2], b[1]] for b in lines]
    rects = [normalized_rect(page, b) for b in lines]
    if any(not (0 <= r[0] < r[2] <= 1 and 0 <= r[1] < r[3] <= 1) for r in rects):
        return None
    return {"quads": quads, "rects": rects}


def search(filename, cached, annotations):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(filename)
    results = []
    try:
        for annotation in annotations:
            if annotation.get("pdfHash", cached["pdfHash"]) != cached["pdfHash"]:
                results.append({"id": annotation["id"], "status": "pdf_mismatch", "locations": []})
                continue
            quote = annotation.get("quote", "")
            if len(norm_quote(quote)) < 4:
                results.append({"id": annotation["id"], "status": "unmatched", "locations": []})
                continue
            locations, seen = [], set()
            pages = sorted(cached["pages"], key=lambda p: p["page"] != annotation.get("pageHint"))
            for page_data in pages:
                for joined in [False, True]:
                    text, mapping = normalized(page_data["glyphs"], joined)
                    needle = norm_quote(quote, joined)
                    at = text.find(needle)
                    while at >= 0:
                        start, end = mapping[at], mapping[at + len(needle) - 1] + 1
                        key = (page_data["page"], start, end)
                        reconstructed = "".join(g[0] for g in page_data["glyphs"][start:end])
                        if key not in seen and norm_quote(reconstructed, joined) == needle:
                            seen.add(key)
                            page = doc[page_data["page"] - 1]
                            try:
                                geom = geometry(page_data["glyphs"], start, end, page)
                            finally:
                                page.close()
                            locations.append({"locationId": hashlib.sha256(str(key).encode()).hexdigest()[:24], "page": page_data["page"], "charStart": start, "charEnd": end, "originalText": reconstructed, "normalization": "line-hyphen-join" if joined else "whitespace-ligature", "geometryVerified": bool(geom), **(geom or {"quads": [], "rects": []})})
                        if len(locations) >= 100:
                            break
                        at = text.find(needle, at + 1)
                    if len(locations) >= 100:
                        break
                if len(locations) >= 100:
                    break
            status = "matched" if len(locations) == 1 and locations[0]["geometryVerified"] else "ambiguous" if locations else "unmatched"
            results.append({"id": annotation["id"], "status": status, "locations": locations, "truncated": len(locations) >= 100})
    finally:
        doc.close()
    return {"pdfHash": cached["pdfHash"], "parserVersion": VERSION, "annotations": results}


def annotated_copy(filename, output, payload):
    from pypdf import PdfReader, PdfWriter
    from pypdf.annotations import Highlight
    from pypdf.generic import ArrayObject, FloatObject, NameObject, TextStringObject
    if pdf_hash(filename) != payload["pdfHash"]:
        raise ValueError("pdf_mismatch")
    reader = PdfReader(filename)
    writer = PdfWriter()
    writer.clone_document_from_reader(reader)
    added = 0
    for annotation in payload["annotations"]:
        if annotation["status"] != "approved" or annotation["match"]["status"] != "matched" or annotation["type"] != "highlight":
            raise ValueError("Only approved, matched highlights may be exported")
        location = annotation["match"]["selected"]
        quads = [value for quad in location["quads"] for value in quad]
        if not quads or len(quads) % 8 or not all(math.isfinite(v) for v in quads):
            raise ValueError("Invalid QuadPoints")
        xs, ys = quads[0::2], quads[1::2]
        item = Highlight(rect=(min(xs), min(ys), max(xs), max(ys)), quad_points=ArrayObject([FloatObject(v) for v in quads]), highlight_color=annotation["color"].lstrip("#"), printing=True)
        item[NameObject("/Contents")] = TextStringObject("Researchscape AI / " + annotation["category"] + "\n" + annotation["comment"] + "\n" + annotation["reason"])
        item[NameObject("/T")] = TextStringObject("Researchscape AI")
        item[NameObject("/NM")] = TextStringObject("researchscape:" + annotation["id"])
        writer.add_annotation(page_number=location["page"] - 1, annotation=item)
        added += 1
    output = pathlib.Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(output.name + "." + str(os.getpid()) + ".part")
    try:
        with temporary.open("xb") as stream:
            writer.write(stream)
        check = PdfReader(temporary)
        if len(check.pages) != len(reader.pages):
            raise ValueError("PDF page count changed")
        os.link(temporary, output)  # Exclusive creation; never overwrite a file.
    finally:
        temporary.unlink(missing_ok=True)
    return {"pdfHash": payload["pdfHash"], "added": added, "pages": len(reader.pages), "sha256": pdf_hash(output)}


def render(filename, page, output):
    module_path = pathlib.Path(__file__).with_name("extract-figures.py")
    spec = importlib.util.spec_from_file_location("figure_renderer", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.render_region(filename, page, None, output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["layout", "search", "export", "render"])
    parser.add_argument("--pdf", required=True)
    parser.add_argument("--cache")
    parser.add_argument("--input")
    parser.add_argument("--output")
    parser.add_argument("--page", type=int)
    args = parser.parse_args()
    try:
        if args.command == "export":
            result = annotated_copy(args.pdf, args.output, json.loads(pathlib.Path(args.input).read_text(encoding="utf-8")))
        elif args.command == "render":
            result = render(args.pdf, args.page, args.output)
        else:
            cached = layout(args.pdf, args.cache)
            result = {"pdfHash": cached["pdfHash"], "parserVersion": VERSION, "pages": [{"page": p["page"], "size": p["size"]} for p in cached["pages"]], "sections": cached["sections"]} if args.command == "layout" else search(args.pdf, cached, json.loads(pathlib.Path(args.input).read_text(encoding="utf-8")))
        print(json.dumps(result, ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}, ensure_ascii=False))
        raise SystemExit(1)
