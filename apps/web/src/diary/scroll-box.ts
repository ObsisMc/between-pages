import { createContext, type RefObject } from 'react';

/**
 * The box the diaries below it scroll in, when it is not the window: the workspace's left
 * page, which scrolls apart from the right one (book-frontend-workspace D3). Read once, when
 * a diary's session opens.
 */
export const ScrollBox = createContext<RefObject<HTMLElement | null> | null>(null);
