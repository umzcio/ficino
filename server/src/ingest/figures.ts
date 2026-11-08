import type { ProviderConfig } from '../providers/config.js';
import type { ProviderDeps } from '../providers/deps.js';
import { detectFiguresOnPage, isFigureDetectAvailable } from '../providers/figureDetect.js';
import { logger } from '../logger.js';
import { mapLimit } from '../shared/mapLimit.js';
import { extractPagesText, openRenderedPage, pageCount, type PdfCheckpoint, type PdfDoc } from './pdf.js';

// Port of worker/lib/pdf_extractor.py extract_figures.

/** Per-paper cap on typed figures kept (a crafted PDF could otherwise bill unbounded downstream work). */
const MAX_FIGURES_PER_PAPER = 50;
/** Detections cropped per page; a real page holds a handful (multi-panel figures come back as one). */
const MAX_FIGURES_PER_PAGE = 20;
/**
 * Total crop pixels per paper. 50 full-page crops of a letter or A4 page at 150 dpi fit, so the figure cap binds
 * first on ordinary pages; on oversized pages (renders up to 25 MP) this bounds the crop memory held.
 */
const MAX_CROP_PIXELS_PER_PAPER = 120_000_000;
/** Fraction of the page added around each detected bbox: VLM boxes often clip axis labels and caption lines. */
const FIGURE_CROP_PADDING_RATIO = 0.04;
const DETECT_DPI = 150;
const DETECT_CONCURRENCY = 4;

export type ExtractedFigure = {
  page: number;
  filename: string;
  image_bytes: Uint8Array;
  extraction_type: 'vlm_detected';
  width: number;
  height: number;
  figure_index: number;
  figure_type: string;
  caption: string;
  figure_number: string;
  data_claim: string;
  referenced_paragraph: string;
  bbox: { page: number; x0: number; y0: number; x1: number; y1: number };
  detector_confidence: number;
};

type PageFigure = Omit<ExtractedFigure, 'filename' | 'figure_index'>;

/** Default for `extractFigures`'s `maxPages` (the worker passes `FIGURE_DETECT_MAX_PAGES`). */
export const DEFAULT_FIGURE_DETECT_MAX_PAGES = 60;

/**
 * Detect typed scientific figures with a vision model and crop them. Each page is rendered once at
 * 150 dpi, detected, and cropped right away (up to 4 pages in flight), so only the crops stay in memory.
 * Pages are detected concurrently but cropped in page order, so the paper-wide budget (50 figures, 120 MP of
 * crops) is spent while cropping: no crop is made past it, and no page starts once it is spent.
 * Only the first `maxPages` pages are read and sent to the detector. `checkpoint` runs before each page's text
 * is read and before each page is rendered; it throws to stop the job (as `signal` does between awaits).
 */
