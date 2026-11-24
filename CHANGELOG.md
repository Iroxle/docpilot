# Changelog

All notable changes to DocPilot are listed here, newest first.

## 1.0.2 (2026-11-24)

### New

- **Find and replace.** The find bar (Ctrl+F) has a "Replace with" row, also reachable with Ctrl+Shift+H.
  "Replace" changes the highlighted result, "Replace all" changes the whole document in a single undo step
  and reports what could not be replaced. Text is really replaced in the page content: font, size and color
  stay, and paragraphs reflow. It also works for recognized text in scans.
- **Detect form fields automatically.** Under "Prepare form", DocPilot finds lines, underscores, empty boxes,
  table cells, check boxes, radio buttons and signature lines, names the fields after their labels and shows
  them as a preview. Fields are only created after you confirm. Works for scanned forms too.
- **Real tables in exports.** Tables arrive in Word, Excel and PowerPoint as real tables, including merged cells
  and alignment. In Excel, numbers and dates are real values. Tables are detected from drawn lines and, for
  tables without lines, from the alignment of the text.
- **Skewed scans.** Skewed pages are straightened for text recognition, and the recognized text lies exactly
  over the image. "Straighten page" under "Scan & OCR" rotates the image itself straight, with a preview and an
  angle you can adjust by hand. A new preference straightens scans automatically when recognizing text.
- **Dark appearance.** Preferences > General > Appearance: Light (default), Dark or Same as Windows. PDF pages
  stay white like paper. The change takes effect immediately.
- **More ways to install.** Besides the MSI there is now a setup program that installs without administrator
  rights and a portable version that runs without installation. All three are on the releases page.

### Fixed

- A sticky note window no longer stays open after its document is closed.
- The "Match case" option in the find bar is now labeled in English.

See [FEATURES.md](FEATURES.md) for details and known limitations of the new features.

## 1.0.1 (2026-11-23)

First public release.

- View, edit, comment on and sign PDFs; forms, digital signatures, redaction, password protection.
- Export to Word, Excel, PowerPoint, images, HTML and text; create PDFs from images, Office files and the scanner.
- Offline text recognition (German, English, French, Italian) with editing of recognized text in the image.
- Clean recognition and editing of scans with tables, logos and image strips.
