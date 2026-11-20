/**
 * What a whole-file view loads before it asks, the same budgets as the shared
 * workspace viewers: an image, PDF or player renders from every byte and a text
 * view holds the whole string, so past these the page asks first. Uploads and
 * reads themselves have no total.
 */
export const WHOLE_FILE_PREVIEW_BYTES = 64 * 1024 * 1024;
export const WHOLE_TEXT_BYTES = 16 * 1024 * 1024;
/**
 * A canvas shows many thumbnails at once, so one loads by itself only within this
 * budget; past it the card offers to load it. The image itself has no size limit.
 */
export const THUMBNAIL_BUDGET_BYTES = 2 * 1024 * 1024;
