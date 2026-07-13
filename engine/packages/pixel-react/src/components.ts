import type { ForwardRefExoticComponent, RefAttributes } from "react";

import type { BoxProps, ImageProps, InputProps, TextProps } from "./host-config";

export interface NodeHandle {
  id: number;
  focus(): void;
  blur(): void;
  scrollTo(offset: number, smooth?: boolean): void;
  /** Replace the byte range [start, end) of an input's text, leaving the caret after the inserted text. */
  splice(start: number, end: number, text: string): void;
}

type Host<P> = ForwardRefExoticComponent<P & RefAttributes<NodeHandle>>;

export const Box = "box" as unknown as Host<BoxProps>;
export const Text = "text" as unknown as Host<TextProps>;
export const Input = "input" as unknown as Host<InputProps>;
export const Image = "image" as unknown as Host<ImageProps>;
