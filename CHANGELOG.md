# Changelog

All notable changes to DocPilot are listed here, newest first.

## 1.2.0 (2026-11-27)

### New

- **New look: tabs in the title bar.** One bar at the top holds the tabs, the menu (☰, also with Alt or F10) and a
  search field for all tools and commands (Ctrl+Shift+P); the window buttons match the light or dark appearance. On a
  Mac the three window buttons sit at the left of the bar and the menu stays in the macOS menu bar.
- **New home page:** drop a PDF on the large area or open one; recent files appear as pictures of their first page
  (the full path shows when the mouse rests on a picture, right-click to remove one); compact, colored tiles lead to
  the main tools.
- **Tools pane:** every tool group has a color of its own, a search field at the top filters groups and tools while
  typing (Enter runs the first one), and the pane slides in and out instead of disappearing at once.
- **Change or remove header and footer, watermark, background and Bates numbers.** When a document already has
  them, the tool offers Update (the dialog opens with the settings they were made with), Remove, or Add another.
  They are stored as marks of their own in the page, so removing them leaves the page content as it was.
  Watermarks can lie behind the page content.
- **Reverse pages** (Organize pages, also for the selected thumbnails) and **Set page boxes** (crop, bleed, trim,
  art and media box from margins, or back to their default) under Print production.
- **Export all images** (JPEG images unchanged, other images as PNG with their transparency, each image once) and
  **export as Markdown** (headings from the font size, bold and italic, lists and tables).
- **Print several pages per sheet** (2, 4, 6, 9 or 16, in rows or columns, with page borders), **booklets** (bound on
  the left or right, both sides or one side at a time), **custom scale** and **shrink oversized pages**, paper size,
  reverse order, and **print form fields only**.
- **Print production:** convert to grayscale (text, graphics, images, comments), fix hairlines (lines thinner than a
  printer holds get a chosen width), and printer marks (trim and bleed marks, registration targets, colour bars and
  page information; the page grows to make room, the trim box stays; can be updated or removed later).
- **Measure:** the measure tools snap to the end points, middles and crossings of the lines on the page, and to the
  lines themselves (can be turned off). Measurements can be exported as a CSV file.
- **Fill and sign:** new "Line" tool.
- **Create PDF from several files as separate PDFs**, one PDF per file in a chosen folder.
- **Reopen closed tab** (Ctrl+Shift+T), **Show in Explorer** (File menu and tab menu), **Search commands**
  (Ctrl+Shift+P: every tool and command by name), **search bookmarks**, **adjustable thumbnail size**, and the
  **fonts of the document** (type and embedding) in Document properties.
- **Recovery after a crash:** documents with unsaved changes are copied every few minutes (Preferences > Documents)
  and offered for recovery when DocPilot was not closed properly. Password-protected documents are not copied.
- **Accessibility:** "Automatically tag document" gives untagged PDFs a structure (headings and paragraphs from the
  size and weight of the text, figures, decoration marked as such, form fields and links). New Tags panel (change a
  tag's type and alternate text), "Alternate text for images" with a picture of every image, "Tag form fields and
  links", and a full accessibility check of 32 rules with a fix button where DocPilot has one.
- **Scan & OCR:** recognize text in several files at once (saved as searchable PDFs in a folder), enhance scanned
  pages (white paper, stronger contrast, fewer specks, or black and white; recognized text stays), straighten phone
  photos of documents (the sheet's corners are found and can be moved), and review recognized text: the uncertain
  words with their picture, to correct them.
- **Action wizard:** run a sequence of steps (recognize text, enhance scans, reduce file size, remove hidden
  information, flatten, watermark, header, footer, title, grayscale, hairlines, tagging, PDF/A) on several files.
  Six actions are built in; your own actions are saved.
- **XFA forms** are converted into normal pages and form fields with their data, so they can be filled in, saved and
  printed anywhere. DocPilot offers this when such a form is opened.

### Improved

- Finer details everywhere: the same rounded corners and spacing, softer shadows, thin scroll bars, a sidebar on the
  right that slides in and out, and panels without content (comments, bookmarks, attachments, layers, signatures,
  tags, search results) say what to do.
- Options that are blocked for security reasons (JavaScript in PDFs, macros in Office files) simply say "Blocked".
- Dark appearance: text on buttons in the accent color is dark, so it is easy to read.
- **Edit PDF: the text field looks like the result.** In a paragraph with columns or mixed formats (e.g. a bold
  label and its value), every part keeps its font, weight, size, color and place while typing, and the paragraph is
  set exactly as shown. Parts that stay unchanged keep their original glyphs (bullets, spacing). Select a word and
  press Bold, Italic or another format to change only that word; Ctrl+Z undoes typing in the field; Tab jumps to the
  next column.

### Fixed

- **Edit PDF: edited text no longer disappears.** In a document that had been edited and saved before, changing
  one line of a paragraph could remove the other lines of that paragraph.
- **Check boxes and radio buttons in PDF forms** show again whether they are checked, also right after a click. In
  1.1.0 they looked empty, although the value was saved. Page thumbnails show the current values of the form fields.
- Detect fields automatically: labels in letter-spaced type ("F U L L  N A M E") give the field name "FULL NAME".
- The page range fields showed the example in German ("z.B. 1-3, 5"), and Advanced search had a German option name.
- Sanitize document: the option for links was labelled "Left".

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
