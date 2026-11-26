# Changelog

All notable changes to DocPilot are listed here, newest first.

## 1.1.0 (2026-11-26)

### New

- **DocPilot for Mac.** Disk images for Macs with Apple silicon and with Intel processors (macOS 12 or later),
  with the same features as on Windows. Keyboard shortcuts use ⌘, the DocPilot menu works like in other Mac apps,
  Office files are converted with Microsoft Office for Mac, and "PDF from scanner" opens the macOS scanner window.
  The first start needs one confirmation in System Settings (see the README).
- **Real redaction.** "Apply redactions" removes the text, image pixels and graphics under the marks from the file
  and leaves the rest of the page as it was: text stays sharp, selectable and searchable instead of the page becoming
  an image. Images that are partly covered keep their uncovered part, comments, links and form fields over a mark go,
  and document information that repeats the removed text is removed too. Before anything changes, the result is
  checked twice (with DocPilot's own reader and with PDF.js); if anything is left under a mark, nothing is changed.
  New "Redaction properties": box colour (or no box), overlay text, its colour, size and alignment.
- **Reduce file size.** Images are reduced to the resolution at which the pages actually show them (Standard: 150 ppi,
  Mobile: 96 ppi, High quality: 300 ppi), black-and-white scans are stored as CCITT Group 4, and unused images,
  page thumbnails, invalid links and uncompressed data are cleaned up. "Advanced optimization" offers every setting,
  including discarding tags, form actions, print settings and links to other documents.

- **Forms calculate and format without JavaScript.** Number, percentage, date, time and special formats, value
  ranges and calculations (sum, product, average, minimum, maximum, and expressions such as "Quantity * Price") work
  while filling in, while JavaScript stays blocked. New under "Prepare form": Field properties (format, value range,
  calculation), Calculation order, Tab order, Date field, Image field (a click chooses the picture) and Text field
  table. Form data can be exported and imported as XFDF, FDF, XML, CSV, tab-delimited text and JSON.
- **Saving keeps the original.** Saving to the same file appends the changes and leaves the original bytes as they
  are. Signed documents can be filled in, commented and signed again: earlier signatures stay valid. New: Certify
  with a visible or invisible signature, choosing which changes stay allowed. The Signatures panel says for every
  signature what changed after it and whether that is permitted.
- **PDF/A checked and converted.** "Save as PDF/A" checks the document against PDF/A-2b or PDF/A-3b, fixes what can be
  fixed without changing the pages (identification, colour profile, scripts and actions, comment flags and
  appearances, image settings) and lists what remains, such as fonts that are not embedded. New: "Check PDF/A
  compliance" under Print production.

### Improved

- **Combine, insert, extract and split keep everything.** Bookmarks, links within the document (also to named
  destinations), form fields, layers, attachments and page labels come along. When combining, every file gets a
  bookmark with its own bookmarks below it, form fields with the same name in different files are renamed so they
  stay separate, and fonts and images that the files share are stored only once. Duplicated pages share their form
  fields with the original page.

### Fixed

- Text added with "Add text" on an existing line now stays its own text block and can be moved on its own
  (it was merged with the line when the Office font Aptos was not installed).
- Two submenus in the View menu are now labeled in English ("Show/Hide", "Pause/Resume").
- Form data export and import, "Reset form" and the field list recognise every field type again in the installed
  program.
- Edit PDF: a moved paragraph stays exactly as it was, in the same font, size and spacing. Before, it was set
  again in a similar installed font.
- Edit PDF: label and value columns (e.g. the details at the top of an invoice) are one block instead of frames
  inside each other. Moving them no longer leaves values behind or loses them, and changing a value keeps the font,
  size, weight and place of every cell.
- Edit PDF: hyphens, dashes, colons and parentheses that some PDFs (e.g. from Chrome) store without a character
  no longer turn into "?" when the text is edited.
- Edit PDF: new text placed on an existing line stays a block of its own in every font.

### Security

- Updated the built-in browser engine (Electron 45.5.0) with the latest security fixes.

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
