# DocPilot 1.0: Features and limitations

The interface consists of a menu bar, tabs, a tools pane on the left, quick tools on the side, a sidebar on the right and page controls at the bottom right.

## Fully implemented and tested in the app

| Area | Features |
|---|---|
| View | Tabs, zoom, single page, continuous, two-up, rotate view, reading mode, full screen, rulers, grid, hand tool, marquee zoom, snapshot, read out loud |
| Find | Search with result highlighting, advanced search with result list, whole words, match case |
| Comments | Highlight, underline, strikethrough, squiggly, replace text, insert text, sticky note, text box, callout, pencil, eraser, rectangle, ellipse, line, arrow, polygon, polyline, cloud, stamp, custom stamps, replies, status, comment list, XFDF, flatten. Everything is saved as a real PDF annotation. |
| Edit | Change text, move, resize and delete images, add text and images, links, crop, page size, header & footer, page numbers, watermark, background, Bates numbering, page labels |
| Pages | Move, rotate, delete, duplicate, insert, replace, extract, split, combine |
| Forms | Fill in, create all field types, required, read-only, export/import data (JSON), reset, flatten |
| Fill and sign | Fill in and sign, drawn/typed/image signature, initials, create digital ID, sign digitally, validate signatures |
| Protect | Password (AES-256), permissions, remove security, sanitize document, redact with search for text, IBAN, email, Swiss AHV numbers, phone numbers |
| Convert | Word, Excel, PowerPoint, PNG, JPEG, HTML, RTF, TXT. PDF from image, text, HTML, clipboard, Office files |
| Fonts | Like Word: all installed fonts (for all users and for the current user only) and the Office cloud fonts such as Aptos that Office has downloaded. Font list with theme fonts, recently used fonts and all fonts, each shown in its own typeface, type-ahead search. New text starts in Word's default font and size (from Word's Normal.dotm template, otherwise Aptos 11). If a font has no bold or italic style, it is synthesized like in Word. Fonts whose license forbids embedding are grayed out. Comments deliberately keep the standard font, without font choice. |
| Scans and text recognition | Scanned documents are detected when opened (offer "Recognize text", automatically, or never, in Preferences). PDFs created from an image, the scanner, the clipboard or a dropped image (e.g. a photographed invoice) are read immediately. Images with an A4 aspect ratio are set to A4. Recognized text is searchable and copyable, including text in images on normal pages. Under "Edit PDF" it can be changed, moved or deleted: the old letters are really removed from the image (table lines and colored backgrounds remain), and the new text appears in the same font, size and color. Everything runs offline on the PC. |
| Scanned invoices and tables | Table lines and separators (solid, dashed, dotted) are removed from the image before recognition, as is scanner noise; this way even the line directly below a rule is read correctly. Every table row, every number and every address line is its own block and stays separate when edited; only wrapped running text becomes a paragraph that reflows when changed. Numbers in right-aligned columns stay right-aligned when changed. Text of the same size gets the same size. Whatever recognition reads into logos and graphics is discarded. Scans that the scanner split into strips or tiles are treated as a whole page: the pieces are locked (no frames, no accidental moving), and when editing, the old letters are removed across strip boundaries too. Under "Scan & OCR", text that was already recognized can be recognized again, e.g. for scans from an older version. |
| Paste screenshots | Ctrl+V pastes an image from the clipboard (e.g. a screenshot taken with Win+Shift+S) in the middle of the visible page, at its original size or scaled down to fit the page. The text in it is recognized immediately. Without an open document, a new PDF is created. In input fields, Ctrl+V stays normal paste. Under "Edit PDF", the pasted screenshot behaves like an object: a click anywhere on it (including its text) selects the whole image, dragging moves it together with its recognized text, the corner resizes it, Del deletes it including its text. Double-clicking the text edits it. |
| Keep writing in screenshots | If recognized text in a pasted screenshot gets longer (new line with Enter, longer sentence), the editor makes room in the image: everything below moves down together with its recognized text and the image gets taller, like in Word. New text appears in the font, size and color of the image, including light text on a dark background. Enter at the end without further text does not add an empty line. |
| Screenshot recognition | Also light text on a dark background (dark mode). Bullets (•, ◦, ▪) and numbers are kept as separate characters, each item is its own paragraph, wrapped lines stay aligned. Bold lines are detected. The font of the image (e.g. Segoe UI, Arial, Calibri, Verdana, Times New Roman, Georgia) is detected from the word widths and used when editing. Multi-line paragraphs reflow like in Word when edited. The recognition resolution adapts to the image. Common misreadings are checked against the glyph shapes and corrected (± instead of +, umlauts, period and comma, i instead of 1). |
| Preferences | Structured by category (Ctrl+K): General, Documents, Units & Guides, Forms, Identity, Convert to PDF, JavaScript, Comment, Scan & OCR, Page Display, Read Out Loud, Find, Trust Manager (links, attachments) |
| Security | JavaScript in PDFs and macros during conversion are permanently blocked (see "IT policy" below). Attachments are never run. Links only open web pages and email, after confirmation. HTML is converted without JavaScript and without internet access. The program is hardened against misuse as a scripting tool (Electron fuses). |
| More | OCR (German, English, French, Italian), compress, compare, measure, bookmarks, attachments, layers, properties, open options, save document JavaScript |

