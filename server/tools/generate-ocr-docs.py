#!/usr/bin/env python3
"""Erzeugt die Testdokumente für den OCR-Test: fixtures/ocr/rechnung.pdf und pruefbericht.pdf samt PNG-Seiten.

Aufruf (im Verzeichnis server/): python3 tools/generate-ocr-docs.py
Benötigt reportlab und pdftoppm (poppler-utils). Die erzeugten Dateien sind im Repository eingecheckt;
das Skript wird nur gebraucht, wenn sich die Dokumente ändern sollen. Die erwarteten Antworten stehen in src/testtypes/ocr.js.
"""
import math
import random
import subprocess
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas

OUT = Path(__file__).resolve().parent.parent / "fixtures" / "ocr"
FONTS = "/usr/share/fonts/truetype"
pdfmetrics.registerFont(TTFont("Sans", f"{FONTS}/liberation/LiberationSans-Regular.ttf"))
pdfmetrics.registerFont(TTFont("Sans-Bold", f"{FONTS}/liberation/LiberationSans-Bold.ttf"))
pdfmetrics.registerFont(TTFont("Hand", f"{FONTS}/freefont/FreeSerifItalic.ttf"))

INK = colors.Color(0.08, 0.14, 0.55)  # Kugelschreiber-Blau
W, H = A4


def money(v):
    return f"{v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".") + " €"


# ---------------------------------------------------------------- Rechnung
ITEMS = [  # Artikel, Menge, Einzelpreis, MwSt-Satz
    ("Kopierpapier A4, 500 Blatt", 10, 4.49, 19),
    ("Kugelschreiber blau, 10er Pack", 4, 3.25, 19),
    ("Ordner A4, breit", 12, 2.10, 19),
    ("Haftnotizen gelb, 6er Pack", 6, 1.95, 19),
    ("Tacker, Metall", 2, 8.90, 19),
    ("Fachzeitschrift Büro aktuell", 3, 6.50, 7),
    ("Kaffeebohnen 1 kg", 5, 12.99, 7),
    ("Druckerpatrone schwarz", 3, 24.50, 19),
]


def invoice():
    c = canvas.Canvas(str(OUT / "rechnung.pdf"), pagesize=A4)
    c.setTitle("Rechnung R-2026-10842")
    c.setFont("Sans-Bold", 20)
    c.drawString(20 * mm, H - 28 * mm, "Büro-Discount Nordstadt GmbH")
    c.setFont("Sans", 9)
    for i, line in enumerate(["Hafenstraße 14 · 24103 Kiel", "Tel. 0431 555 0142 · info@buero-nordstadt.example", "USt-IdNr. DE123456789"]):
        c.drawString(20 * mm, H - (34 + i * 4.5) * mm, line)

    c.setFont("Sans", 10)
    c.drawString(20 * mm, H - 58 * mm, "Elektro Hoffmann GmbH")
    c.drawString(20 * mm, H - 63 * mm, "Frau Sandra Weiß")
    c.drawString(20 * mm, H - 68 * mm, "Werftbahnstraße 8, 24143 Kiel")
    c.setFont("Sans-Bold", 10)
    c.drawString(125 * mm, H - 58 * mm, "Rechnung Nr. R-2026-10842")
    c.setFont("Sans", 10)
    c.drawString(125 * mm, H - 63 * mm, "Rechnungsdatum: 14.10.2026")
    c.drawString(125 * mm, H - 68 * mm, "Kundennummer: K-48213")

    y = H - 92 * mm
    cols = [20, 30, 105, 124, 148, 174]  # Pos, Artikel, Menge, Einzelpreis, Gesamt, MwSt
    c.setFillColor(colors.Color(0.9, 0.92, 0.95))
    c.rect(18 * mm, y - 2 * mm, 176 * mm, 8 * mm, stroke=0, fill=1)
    c.setFillColor(colors.black)
    c.setFont("Sans-Bold", 9)
    for x, t in zip(cols, ["Pos.", "Artikel", "Menge", "Einzelpreis", "Gesamt", "MwSt"]):
        c.drawString(x * mm, y + 1 * mm, t)
    c.setFont("Sans", 9.5)
    y -= 8 * mm
    brutto = 0.0
    by_rate = {7: 0.0, 19: 0.0}
    pieces = 0
    for i, (name, qty, price, rate) in enumerate(ITEMS, 1):
        total = round(qty * price, 2)
        brutto += total
        by_rate[rate] += total
        pieces += qty
        c.drawString(cols[0] * mm, y, str(i))
        c.drawString(cols[1] * mm, y, name)
        c.drawRightString((cols[2] + 8) * mm, y, str(qty))
        c.drawRightString((cols[3] + 17) * mm, y, money(price))
        c.drawRightString((cols[4] + 18) * mm, y, money(total))
        c.drawString(cols[5] * mm, y, f"{rate} %")
        c.setStrokeColor(colors.Color(0.85, 0.85, 0.85))
        c.line(18 * mm, y - 2.5 * mm, 194 * mm, y - 2.5 * mm)
        y -= 7.5 * mm
    brutto = round(brutto, 2)

    vat7 = round(by_rate[7] * 7 / 107, 2)
    vat19 = round(by_rate[19] * 19 / 119, 2)
    netto = round(brutto - vat7 - vat19, 2)
    y -= 6 * mm
    for label, value, bold in [
        ("Nettobetrag", netto, False),
        ("zzgl. 7 % MwSt", vat7, False),
        ("zzgl. 19 % MwSt", vat19, False),
        ("Rechnungsbetrag (brutto)", brutto, True),
    ]:
        c.setFont("Sans-Bold" if bold else "Sans", 10.5 if bold else 10)
        c.drawString(115 * mm, y, label)
        c.drawRightString(194 * mm, y, money(value))
        y -= 6.5 * mm
    c.setFont("Sans", 9)
    c.drawString(20 * mm, y - 8 * mm, "Zahlbar innerhalb von 14 Tagen ohne Abzug auf IBAN DE02 2005 0550 1234 5678 90.")
    c.drawString(20 * mm, y - 13 * mm, "Vielen Dank für Ihren Einkauf!")
    c.save()
    return {"brutto": brutto, "pieces": pieces, "brutto_7": round(by_rate[7], 2)}