export async function extractFigures(
  doc: PdfDoc,
  p: ProviderConfig,
  deps: ProviderDeps,
  signal?: AbortSignal,
  { maxPages = DEFAULT_FIGURE_DETECT_MAX_PAGES, checkpoint }: { maxPages?: number; checkpoint?: PdfCheckpoint } = {},
): Promise<ExtractedFigure[]> {
  if (!isFigureDetectAvailable(p)) {
    logger.warn('figure_detector_unavailable_skipping_figures');
    return [];
  }
  const total = pageCount(doc);
  const count = Math.min(total, maxPages);
  if (total > count) logger.warn({ pages: total, cap: maxPages }, 'figure_detect_page_cap_hit');
  const texts = extractPagesText(doc, undefined, { pages: count, checkpoint });

  // A failed page must not reject while other pages are still using `doc`: the caller closes it right
  // after (a WASM use-after-free otherwise). So every page settles first, no new page starts after a
  // failure, and the first error (or the abort reason, keeping its identity) is rethrown at the end.
  let failure: { error: unknown } | undefined;
  // `cropped[i]` settles once page i has cropped (or failed, or was skipped); page i + 1 crops only after it.
  const cropped = Array.from({ length: count }, () => {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
  });
  let kept = 0;
  let pixels = 0;
  let spent = false;
  const perPage = await mapLimit(
    Array.from({ length: count }, (_, i) => i),
    DETECT_CONCURRENCY,
    async (i): Promise<PageFigure[]> => {
      try {
        if (failure || spent) return [];
        return await detectAndCropPage(i);
      } catch (error) {
        failure ??= { error };
        return [];
      } finally {
        cropped[i]!.resolve();
      }
    },
  );
  if (failure) throw signal?.aborted ? signal.reason : failure.error;

  function spend(page: number, event: string, fields: Record<string, number>): void {
    if (!spent) logger.warn({ page, ...fields }, event);
    spent = true;
  }

  async function detectAndCropPage(i: number): Promise<PageFigure[]> {
    signal?.throwIfAborted();
    checkpoint?.();
    const page = openRenderedPage(doc, i, DETECT_DPI);
    try {
      const detections = await detectFiguresOnPage(p, deps, page.png, i + 1, texts[i] ?? '', signal);
      if (detections.length > MAX_FIGURES_PER_PAGE)
        logger.warn({ page: i + 1, detected: detections.length, cap: MAX_FIGURES_PER_PAGE }, 'figure_detect_page_capped');
      // Indices follow page order, so every earlier page spends the budget first.
      if (i > 0) await cropped[i - 1]!.promise;
      const found: PageFigure[] = [];
      for (const det of detections.slice(0, MAX_FIGURES_PER_PAGE)) {
        if (spent) break;
        if (kept >= MAX_FIGURES_PER_PAPER) {
          spend(i + 1, 'figure_extract_capped', { cap: MAX_FIGURES_PER_PAPER });
          break;
        }
        const [x0, y0, x1, y1] = det.bbox;
        const pad = FIGURE_CROP_PADDING_RATIO;
        const box: [number, number, number, number] = [
          Math.trunc(Math.max(0, x0 - pad) * page.width),
          Math.trunc(Math.max(0, y0 - pad) * page.height),
          Math.trunc(Math.min(1, x1 + pad) * page.width),
          Math.trunc(Math.min(1, y1 + pad) * page.height),
        ];
        if (box[2] <= box[0] || box[3] <= box[1]) {
          logger.warn({ page: i + 1, bbox: det.bbox }, 'figure_crop_empty_skipped');
          continue;
        }
        const area = (box[2] - box[0]) * (box[3] - box[1]);
        if (pixels + area > MAX_CROP_PIXELS_PER_PAPER) {
          spend(i + 1, 'figure_crop_pixel_budget_hit', { pixels, cap: MAX_CROP_PIXELS_PER_PAPER });
          break;
        }
        const crop = page.crop(box);
        kept++;
        pixels += area;
        found.push({
          page: i + 1,
          image_bytes: crop.png,
          extraction_type: 'vlm_detected',
          width: crop.width,
          height: crop.height,
          figure_type: det.type,
          caption: det.caption,
          figure_number: det.figure_number,
          data_claim: det.data_claim,
          referenced_paragraph: det.referenced_paragraph,
          bbox: { page: i + 1, x0, y0, x1, y1 },
          detector_confidence: det.confidence,
        });
        logger.info(
          {
            page: i + 1,
            type: det.type,
            figureNumber: det.figure_number || '?',
            size: `${crop.width}x${crop.height}`,
          },
          'figure_extracted',
        );
      }
      if (kept >= MAX_FIGURES_PER_PAPER && i + 1 < count)
        spend(i + 1, 'figure_extract_capped', { cap: MAX_FIGURES_PER_PAPER });
      return found;
    } finally {
      page.dispose();
    }
  }

  // Indices and filenames follow page order, assigned once every page is done.
  const figures: ExtractedFigure[] = perPage.flat().map((f, figure_index) => ({
    ...f,
    filename: `fig_p${f.page}_${figure_index}.png`,
    figure_index,
  }));
  logger.info({ count: figures.length }, 'figure_extract_complete');
  return figures;
}
