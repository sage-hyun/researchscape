"""Synthetic test document. No personal or downloaded paper content."""
import pathlib
import sys
from pypdf import PdfWriter
from pypdf.generic import DictionaryObject, NameObject, DecodedStreamObject
from pypdf.annotations import Text

writer = PdfWriter()
font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
for i in range(2):
    page = writer.add_blank_page(width=612, height=792)
    page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
    source = b'BT /F1 12 Tf 50 740 Td (1 Introduction) Tj 0 -24 Td (We study robust wearable motion learning.) Tj 0 -24 Td (Our model transfers inter-) Tj 0 -16 Td (national knowledge across sensor domains.) Tj 0 -32 Td (Repeated statement for ambiguity.) Tj ET BT /F1 12 Tf 340 740 Td (2 Results) Tj 0 -24 Td (The measured accuracy is 95.2 percent.) Tj 0 -72 Td (Repeated statement for ambiguity.) Tj ET' if i == 0 else b'BT /F1 12 Tf 50 740 Td (3 Limitations) Tj 0 -24 Td (This rotated page keeps the original coordinates.) Tj ET'
    stream = DecodedStreamObject()
    stream.set_data(source)
    page[NameObject('/Contents')] = writer._add_object(stream)
    if i == 1:
        page.rotate(90)
writer.add_annotation(page_number=0, annotation=Text(rect=(20, 20, 40, 40), text='Existing fixture annotation'))
with pathlib.Path(sys.argv[1]).open('xb') as output:
    writer.write(output)
