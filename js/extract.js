// Extract plain text from an uploaded file, in the browser.
// The original file never leaves the device; only redacted text is indexed.

const PDFJS = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const MAMMOTH = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

const loaded = {};
function loadScript(src) {
  if (!loaded[src]) {
    loaded[src] = new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.onload = resolve;
      el.onerror = () => reject(new Error(`Could not load ${src.split('/').pop()}`));
      document.head.appendChild(el);
    });
  }
  return loaded[src];
}

export const ACCEPT = '.txt,.md,.csv,.json,.pdf,.docx';

export async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) {
    await loadScript(PDFJS);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    const pdf = await window.pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, 200); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((it) => it.str).join(' '));
    }
    return pages.join('\n\n');
  }
  if (name.endsWith('.docx')) {
    await loadScript(MAMMOTH);
    const out = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return out.value;
  }
  if (/\.(txt|md|csv|json)$/.test(name)) return file.text();
  throw new Error('Supported files: PDF, Word (.docx), text, Markdown, CSV and JSON.');
}
