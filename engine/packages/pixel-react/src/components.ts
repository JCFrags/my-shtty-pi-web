import {
  cloneElement,
  createElement,
  forwardRef,
  isValidElement,
  type ForwardRefExoticComponent,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
} from "react";

import type { BoxProps, ImageProps, InputProps, TextProps } from "./host-config";

export interface NodeHandle {
  id: number;
  focus(): void;
  blur(): void;
  scrollTo(offset: number, smooth?: boolean): void;
  splice(start: number, end: number, text: string): void;
  /** Splice a widget-anchor sentinel at the caret. The caller picks the mark
   *  id and renders matching Input.Widget children keyed by it. */
  insertMark(mark: number): void;
}

type Host<P> = ForwardRefExoticComponent<P & RefAttributes<NodeHandle>>;

export const Box = "box" as unknown as Host<BoxProps>;
export const Text = "text" as unknown as Host<TextProps>;

// A widget renders inline in the input's text at its mark's offset; the box
// wrapper shrink-wraps whatever the app puts inside.
function Widget({ markId, children }: { markId: number; children?: ReactNode }): ReactElement {
  return createElement("box", { mark: markId }, children);
}

const InputHost = "input" as unknown as Host<InputProps>;

export const Input = Object.assign(
  forwardRef<NodeHandle, InputProps>(function Input(props, ref) {
    return createElement(InputHost, { ...props, ref });
  }),
  { Widget }
);

// The engine stretches a slot root to the image's rect, so tagging the app's
// own element keeps e.g. its background full-bleed; non-host content gets a
// box wrapper and sizes itself.
function slotted(kind: "placeholder" | "error", content: ReactNode): ReactElement | null {
  if (content == null || typeof content === "boolean") return null;
  if (isValidElement(content) && typeof content.type === "string") {
    return cloneElement(content as ReactElement<{ slot?: string }>, {
      key: kind,
      slot: kind,
    });
  }
  return createElement("box", { key: kind, slot: kind }, content);
}

export const Image = forwardRef<NodeHandle, ImageProps>(function Image(props, ref) {
  const { placeholder, error, ...rest } = props;
  return createElement(
    "image",
    { ...rest, ref },
    slotted("placeholder", placeholder),
    slotted("error", error)
  );
});
