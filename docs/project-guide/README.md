# Beginner project guide

[Open the 33-page PDF](../../output/pdf/memorae-project-guide.pdf).

This presentation-style guide explains the project through code baseline `f55fcfa` (M1-08), dated 2026-10-28. It covers the completed milestones, practical examples, architecture, all 23 application tables plus migration history, source layout, local demonstrations, verification limits and next steps. It makes no claim of live AI accuracy or operational reminder delivery.

`guide.json` is the editable page content. `scripts/build-project-guide.py` builds the PDF using Python, ReportLab and the Windows Arial/Consolas fonts. Run it from the repository root with a Python environment that has ReportLab installed:

```powershell
python scripts/build-project-guide.py
```

The PDF is checked into `output/pdf/`. It has 33 bookmarks and a linked contents page. Initial verification extracted text from every page, checked the page/bookmark count, and visually inspected all rendered pages plus a full-size database table. The generator rejects overflowing body/table content; re-render and review after content or layout changes.

The guide is a snapshot. For later changes, consult the code, migrations and current roadmap, then update the guide's date, baseline and evidence explicitly. Do not confuse proposed roadmap features with completed runtime behavior.
