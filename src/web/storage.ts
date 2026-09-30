/**
 * Where the browser remembers which project was last open.
 *
 * A tiny, isolated module so the storage access has one definition and can fail quietly.
 * `localStorage` throws in a blocked storage partition and in some private-browsing modes,
 * and remembering the last project is a convenience — never a reason to fail the app.
 */

export const PROJECT_ID_STORAGE_KEY = 'subtitle-studio.projectId';
