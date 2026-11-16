'use client';

/**
 * The office character spritesheet as a canvas (ADR 053), drawn from the shared pixel source
 * (packages/shared/src/office/avatar-art.ts). No image is fetched, so nothing depends on the CSP
 * or on a static file being deployed. Framework-free; used by the PixiJS renderer and the picker.
 */
import { renderAvatarSheet } from '@hrvo/shared';

/** A new canvas holding the whole sheet (the caller owns it). */
export function createAvatarSheetCanvas(): HTMLCanvasElement {
  const sheet = renderAvatarSheet();
  const canvas = document.createElement('canvas');
  canvas.width = sheet.width;
  canvas.height = sheet.height;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.putImageData(new ImageData(sheet.data as ImageDataArray, sheet.width, sheet.height), 0, 0);
  return canvas;
}

let shared: HTMLCanvasElement | null = null;
/** One sheet for every picker preview on the page (drawn on first use). */
export function sharedAvatarSheet(): HTMLCanvasElement {
  shared ??= createAvatarSheetCanvas();
  return shared;
}
