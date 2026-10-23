// Adapted from Inferrum. Licensed under Apache-2.0; see LICENSE-Inferrum.txt.
type Point = { x: number; y: number };

// Keep native scrolling while adding direct manipulation and cursor-anchored zoom.
export function attachDiagramNavigation(
  viewport: HTMLDivElement,
  diagram: SVGSVGElement,
  fitButton: HTMLButtonElement,
  actualButton: HTMLButtonElement,
  zoomIn: HTMLButtonElement,
  zoomOut: HTMLButtonElement,
) {
  const { width, height } = diagram.viewBox.baseVal;
  let zoom = 1;
  let fitted = false;
  let suppressClick = false;
  let dragging = false;
  let panScroll: Point = { x: 0, y: 0 };
  let lastPointer: Point | undefined;
  const pointers = new Map<number, { start: Point; point: Point }>();
  let previousGesture: ReturnType<typeof gesture>;

  function center() {
    const rect = viewport.getBoundingClientRect();
    return { x: rect.left + viewport.clientLeft + viewport.clientWidth / 2, y: rect.top + viewport.clientTop + viewport.clientHeight / 2 };
  }

  function fitZoom() {
    return Math.min(1, viewport.clientWidth / width, viewport.clientHeight / height) || 1;
  }

  function setZoom(value: number, anchor = center(), fit = false) {
    const before = diagram.getBoundingClientRect();
    const point = { x: (anchor.x - before.left) / zoom, y: (anchor.y - before.top) / zoom };
    zoom = Math.max(Math.min(0.1, fitZoom()), Math.min(4, value));
    fitted = fit;
    diagram.setAttribute('width', String(width * zoom));
    diagram.setAttribute('height', String(height * zoom));
    const after = diagram.getBoundingClientRect();
    viewport.scrollLeft += after.left + point.x * zoom - anchor.x;
    viewport.scrollTop += after.top + point.y * zoom - anchor.y;
    fitButton.setAttribute('aria-pressed', String(fitted));
    actualButton.setAttribute('aria-pressed', String(Math.abs(zoom - 1) < 0.001));
  }

  function centerOn(element: SVGGraphicsElement | undefined) {
    if (!element || !viewport.clientWidth) return;
    const target = element.getBoundingClientRect(), bounds = viewport.getBoundingClientRect();
    viewport.scrollLeft += target.left - bounds.left - viewport.clientLeft - (viewport.clientWidth - target.width) / 2;
    viewport.scrollTop += target.top - bounds.top - viewport.clientTop - (viewport.clientHeight - target.height) / 2;
  }

  function fitMap() { setZoom(fitZoom(), center(), true); }
  function actualSize() {
    setZoom(1);
    centerOn(diagram.querySelector<SVGAElement>('[aria-current="true"]') ?? undefined);
  }
  fitButton.addEventListener('click', fitMap);
  actualButton.addEventListener('click', actualSize);
  zoomIn.addEventListener('click', () => setZoom(zoom * 1.2));
  zoomOut.addEventListener('click', () => setZoom(zoom / 1.2));
  new ResizeObserver(() => { if (fitted && viewport.clientWidth) fitMap(); }).observe(viewport);

  // Chromium and Firefox expose trackpad pinch as Ctrl+wheel. Regular wheel
  // events retain native scrolling and momentum; browser zoom outside stays native.
  viewport.addEventListener('wheel', event => {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (safariGestureZoom !== undefined) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1;
    setZoom(zoom * Math.exp(-event.deltaY * unit * 0.01), { x: event.clientX, y: event.clientY });
  }, { passive: false });

  // Safari uses GestureEvent for trackpad pinch instead of Ctrl+wheel.
  let safariGestureZoom: number | undefined;
  function gestureAnchor(event: Event) {
    const bounds = viewport.getBoundingClientRect();
    if ('clientX' in event && typeof event.clientX === 'number' && 'clientY' in event && typeof event.clientY === 'number'
      && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
      return { x: event.clientX, y: event.clientY };
    }
    return lastPointer ?? center();
  }
  viewport.addEventListener('gesturestart', event => {
    event.preventDefault();
    safariGestureZoom = zoom;
  }, { passive: false });
  viewport.addEventListener('gesturechange', event => {
    event.preventDefault();
    if (safariGestureZoom !== undefined && 'scale' in event && typeof event.scale === 'number' && event.scale > 0) {
      setZoom(safariGestureZoom * event.scale, gestureAnchor(event));
    }
  }, { passive: false });
  viewport.addEventListener('gestureend', event => { event.preventDefault(); safariGestureZoom = undefined; });

  function gesture() {
    const [first, second] = [...pointers.values()];
    if (!first) return undefined;
    if (!second) return { midpoint: first.point, distance: 0 };
    return {
      midpoint: { x: (first.point.x + second.point.x) / 2, y: (first.point.y + second.point.y) / 2 },
      distance: Math.hypot(first.point.x - second.point.x, first.point.y - second.point.y),
    };
  }

  viewport.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' && (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey)) return;
    if (!pointers.size) {
      suppressClick = false; dragging = false;
      panScroll = { x: viewport.scrollLeft, y: viewport.scrollTop };
    }
    const point = { x: event.clientX, y: event.clientY };
    pointers.set(event.pointerId, { start: point, point });
    if (pointers.size > 1) suppressClick = dragging = true;
    previousGesture = gesture();
  });
  viewport.addEventListener('pointermove', event => { lastPointer = { x: event.clientX, y: event.clientY }; });
  window.addEventListener('pointermove', event => {
    const pointer = pointers.get(event.pointerId);
    if (!pointer) return;
    pointer.point = { x: event.clientX, y: event.clientY };
    if (!dragging && Math.hypot(pointer.point.x - pointer.start.x, pointer.point.y - pointer.start.y) < 5) return;
    event.preventDefault();
    suppressClick = dragging = true;
    viewport.classList.add('dragging');
    // Capture after crossing the drag threshold, so ordinary rule clicks keep
    // their original target and keyboard focus.
    if (!viewport.hasPointerCapture(event.pointerId)) viewport.setPointerCapture(event.pointerId);
    const next = gesture();
    if (previousGesture && next) {
      if (previousGesture.distance > 0 && next.distance > 0) {
        setZoom(zoom * next.distance / previousGesture.distance, previousGesture.midpoint);
        panScroll = { x: viewport.scrollLeft, y: viewport.scrollTop };
      }
      // Retain fractional movement instead of accumulating native scroll rounding.
      panScroll = {
        x: Math.max(0, Math.min(viewport.scrollWidth - viewport.clientWidth, panScroll.x - next.midpoint.x + previousGesture.midpoint.x)),
        y: Math.max(0, Math.min(viewport.scrollHeight - viewport.clientHeight, panScroll.y - next.midpoint.y + previousGesture.midpoint.y)),
      };
      viewport.scrollLeft = panScroll.x;
      viewport.scrollTop = panScroll.y;
    }
    previousGesture = next;
  }, { passive: false });
  function endPointer(event: PointerEvent) {
    pointers.delete(event.pointerId);
    previousGesture = gesture();
    if (!pointers.size) { dragging = false; viewport.classList.remove('dragging'); }
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);
  viewport.addEventListener('lostpointercapture', endPointer);
  window.addEventListener('blur', () => {
    pointers.clear(); previousGesture = undefined; dragging = false; safariGestureZoom = undefined;
    viewport.classList.remove('dragging');
  });
  viewport.addEventListener('dragstart', event => event.preventDefault());
  viewport.addEventListener('click', event => {
    if (!suppressClick || event.detail === 0) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  viewport.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (['+', '=', '-', '_'].includes(event.key)) {
      event.preventDefault();
      setZoom(zoom * (event.key === '+' || event.key === '=' ? 1.2 : 1 / 1.2));
    } else if (event.key === '0' || event.key === '1') {
      event.preventDefault();
      if (event.key === '0') fitMap(); else actualSize();
    }
  });

  return { centerOn, fit: fitMap, isFit: () => fitted };
}