## Limited

| Feature | Limitation |
|---|---|
| Edit text | Changed paragraphs are set again with the matching installed font (not with the embedded original font). If the PDF's font is not installed, a similar one is chosen. Text in nested objects is covered instead of removed. Reflow across columns is missing. |
| Fonts | Office cloud fonts can only be chosen once Office has downloaded them to the PC (Word downloads them on demand). Characters that a font does not contain appear as "?" (Word switches fonts automatically for these). Very large fonts (e.g. for Chinese) are embedded in full and make the PDF larger. |
| Edit recognized text | The font is chosen from the common Windows fonts; a rare font in the image is replaced with the closest match (it can be changed freely). Changed text is drawn more smoothly than the screen font of a screenshot. On photos, gradients or patterned backgrounds, the edited spot may be slightly visible. Handwriting is not recognized. Skewed photos are not straightened. Text stored in the PDF as vector graphics (not an image) is covered with the background color when edited. Room for additional lines is only made in pasted images; on full scanned pages (e.g. a scanned invoice with a table), longer text runs over the text below, because table lines in the image cannot move along. On full scanned pages, dragging moves individual paragraphs, not the image. A paragraph is only formed when the line break is certain (the next line starts with a lowercase letter, or the column has a confirmed text width); a short paragraph on its own whose lines all start with a capital letter stays as separate lines. |
| Text recognition | No text recognition is free of errors. In the tests with screenshots in seven fonts, 762 of 763 words were correct, all of them in the test invoice (scanned at 200 dpi), and all of the running text and the whole table in a recreated hotel invoice (skewed, blurry, noisy, split into strips). Lettering in logos (large, bold or gray text, text in emblems) is often not read or misread; recognition leaves out uncertain words instead of entering wrong ones. With very small, blurry or decorative fonts, individual letters can be confused (e.g. "rn" and "m"). So check briefly before passing documents on. |
| Export to Word/PowerPoint | Text and images are transferred. Tables come across as text; vector graphics are lost in editable mode. |
| Export to Excel | Columns are derived from text positions; complex tables need rework. |
| Redact | Affected pages are rebuilt as images. The remaining text stays searchable. |
| Digital signature | Only PFX/P12 files, no Windows certificate store, no timestamp. A second signature invalidates the first. Self-created IDs show as "identity unverified". |
| Signed documents | Any change invalidates the signature (the app warns). Existing comments are only visible there. |
| PDF/A | Sets the identification and an sRGB profile, without certified validation against the standard. |
| Accessibility | Check plus title and language, no automatic tagging. |
| Preflight | Report on fonts, colors, transparency, page boxes. No profiles and no fixes. |
| Compress | Only shrinks JPEG images and removes unused objects. |
| Compare | Text differences only, no visual diff. |
| Third-party stamps | Are displayed but cannot be moved. Stamps are not part of the XFDF exchange. |
| Office to PDF | Best quality with Office installed. Without Office, only simple conversion of .docx, .xlsx, .csv. |

## Not included

XFA forms, automatic form field detection, automated actions and batch processing, indexing, portfolios, rich media/3D, color conversion and trapping, cloud services (share, request signature).

## Not verified

- Installing the MSI on a machine (requires administrator rights). The MSI contents and the unpacked program were checked.
- Printing on a physical printer and scanning with a real scanner.
- Viewing the generated files in other PDF programs. Checks were done with PDF.js and the built-in signature validation.
- Documents from your daily work. Testing used generated test documents.

## Deployment

Silent installation: `msiexec /i DocPilot-1.0.1-x64.msi /qn`

If DocPilot is open while installing, updating or uninstalling, the MSI stops with the message "DocPilot is still open ..." (error code 1603) before anything is changed. Otherwise Windows would only replace program files on the next restart, which can damage the installation. When deploying with Intune or SCCM, the installation is simply retried later.

The MSI is not digitally signed. Without a code signing certificate, Windows shows warnings or AppLocker may block it. PDF is registered as a file type. IT sets DocPilot as the default app through a policy, because Windows does not allow an installer to do that.

For updates, increase the version in `package.json` and run `npm run dist`. The new MSI then replaces the old version.

## IT policy: JavaScript and macros

By default, JavaScript in PDF documents and macros when converting Office files are **permanently blocked**. The options in Preferences are grayed out ("Blocked by IT"). Even a manually edited settings file does not turn anything on.

Only IT can enable them, through Group Policy or the registry (administrator rights required):

| Key | Value | Type | Effect |
|---|---|---|---|
| `HKLM\SOFTWARE\Policies\DocPilot` | `AllowJavaScript` = 1 | DWORD | Users may turn on JavaScript in Preferences. It then runs isolated, without file or internet access. |
| `HKLM\SOFTWARE\Policies\DocPilot` | `AllowOfficeMacros` = 1 | DWORD | Users may allow macros during conversion. The macro settings of Office then apply. |

If the key is missing or has a value other than 1, everything stays blocked. The policy is read when the program starts.