# ------------------------------------------------------------- Prüfbericht
def scribble(c, x, y, seed, width=52 * mm):
    """Unterschrift: schleifenreiche Schreibschrift-Linie mit hohem Anfangsbuchstaben und Schwung nach unten rechts."""
    rnd = random.Random(seed)
    c.setStrokeColor(INK)
    c.setLineCap(1)
    c.setLineJoin(1)
    omega = rnd.uniform(34, 42)
    steps = 600
    pts = []
    for i in range(steps + 1):
        t = i / steps
        env = (1.0 if t < 0.18 else 0.55 + 0.25 * math.sin(t * 9 + seed)) * (1 - 0.5 * t)
        px = x + t * width + 3.0 * mm * math.cos(omega * t) * (0.6 + 0.4 * env)
        py = y + (3 + 9 * env) * mm * (0.5 + 0.5 * math.sin(omega * t)) + 1.2 * mm * math.sin(t * 5 + seed)
        pts.append((px, py))
    c.setLineWidth(1.25)
    p = c.beginPath()
    p.moveTo(*pts[0])
    for pt in pts[1:]:
        p.lineTo(*pt)
    c.drawPath(p, stroke=1, fill=0)
    # Schwung unter dem Namen
    c.setLineWidth(0.9)
    q = c.beginPath()
    q.moveTo(x + width * 0.05, y + 1.2 * mm)
    q.curveTo(x + width * 0.4, y - 1.5 * mm, x + width * 0.8, y + 2.2 * mm, x + width * 1.02, y + 0.4 * mm)
    c.drawPath(q, stroke=1, fill=0)


def handwriting(c, x, y, text, size=15, seed=7):
    """Handschrift-Anmutung: kursive Schrift, jedes Zeichen leicht verdreht, versetzt und unterschiedlich groß."""
    rnd = random.Random(seed)
    c.setFillColor(INK)
    cx = x
    for ch in text:
        c.saveState()
        s = size * rnd.uniform(0.93, 1.08)
        c.translate(cx, y + rnd.uniform(-1.1, 1.1))
        c.rotate(rnd.uniform(-5, 5))
        c.setFont("Hand", s)
        c.drawString(0, 0, ch)
        c.restoreState()
        cx += pdfmetrics.stringWidth(ch, "Hand", s) * rnd.uniform(0.96, 1.04)
    return cx


