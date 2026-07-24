/**
 * Low-level primitives for skeuomorphic on-screen keyboards.
 *
 * A keyboard scene is a fixed design-coordinate canvas which scales as one
 * object with the emulator display. It deliberately knows nothing about rows,
 * equal-sized keys, legend slots, keyboard matrices, or input modes. Machine UI
 * code places arbitrary visual elements and interactive key regions on it.
 */

import type { JSX, ParentProps } from 'solid-js';

export interface SceneBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface KeyboardSceneProps extends ParentProps {
  /** Canvas size in this keyboard's design coordinates. */
  width: number;
  height: number;
  /**
   * Size of one design coordinate at the reference 3× display scale.
   * Most keyboards use 1; faces traced in another native pitch can override it.
   */
  unit?: number;
  class?: string;
  classList?: Record<string, boolean | undefined>;
  label: string;
}

interface SceneElementProps extends ParentProps {
  box: SceneBox;
  class?: string;
  ariaHidden?: boolean;
}

interface SceneKeyProps extends ParentProps {
  box: SceneBox;
  class?: string;
  pressed: boolean;
  label: string;
  /**
   * Optional CSS clip path for a non-rectangular hit region. Browsers apply the
   * clip to hit-testing as well as painting, so an L-shaped key cannot steal
   * pointer events from the neighbouring cap inside its bounding box.
   */
  hitClip?: string;
  onDown(): void;
  onUp(): void;
}

function boxStyle(box: SceneBox): JSX.CSSProperties {
  const px = (n: number) => `calc(var(--keyboard-scene-px) * ${n})`;
  return {
    position: 'absolute',
    left: px(box.x),
    top: px(box.y),
    width: px(box.width),
    height: px(box.height),
  };
}

export function KeyboardScene(props: KeyboardSceneProps) {
  const naturalPx = () => `calc(1px * var(--display-scale, 3) / 3 * ${props.unit ?? 1})`;
  const fittedPx = () =>
    `min(${naturalPx()}, calc(100cqw / ${props.width}))`;
  return (
    <div class="keyboard-scene-frame">
      <div
        class={`keyboard-scene${props.class ? ` ${props.class}` : ''}`}
        classList={props.classList}
        style={{
          '--keyboard-scene-px': fittedPx(),
          '--keyboard-scene-width': `${props.width}`,
          '--keyboard-scene-height': `${props.height}`,
        }}
        role="group"
        aria-label={props.label}
      >
        {props.children}
      </div>
    </div>
  );
}

/** A freely positioned, non-interactive item such as a case legend or badge. */
export function SceneElement(props: SceneElementProps) {
  return (
    <div
      class={`keyboard-scene__item${props.class ? ` ${props.class}` : ''}`}
      style={boxStyle(props.box)}
      aria-hidden={props.ariaHidden ?? true}
    >
      {props.children}
    </div>
  );
}

/** A freely positioned interactive key. Visual content is supplied by the face. */
export function SceneKey(props: SceneKeyProps) {
  const style = () => ({
    ...boxStyle(props.box),
    ...(props.hitClip ? { 'clip-path': props.hitClip } : {}),
  });
  return (
    <div
      class={`keyboard-scene__key${props.class ? ` ${props.class}` : ''}`}
      classList={{ pressed: props.pressed }}
      style={style()}
      role="button"
      aria-pressed={props.pressed}
      aria-label={props.label}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        props.onDown();
      }}
      onPointerUp={props.onUp}
      onPointerCancel={props.onUp}
    >
      {props.children}
    </div>
  );
}
