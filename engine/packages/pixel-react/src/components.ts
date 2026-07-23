import {
  cloneElement,
  createElement,
  forwardRef,
  isValidElement,
  useState,
  type ForwardRefExoticComponent,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
} from "react";

import type {
  BoxProps,
  ImageProps,
  InputProps,
  MarkedTextProps,
  MarkRef,
  PathProps,
  TextProps,
} from "./reconciler-config";

export interface NodeHandle {
  id: number;
  focus(): void;
  blur(): void;
  scrollTo(offset: number, smooth?: boolean): void;
  scrollIntoView(smooth?: boolean): void;
  splice(start: number, end: number, text: string): void;
  selectAll(): void;
  addMark(mark: number, offset?: number): void;
  removeMark(mark: number): void;
}

type Host<P> = ForwardRefExoticComponent<P & RefAttributes<NodeHandle>>;

export const Box = "box" as unknown as Host<BoxProps>;
export const Text = "text" as unknown as Host<TextProps>;
export const Path = "shape-path" as unknown as Host<PathProps>;

function markWidgets(
  marks: readonly MarkRef[],
  renderMark: ((id: number) => ReactNode) | undefined
): ReactNode {
  if (!renderMark) return null;
  return marks.map((mark) =>
    createElement("box", { key: mark.id, mark: mark.id }, renderMark(mark.id))
  );
}

const InputHost = "input" as unknown as Host<InputProps>;

/**
 * okay maybe this can get interesting
 * 
 * how does the surface for the box from the component, out from react and gives us that data
 * 
 * then where do we interpret that i suppose serialized representation of the surface
 * 
 * what does it even mean to create a surface? thats unclear to me. who instructs who to create a <tab>
 * 
 * what even is our representation of a tab
 * 
 * lots of uknown unknowns, we need to trace
 * 
 * where do i want to start
 * 
 * it would be nice if i could jump to where the data for the surface goes to for the box
 * 
 * which has to be defined somewhere in the reconciler config kashira?
 * 
 * like it probably is a generic update event and we create some node on the rust backend
 */
export const Input = forwardRef<NodeHandle, InputProps>(function Input(props, ref) {
  const { renderMark, onChange, ...rest } = props;
  const [marks, setMarks] = useState<MarkRef[]>(props.defaultMarks ?? []);
  return createElement(
    InputHost,
    {
      ...rest,
      ref,
      onChange: (text, change) => {
        setMarks(change.marks);
        onChange?.(text, change)
      },
    },
    markWidgets(marks, renderMark)
  );
});

const MarkedTextHost = "marked-text" as unknown as Host<MarkedTextProps>;

export const MarkedText = forwardRef<NodeHandle, MarkedTextProps>(function MarkedText(
  props,
  ref
) {
  const { renderMark, ...rest } = props;
  return createElement(
    MarkedTextHost,
    { ...rest, ref },
    markWidgets(props.marks, renderMark)
  );
});

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
