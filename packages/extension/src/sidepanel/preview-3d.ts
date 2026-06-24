/**
 * 3D preview — load the part's EasyEDA OBJ model and render it in a small canvas
 * with three.js (drag-to-orbit + auto-rotate + a soft light).
 *
 * three.js is **dynamically imported** (`await import('three')`) so it lands in
 * a lazy chunk that's only fetched when the 3D tab is first opened — it never
 * bloats the main side-panel bundle. The OBJ itself comes through the relay
 * (`GET /easyeda/model-obj?uuid=…`), which fetches it server-side with the
 * desktop UA + Referer EasyEDA's store expects.
 *
 * Everything is defensive: a missing model3dUrl shows a "no 3D model" note, a
 * fetch/parse/WebGL failure shows an error note — neither ever throws into the
 * card. {@link mount3dPreview} returns a handle whose `dispose()` stops the
 * animation loop, drops listeners, and frees the WebGL context, so re-mounting
 * (tab switches, new parts, PiP moves) doesn't leak.
 */

import { uuidFromModelUrl } from './model3d-url.js';

/** Handle for tearing a mounted 3D preview down. */
export interface Preview3dHandle {
  /** Stop animation, remove listeners, free GPU + DOM resources. */
  dispose(): void;
}

/** A no-op handle (used for the static "no model" / "error" states). */
const NOOP: Preview3dHandle = { dispose() {} };

/** Build a small status block (icon glyph + message) for empty/error states. */
function statusBlock(kind: 'empty' | 'error' | 'loading', message: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `preview-3d-status preview-3d-status--${kind}`;
  if (kind === 'loading') {
    const spinner = document.createElement('span');
    spinner.className = 'preview-3d-spinner';
    spinner.setAttribute('aria-hidden', 'true');
    wrap.appendChild(spinner);
  } else {
    const glyph = document.createElement('span');
    glyph.className = 'preview-3d-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    glyph.textContent = kind === 'error' ? '⚠' : '⌖';
    wrap.appendChild(glyph);
  }
  const text = document.createElement('span');
  text.className = 'preview-3d-msg';
  text.textContent = message;
  wrap.appendChild(text);
  return wrap;
}

/** Trim a trailing slash so `${relayBase}/path` never doubles up. */
function trimTrailingSlash(base: string): string {
  return base.replace(/\/+$/, '');
}

/**
 * Mount a 3D preview into `container`. Clears the container first, then either
 * shows a static state (no model / error) or boots an animated three.js scene.
 *
 * Returns immediately with a handle; the heavy work (import three, fetch+parse
 * OBJ, build the renderer) runs async and swaps the loading state for the canvas
 * (or an error note) when done. If the handle is disposed before that finishes,
 * the async path detects it and tears down anything it created.
 *
 * @param container the element to render into (sized by CSS).
 * @param model3dUrl the converter's `model3dUrl` (carries the EasyEDA uuid), or null.
 * @param relayBase  the deployed relay origin the OBJ is fetched through.
 */
export function mount3dPreview(
  container: HTMLElement,
  model3dUrl: string | null,
  relayBase: string,
): Preview3dHandle {
  container.textContent = '';

  const uuid = uuidFromModelUrl(model3dUrl);
  if (!uuid) {
    container.appendChild(statusBlock('empty', 'No 3D model for this part.'));
    return NOOP;
  }
  if (!relayBase) {
    container.appendChild(statusBlock('error', 'Set a relay URL to load the 3D model.'));
    return NOOP;
  }

  const loading = statusBlock('loading', 'Loading 3D model…');
  container.appendChild(loading);

  let disposed = false;
  let teardown: (() => void) | null = null;

  const fail = (msg: string): void => {
    if (disposed) return;
    container.textContent = '';
    container.appendChild(statusBlock('error', msg));
  };

  const url = `${trimTrailingSlash(relayBase)}/easyeda/model-obj?uuid=${encodeURIComponent(uuid)}`;

  void (async () => {
    let three: typeof import('three');
    let OBJLoaderMod: typeof import('three/examples/jsm/loaders/OBJLoader.js');
    try {
      // Lazy chunk: three core + the OBJ loader, only now.
      [three, OBJLoaderMod] = await Promise.all([
        import('three'),
        import('three/examples/jsm/loaders/OBJLoader.js'),
      ]);
    } catch {
      fail('Could not load the 3D viewer.');
      return;
    }
    if (disposed) return;

    let objText: string;
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      objText = await resp.text();
      if (!/^\s*(v|vn|f|g|o|usemtl)\b/m.test(objText)) {
        throw new Error('not an OBJ');
      }
    } catch {
      fail('3D model unavailable.');
      return;
    }
    if (disposed) return;

    try {
      teardown = buildScene(three, OBJLoaderMod.OBJLoader, container, objText);
    } catch {
      fail('Could not render the 3D model.');
    }
  })();

  return {
    dispose() {
      disposed = true;
      if (teardown) {
        teardown();
        teardown = null;
      }
    },
  };
}