def report():
    c = canvas.Canvas(str(OUT / "pruefbericht.pdf"), pagesize=A4)
    c.setTitle("Prüfbericht PB-2026-0417")
    c.setFont("Sans-Bold", 18)
    c.drawString(20 * mm, H - 26 * mm, "Prüfbericht Bremsanlage")
    c.setFont("Sans", 10)
    c.drawString(20 * mm, H - 33 * mm, "Kfz-Meisterbetrieb Lindemann · Werkstattstraße 3 · 23552 Lübeck")
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.8)
    c.line(20 * mm, H - 37 * mm, 190 * mm, H - 37 * mm)

    rows = [
        ("Berichtsnummer", "PB-2026-0417"),
        ("Prüfdatum", "09.10.2026"),
        ("Fahrzeug", "Transporter, amtl. Kennzeichen HL-KL 2210"),
        ("Kilometerstand", "148.310 km"),
        ("Prüfumfang", "Bremsscheiben, Beläge, Bremsflüssigkeit, Leitungen"),
    ]
    y = H - 47 * mm
    for k, v in rows:
        c.setFont("Sans-Bold", 10)
        c.drawString(20 * mm, y, k + ":")
        c.setFont("Sans", 10)
        c.drawString(62 * mm, y, v)
        y -= 6.5 * mm

    y -= 4 * mm
    c.setFont("Sans-Bold", 10)
    c.drawString(20 * mm, y, "Prüfpunkte")
    y -= 7 * mm
    checks = [
        ("Bremsscheiben vorn", "i. O."),
        ("Bremsbeläge vorn", "i. O."),
        ("Bremsscheiben hinten", "i. O."),
        ("Bremsbeläge hinten", "Verschleißgrenze erreicht"),
        ("Bremsflüssigkeit (Siedepunkt)", "i. O."),
        ("Bremsleitungen", "i. O., siehe Anmerkung"),
    ]
    c.setFont("Sans", 10)
    for name, result in checks:
        c.drawString(24 * mm, y, name)
        c.drawString(100 * mm, y, result)
        c.setStrokeColor(colors.Color(0.85, 0.85, 0.85))
        c.line(20 * mm, y - 2 * mm, 190 * mm, y - 2 * mm)
        y -= 7 * mm

    y -= 6 * mm
    c.setFont("Sans", 10)
    c.drawString(20 * mm, y, "Gesamtergebnis: Fahrzeug verkehrssicher, Bremsbeläge hinten innerhalb von 14 Tagen ersetzen.")

    # Unterschriftenfelder
    y -= 30 * mm
    c.setStrokeColor(colors.black)
    c.setLineWidth(0.8)
    for x0, label, who, seed in [(20, "Prüfer", "Jens Brandt, Kfz-Meister", 11), (112, "Kunde (Abnahme)", "Katrin Vogel, Halterin", 23)]:
        c.line(x0 * mm, y, (x0 + 68) * mm, y)
        c.setFont("Sans", 8.5)
        c.drawString(x0 * mm, y - 4.5 * mm, f"{label}: {who}")
        scribble(c, (x0 + 4) * mm, y + 2.5 * mm, seed)

    # Handschriftlicher Hinweis unter dem Bericht
    y -= 22 * mm
    c.setFillColor(colors.black)
    c.setFont("Sans", 8.5)
    c.drawString(20 * mm, y, "Anmerkung des Prüfers (handschriftlich):")
    handwriting(c, 22 * mm, y - 9 * mm, "Bremsleitung vorne links: nach 500 km erneut", 16, 5)
    handwriting(c, 22 * mm, y - 17 * mm, "auf Dichtheit prüfen!", 16, 9)
    c.save()


def render(name):
    subprocess.run(["pdftoppm", "-png", "-r", "130", "-singlefile", str(OUT / f"{name}.pdf"), str(OUT / name)], check=True)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    print("Rechnung:", invoice())
    report()
    render("rechnung")
    render("pruefbericht")
    print("Geschrieben nach", OUT)
