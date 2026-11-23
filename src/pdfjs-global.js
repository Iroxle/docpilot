// The PDF.js viewer components (for JavaScript in forms) expect the library as a global variable.
import * as pdfjs from 'pdfjs-dist/build/pdf.mjs';

globalThis.pdfjsLib = pdfjs;
