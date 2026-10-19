import { parseJobPostingText } from './job-text-parser.js';

export class ScreenshotExtractionError extends Error {
  constructor(category, httpStatus = null) {
    super(`SCREENSHOT_OCR_${category.toUpperCase()}`);
    this.name = 'ScreenshotExtractionError';
    this.category = category;
    this.httpStatus = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  }
}

function readOcrText(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.ParsedResults)) return null;
  if (payload.IsErroredOnProcessing === true || ![1, 2].includes(Number(payload.OCRExitCode))) return null;
  const text = payload.ParsedResults.map((result) => typeof result?.ParsedText === 'string' ? result.ParsedText.trim() : '')
    .filter(Boolean).join('\n\n');
  return text || null;
}

export function createScreenshotExtractor(config, { fetchImpl = fetch } = {}) {
  const configured = Boolean(config.screenshotOcrUrl && config.screenshotOcrApiKey);
  return {
    configured,
    async extract(images) {
      if (!config.screenshotOcrUrl || !config.screenshotOcrApiKey) throw new ScreenshotExtractionError('configuration_missing');
      let endpoint;
      try { endpoint = new URL(config.screenshotOcrUrl); }
      catch { throw new ScreenshotExtractionError('configuration_invalid'); }
      if (!['https:', 'http:'].includes(endpoint.protocol) || (config.nodeEnv === 'production' && endpoint.protocol !== 'https:')) {
        throw new ScreenshotExtractionError('configuration_invalid');
      }
      if (!Array.isArray(images) || images.length === 0) throw new ScreenshotExtractionError('invalid_request');

      const recognized = [];
      for (const image of images) {
        const form = new FormData();
        form.set('language', 'eng');
        form.set('isOverlayRequired', 'false');
        const extension = image.mimeType === 'image/png' ? 'png' : 'jpg';
        form.set('file', new Blob([image.buffer], { type: image.mimeType }), `screenshot.${extension}`);
        let response;
        try {
          response = await fetchImpl(endpoint, { method: 'POST', headers: { apikey: config.screenshotOcrApiKey }, body: form });
        } catch {
          throw new ScreenshotExtractionError('network_error');
        }
        if (!response?.ok) throw new ScreenshotExtractionError('http_error', response?.status);
        let payload;
        try { payload = await response.json(); }
        catch { throw new ScreenshotExtractionError('invalid_json', response.status); }
        const text = readOcrText(payload);
        if (!text) throw new ScreenshotExtractionError('provider_response_error', response.status);
        recognized.push(text);
      }

      // OCR.space provides recognized text only. Parse labeled values locally,
      // retain the complete evidence, and leave absent or conflicting fields blank.
      const combinedText = recognized.join('\n\n--- Screenshot ---\n\n').slice(0, 8000);
      return { ...parseJobPostingText(combinedText), provider: 'ocr.space' };
    },
  };
}
