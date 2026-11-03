import type { ProviderConfig } from '../providers/config.js';
import type { ProviderDeps } from '../providers/deps.js';
import { detectFiguresOnPage, isFigureDetectAvailable } from '../providers/figureDetect.js';
import { logger } from '../logger.js';
import { mapLimit } from '../shared/mapLimit.js';
import { extractPagesText, openRenderedPage, pageCount, type PdfDoc } from './pdf.js';

// Port of worker/lib/pdf_extractor.py extract_figures.

/** Per-paper cap on typed figures kept (a crafted PDF could otherwise bill unbounded downstream work). */
const MAX_FIGURES_PER_PAPER = 50;
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

/**
 * Detect typed scientific figures with a vision model and crop them. Each page is rendered once at
 * 150 dpi, detected, and cropped right away (up to 4 pages in flight), so only the crops stay in memory.
 */
export async function extractFigures(
  doc: PdfDoc,
  p: ProviderConfig,
  deps: ProviderDeps,
  signal?: AbortSignal,
): Promise<ExtractedFigure[]> {
  if (!isFigureDetectAvailable(p)) {
    logger.warn('figure_detector_unavailable_skipping_figures');
    return [];
  }
  const count = pageCount(doc);
  const texts = extractPagesText(doc);

  // A failed page must not reject while other pages are still using `doc`: the caller closes it right
  // after (a WASM use-after-free otherwise). So every page settles first, no new page starts after a
  // failure, and the first error (or the abort reason, keeping its identity) is rethrown at the end.
  let failure: { error: unknown } | undefined;
  const perPage = await mapLimit(
    Array.from({ length: count }, (_, i) => i),
    DETECT_CONCURRENCY,
    async (i): Promise<PageFigure[]> => {
      if (failure) return [];
      try {
        return await detectAndCropPage(i);
      } catch (error) {
        failure ??= { error };
        return [];
      }
    },
  );
  if (failure) throw signal?.aborted ? signal.reason : failure.error;

  async function detectAndCropPage(i: number): Promise<PageFigure[]> {
    signal?.throwIfAborted();
    const page = openRenderedPage(doc, i, DETECT_DPI);
    try {
      const detections = await detectFiguresOnPage(p, deps, page.png, i + 1, texts[i] ?? '', signal);
      const found: PageFigure[] = [];
      // Later detections can never survive the global cap (indices follow page order), so don't crop them.
      for (const det of detections.slice(0, MAX_FIGURES_PER_PAPER)) {
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
        const crop = page.crop(box);
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
      return found;
    } finally {
      page.dispose();
    }
  }

  // Indices and filenames follow page order, assigned once every page is done.
  let figures: ExtractedFigure[] = perPage.flat().map((f, figure_index) => ({
    ...f,
    filename: `fig_p${f.page}_${figure_index}.png`,
    figure_index,
  }));
  if (figures.length > MAX_FIGURES_PER_PAPER) {
    logger.warn({ extracted: figures.length, cap: MAX_FIGURES_PER_PAPER }, 'figure_extract_capped');
    figures = figures.slice(0, MAX_FIGURES_PER_PAPER);
  }
  logger.info({ count: figures.length }, 'figure_extract_complete');
  return figures;
}