/**
 * EasyEDA inlines its .mtl material library inside the .obj (newmtl/endmtl/Ka/
 * Kd/Ks/…), which three's OBJLoader doesn't understand — it warns once per such
 * line. We override the material anyway (see buildScene), so WHITELIST the OBJ
 * geometry/structure lines and drop everything else. A whitelist (vs chasing each
 * material keyword) silences any non-standard marker — e.g. EasyEDA's `endmtl` —
 * by construction, keeping the console and the extension errors page clean.
 */
const OBJ_GEOM_LINE = /^(vn|vt|vp|v|f|l|p|o|g|s)\b/;
function stripInlinedMtl(objText: string): string {
  return objText
    .split('\n')
    .filter((line) => {
      const t = line.trim();
      return t === '' || t.startsWith('#') || OBJ_GEOM_LINE.test(t);
    })
    .join('\n');
}

/**
 * Build the three.js scene for a parsed OBJ and start the render loop. Returns a
 * teardown fn. Separated out so {@link mount3dPreview} stays about flow/states.
 */
function buildScene(
  THREE: typeof import('three'),
  OBJLoader: typeof import('three/examples/jsm/loaders/OBJLoader.js').OBJLoader,
  container: HTMLElement,
  objText: string,
): () => void {
  const obj = new OBJLoader().parse(stripInlinedMtl(objText));

  // Replace EasyEDA's materials with one calm metallic so it reads on the dark
  // surface regardless of what the OBJ declared (its mtl is inlined/odd).
  const partMat = new THREE.MeshStandardMaterial({
    color: 0x9aa3ad,
    metalness: 0.35,
    roughness: 0.55,
  });
  obj.traverse((child: unknown) => {
    const mesh = child as { isMesh?: boolean; material?: unknown };
    if (mesh.isMesh) mesh.material = partMat;
  });

  // Center the model on the origin and scale it to a unit-ish size so the camera
  // framing below works for any part.
  const box = new THREE.Box3().setFromObject(obj);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  obj.position.sub(center);
  const maxDim = Math.max(size.x, size.y, size.z) || 1;

  const scene = new THREE.Scene();
  // A pivot lets us auto-rotate + drag-orbit by spinning the model group.
  const pivot = new THREE.Group();
  pivot.add(obj);
  // Tilt so we see the top + a side at rest, like a 3D viewer's default.
  pivot.rotation.x = -Math.PI / 2 + 0.5;
  scene.add(pivot);

  // Lights: a soft hemisphere fill + one key directional for form.
  scene.add(new THREE.HemisphereLight(0xffffff, 0x202028, 1.05));
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(1, 1.5, 1.2);
  scene.add(key);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.01, 1000);
  const dist = maxDim * 2.6;
  camera.position.set(0, 0, dist);
  camera.lookAt(0, 0, 0);

  let renderer: import('three').WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch (err) {
    // No WebGL context available (rare, e.g. blocked in PiP) — bubble up so the
    // caller shows the error note.
    obj.traverse((child: unknown) => {
      const mesh = child as { isMesh?: boolean; geometry?: { dispose?: () => void } };
      mesh.geometry?.dispose?.();
    });
    partMat.dispose();
    throw err;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2));

  const canvas = renderer.domElement;
  canvas.className = 'preview-3d-canvas';
  canvas.style.touchAction = 'none';
  container.textContent = '';
  container.appendChild(canvas);

  // --- Size to the container; keep it square-ish and responsive.
  const resize = (): void => {
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight || Math.round(w * 0.7));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  resize();
  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => resize())
      : null;
  ro?.observe(container);

  // --- Drag-to-orbit. Pointer drag spins the pivot; releasing resumes auto-spin.
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let autoRotate = true;

  const onDown = (e: PointerEvent): void => {
    dragging = true;
    autoRotate = false;
    lastX = e.clientX;
    lastY = e.clientY;
    canvas.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent): void => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    pivot.rotation.z += dx * 0.01;
    pivot.rotation.x += dy * 0.01;
  };
  const onUp = (e: PointerEvent): void => {
    dragging = false;
    canvas.releasePointerCapture?.(e.pointerId);
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  // --- Render loop.
  let raf = 0;
  const tick = (): void => {
    if (autoRotate) pivot.rotation.z += 0.006;
    renderer.render(scene, camera);
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(raf);
    ro?.disconnect();
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointercancel', onUp);
    obj.traverse((child: unknown) => {
      const mesh = child as { isMesh?: boolean; geometry?: { dispose?: () => void } };
      mesh.geometry?.dispose?.();
    });
    partMat.dispose();
    renderer.dispose();
    // Best-effort GPU context release.
    renderer.forceContextLoss?.();
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  };
}
