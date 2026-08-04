/** Test-only hooks installed into the page by `page.evaluate`. */
declare global {
  interface Window {
    /** Text of every element clicked, recorded by the actions tests. */
    __clicks: string[];
    /** Where the cursor overlay was drawn when the target received `mouseover`. */
    __hoverCursorAt: { x: number; y: number } | null;
  }
}

export {};
